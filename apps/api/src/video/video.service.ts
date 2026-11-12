import {
  Injectable,
  NotFoundException,
  Inject,
  Logger,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { S3Client, DeleteObjectsCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { prisma } from '../prisma.service';
import { CreateVideoDto } from './dto/create-video.dto';
import { S3_CLIENT } from '../s3/s3.module';

@Injectable()
export class VideoService {
  private readonly logger = new Logger(VideoService.name);

  constructor(
    @InjectQueue('video-processing') private readonly videoQueue: Queue,
    @Inject(S3_CLIENT) private readonly s3Client: S3Client,
  ) {}

  async create(dto: CreateVideoDto) {
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

    const video = await prisma.video.create({
      data: {
        title: dto.title,
        s3Key: dto.sourceUrl || dto.s3Key,
        duration: dto.duration || 0,
        status: 'PENDING',
        sourceUrl: dto.sourceUrl || null,
        userId,
      },
    });

    // Enviar trabajo a la cola BullMQ
    await this.videoQueue.add('process', {
      videoId: video.id,
      s3Key: video.s3Key,
      sourceUrl: dto.sourceUrl,
      // Conservar el video completo en S3 para poder descargarlo
      keepOriginal: dto.keepOriginal === true,
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
    let url = await getSignedUrl(this.s3Client, command, { expiresIn: 900 });

    // El host interno de Docker no es accesible desde el navegador del usuario
    if (url.includes('localstack:4566')) {
      url = url.replace('localstack:4566', 'localhost:4566');
    }

    const safeTitle = (video.title || 'video').replace(/[^\w.\-]+/g, '_');
    const filename = `${safeTitle}.mp4`;

    return { id, url, filename, expiresIn: 900 };
  }
}
