import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Inject,
  Logger,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { S3Client, DeleteObjectsCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { prisma } from '../prisma.service';
import {
  CreateVideoDto,
  VideoProcessingContext,
  normalizeLiveDurationMinutes,
} from './dto/create-video.dto';
import { S3_CLIENT } from '../s3/s3.module';
import { rewritePresignedS3Url } from '../s3/s3.config';
import { RedisService } from '../redis.service';
import {
  assertPublicUrl,
  sanitizeStorageKey,
  UnsafeUrlError,
} from '../common/ssrf-guard';

@Injectable()
export class VideoService {
  private readonly logger = new Logger(VideoService.name);

  constructor(
    @InjectQueue('video-processing') private readonly videoQueue: Queue,
    @Inject(S3_CLIENT) private readonly s3Client: S3Client,
    private readonly redisService: RedisService,
  ) {}

  async create(dto: CreateVideoDto, context?: VideoProcessingContext) {
    const isLiveCapture = dto.isLiveCapture === true;

    let validatedSourceUrl: string | null = null;
    if (dto.sourceUrl) {
      try {
        validatedSourceUrl = await assertPublicUrl(dto.sourceUrl);
      } catch (err) {
        if (err instanceof UnsafeUrlError) {
          throw new BadRequestException(err.message);
        }
        throw err;
      }
    }

    if (isLiveCapture && !validatedSourceUrl) {
      throw new BadRequestException(
        'El modo transmisión en vivo requiere un enlace público válido (YouTube Live, Twitch, Kick o TikTok Live).',
      );
    }

    // Regla de concurrencia: solo 1 captura en vivo activa a la vez
    if (isLiveCapture) {
      const activeLive = await prisma.video.findFirst({
        where: {
          isLiveCapture: true,
          liveStatus: 'RECORDING',
        },
        select: { id: true, title: true },
      });
      if (activeLive) {
        throw new ConflictException(
          'Ya existe una transmisión en vivo capturándose. Solo se permite capturar 1 directo a la vez hasta que finalice o se detenga.',
        );
      }
    }

    // Asegurar usuario por defecto si no se pasa userId
    let userId = dto.userId;
    if (!userId) {
      let defaultUser = await prisma.user.findFirst();
      if (!defaultUser) {
        defaultUser = await prisma.user.create({
          data: {
            email: 'admin@streamlike.local',
            roles: ['ADMIN'],
          },
        });
      }
      userId = defaultUser.id;
    }

    let safeKey = validatedSourceUrl || dto.s3Key;
    if (!validatedSourceUrl) {
      try {
        safeKey = sanitizeStorageKey(dto.s3Key);
      } catch (err) {
        if (err instanceof UnsafeUrlError) {
          throw new BadRequestException(err.message);
        }
        throw err;
      }
    }

    const liveDurationMinutes = isLiveCapture
      ? normalizeLiveDurationMinutes(dto.liveDurationMinutes)
      : null;
    const liveStatus = isLiveCapture ? 'RECORDING' : null;

    let video;
    if (isLiveCapture) {
      try {
        video = await prisma.$transaction(
          async (tx) => {
            const activeLive = await tx.video.findFirst({
              where: {
                isLiveCapture: true,
                liveStatus: 'RECORDING',
              },
              select: { id: true },
            });
            if (activeLive) {
              throw new ConflictException(
                'Ya existe una transmisión en vivo capturándose. Solo se permite capturar 1 directo a la vez hasta que finalice o se detenga.',
              );
            }
            return tx.video.create({
              data: {
                title: dto.title,
                s3Key: safeKey,
                duration: dto.duration || 0,
                status: 'PENDING',
                sourceUrl: validatedSourceUrl,
                isLiveCapture,
                liveDurationMinutes,
                liveStatus,
                userId,
              },
            });
          },
          { isolationLevel: 'Serializable' },
        );
      } catch (err: any) {
        if (err instanceof ConflictException) throw err;
        if (err?.code === 'P2034') {
          throw new ConflictException(
            'Ya existe una transmisión en vivo capturándose. Solo se permite capturar 1 directo a la vez hasta que finalice o se detenga.',
          );
        }
        throw err;
      }
    } else {
      video = await prisma.video.create({
        data: {
          title: dto.title,
          s3Key: safeKey,
          duration: dto.duration || 0,
          status: 'PENDING',
          sourceUrl: validatedSourceUrl,
          isLiveCapture,
          liveDurationMinutes,
          liveStatus,
          userId,
        },
      });
    }

    // Enviar trabajo a la cola BullMQ con parámetros inspirados en OpenShorts
    await this.videoQueue.add('process', {
      videoId: video.id,
      s3Key: video.s3Key,
      sourceUrl: validatedSourceUrl ?? undefined,
      // Conservar el video completo en S3 para poder descargarlo
      keepOriginal: dto.keepOriginal === true,
      clipDuration: dto.clipDuration,
      layoutMode: dto.layoutMode,
      autoReframe: dto.autoReframe !== false,
      topicHint: dto.topicHint,
      isLiveCapture,
      ...(liveDurationMinutes !== null ? { liveDurationMinutes } : {}),
      // Clave Gemini efímera por petición (nunca se guarda en PostgreSQL)
      ...(context?.geminiApiKey ? { geminiApiKey: context.geminiApiKey } : {}),
    });

    return video;
  }

  async findAll() {
    return prisma.video.findMany({
      include: {
        clips: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async findOne(id: string) {
    const video = await prisma.video.findUnique({
      where: { id },
      include: {
        clips: true,
      },
    });
    if (!video) {
      throw new NotFoundException(`Video with ID ${id} not found`);
    }
    return video;
  }

  /**
   * Elimina un video por completo:
   *  1. Borra de S3 el archivo original y todos sus clips.
   *  2. Borra de la base de datos los jobs, los clips y el video.
   *
   * El borrado en S3 es "best effort": si falla, se registra un aviso pero se
   * continúa con el borrado en base de datos para no dejar registros huérfanos.
   */
  async remove(id: string) {
    const video = await prisma.video.findUnique({
      where: { id },
      include: { clips: true },
    });
    if (!video) {
      throw new NotFoundException(`Video with ID ${id} not found`);
    }

    const bucket = process.env.S3_BUCKET;
    const keys = [
      video.s3Key,
      video.originalKey,
      ...video.clips.map((c) => c.s3Key),
    ].filter((k): k is string => Boolean(k));

    if (bucket && keys.length > 0) {
      try {
        await this.s3Client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: keys.map((Key) => ({ Key })) },
          }),
        );
      } catch (err) {
        this.logger.warn(
          `No se pudieron borrar todos los objetos S3 de ${id}: ${(err as Error).message}`,
        );
      }
    }

    // Borrar en orden por las claves foráneas (JobQueue y Clip -> Video)
    await prisma.jobQueue.deleteMany({ where: { videoId: id } });
    await prisma.clip.deleteMany({ where: { videoId: id } });
    await prisma.video.delete({ where: { id } });

    this.logger.log(`Video ${id} eliminado (${keys.length} objetos S3)`);
    return { id, deleted: true, objectsDeleted: keys.length };
  }

  /**
   * Devuelve una URL prefirmada para descargar el video COMPLETO.
   *
   * El video completo se guarda en S3 (`originalKey`) cuando el worker procesa
   * un enlace con la opción "guardar video completo" activa.
   */
  async getDownloadUrl(id: string) {
    const video = await prisma.video.findUnique({ where: { id } });
    if (!video) {
      throw new NotFoundException(`Video with ID ${id} not found`);
    }
    if (!video.originalKey) {
      throw new NotFoundException(
        'Este video no tiene copia completa guardada. ' +
          'Procesa de nuevo el enlace activando "Guardar video completo".',
      );
    }

    const bucket = process.env.S3_BUCKET;
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: video.originalKey,
    });
    const url = rewritePresignedS3Url(
      await getSignedUrl(this.s3Client, command, { expiresIn: 900 }),
    );

    const safeTitle = (video.title || 'video').replace(/[^\w.\-]+/g, '_');
    const filename = `${safeTitle}.mp4`;

    return { id, url, filename, expiresIn: 900 };
  }

  /**
   * Detiene una captura en vivo activa emitiendo la señal Pub/Sub `live-stop:${id}`
   * para que el worker finalice limpiamente el archivo MP4 y arranque Gemini + clips.
   */
  async stopLive(id: string) {
    if (!id || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) {
      throw new BadRequestException('ID de video inválido.');
    }

    const video = await prisma.video.findUnique({ where: { id } });
    if (!video) {
      throw new NotFoundException(`Video with ID ${id} not found`);
    }
    if (!video.isLiveCapture) {
      throw new BadRequestException('Este video no es una captura en vivo.');
    }
    if (video.liveStatus === 'FINISHED') {
      throw new BadRequestException('La captura en vivo ya finalizó.');
    }

    const updated = await prisma.video.update({
      where: { id },
      data: { liveStatus: 'STOPPED' },
    });

    const redisClient = this.redisService.getClient();
    await Promise.all([
      redisClient.publish(
        `live-stop:${id}`,
        JSON.stringify({
          videoId: id,
          action: 'STOP',
          requestedAt: new Date().toISOString(),
        }),
      ),
      redisClient.publish(
        'video-status',
        JSON.stringify({
          id,
          status: updated.status,
          phase: 'LIVE_STOPPING',
          liveStatus: 'STOPPED',
        }),
      ),
    ]);

    this.logger.log(`Señal live-stop:${id} enviada por el usuario`);
    return {
      id: updated.id,
      isLiveCapture: updated.isLiveCapture,
      liveStatus: updated.liveStatus,
    };
  }
}
