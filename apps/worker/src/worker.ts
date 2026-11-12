import { Worker, Job } from 'bullmq';
import { prisma } from './prisma.service';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import ffmpeg from 'fluent-ffmpeg';
import { execFile } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as dotenv from 'dotenv';
import Redis from 'ioredis';

dotenv.config();

// ---------- Binarios de FFmpeg ----------
// Usa los binarios empaquetados (ffmpeg-static / ffprobe-static) cuando estén
// disponibles; si no, cae al ffmpeg/ffprobe del PATH (p. ej. la imagen Docker,
// donde se instalan con `apk add ffmpeg`).
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ffmpegPath = require('ffmpeg-static');
  if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
} catch {
  /* sin ffmpeg-static: usa el binario del PATH */
}
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ffprobeStatic = require('ffprobe-static');
  if (ffprobeStatic?.path) ffmpeg.setFfprobePath(ffprobeStatic.path);
} catch {
  /* sin ffprobe-static: usa el binario del PATH */
}

// Directorio temporal multiplataforma (en Windows es %TEMP%, no /tmp)
const TMP_DIR = os.tmpdir();

// Parámetros de generación de clips
const CLIP_DURATION = 15; // segundos por clip
const MAX_CLIPS = 10; // tope de clips por video (evita cientos de encodes)
const MIN_HIGHLIGHT_SPACING = CLIP_DURATION; // separación mínima entre inicios
/** Umbral de LUFS bajo el cual un segundo se considera "habla" (comentario / charla). */
const SPEECH_THRESHOLD_LUFS = -40;

// ---------- Configuración S3 ----------
const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  },
  forcePathStyle: true,
  // AWS SDK v3 reciente valida checksums CRC32 por defecto y LocalStack 2.3
  // responde con un `x-amz-checksum-crc32` inválido -> "InvalidRequest".
  // Con WHEN_REQUIRED solo se calcula/valida cuando el backend lo exige.
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

// ---------- Redis ----------
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

/** Parsea `redis://host:port` a las opciones de conexión de BullMQ. */
function parseRedisUrl(url: string): { host: string; port: number } {
  const raw = url.replace(/^rediss?:\/\//, '');
  const [host, port] = raw.split(':');
  return { host: host || 'localhost', port: Number(port) || 6379 };
}

// Cliente para publicar notificaciones de estado (canal "video-status")
const redis = new Redis(REDIS_URL);

/** Publica un mensaje de estado en el canal Redis "video-status" */
async function publishStatus(payload: object) {
  await redis.publish('video-status', JSON.stringify(payload));
}

/** Obtiene la duración total del video (en segundos, sin redondear) */
function getVideoDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg(filePath).ffprobe((err: any, data: any) => {
      if (err) return reject(err);
      const duration = Number(data?.format?.duration);
      resolve(Number.isFinite(duration) ? duration : 0);
    });
  });
}

interface LoudnessSample {
  time: number;
  loudness: number;
}

/** Instante candidato para iniciar un clip, con su puntuación 0..1. */
interface Highlight {
  start: number;
  score: number;
}

/**
 * Analiza la sonoridad del audio a lo largo del tiempo usando el filtro
 * `ebur128` de ffmpeg. Devuelve muestras {tiempo, LUFS} que luego se usan para
 * localizar los momentos con mayor impacto sonoro.
 *
 * Nota: la implementación anterior con `volumedetect` NO aportaba timestamps
 * (solo un máximo global), por lo que todos los clips acababan en el segundo 0.
 */
function analyzeLoudness(filePath: string): Promise<LoudnessSample[]> {
  return new Promise((resolve, reject) => {
    const samples: LoudnessSample[] = [];
    ffmpeg(filePath)
      .noVideo()
      .audioFilters('ebur128')
      .outputFormat('null')
      .output('-')
      .on('stderr', (line: string) => {
        // Ejemplo (ffmpeg 8):
        // [Parsed_ebur128_0 @ ...] t: 0.4  TARGET:-23 LUFS  M:-48.0 S:-120.7  I: -48.0 LUFS  LRA: 0.0 LU
        // El `.*?` es necesario porque algunas versiones insertan "TARGET:... LUFS"
        // entre `t:` y `M:`.
        const match = line.match(/t:\s*([\d.]+).*?M:\s*(-?[\d.]+)/);
        if (!match) return;
        const time = parseFloat(match[1]);
        const loudness = parseFloat(match[2]);
        if (Number.isFinite(time) && Number.isFinite(loudness)) {
          samples.push({ time, loudness });
        }
      })
      .on('end', () => resolve(samples))
      .on('error', (err) => reject(err))
      .run();
  });
}

/**
 * Detecta los cambios de escena (cortes) del video usando el filtro `select`
 * con el score de escena + `showinfo`. Cada corte es un buen indicador de
 * "acción" / edición dinámica (deportes, gaming, vlogs con mucho corte).
 *
 * Devuelve los tiempos (en segundos) donde se producen los cortes.
 */
function analyzeScenes(filePath: string): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const times = new Set<number>();
    ffmpeg(filePath)
      .videoFilters("select='gt(scene,0.3)',showinfo")
      .outputOptions('-an', '-f', 'null')
      .output('-')
      .on('stderr', (line: string) => {
        // [Parsed_showinfo_1 @ ...] n:1 pts:... pts_time:12.34 ...
        const match = line.match(/pts_time:([\d.]+)/);
        if (!match) return;
        const t = parseFloat(match[1]);
        if (Number.isFinite(t)) times.add(Math.round(t * 10) / 10);
      })
      .on('end', () => resolve([...times]))
      .on('error', (err) => reject(err))
      .run();
  });
}

/**
 * Elige los instantes de inicio de los clips combinando tres señales:
 *
 *  - **Audio (50 %)**: sonoridad media por ventana (gritos, risas, público,
 *    momentos eufóricos). Se obtiene con `ebur128`.
 *  - **Habla (30 %)**: fracción de la ventana que supera el umbral
 *    `SPEECH_THRESHOLD_LUFS` (momentos de comentario / charla activa).
 *  - **Acción (20 %)**: densidad de cortes de escena por ventana (montaje
 *    dinámico / momentos de acción).
 *
 * Devuelve hasta `MAX_CLIPS` highlights ordenados por tiempo, con su score
 * 0..1 (que se persiste en `Clip.score` como 0..100).
 *
 * IMPORTANTE: esto es una heurística audiovisual. NO entiende el contenido
 * hablado (sentimientos reales, "impacto psicológico") ni el contexto semántico;
 * para eso haría falta un modelo de IA (transcripción + análisis semántico).
 * Ver AI_HANDOFF.md.
 */
function pickHighlights(
  samples: LoudnessSample[],
  sceneTimes: number[],
  duration: number,
): Highlight[] {
  if (duration <= 0) return [{ start: 0, score: 0 }];

  const maxStart = Math.max(0, duration - CLIP_DURATION);

  // 1. Sonoridad máxima por segundo, normalizada 0..1
  //    Piso EBU R128: por debajo de -70 LUFS se considera silencio.
  const loudBySecond = new Map<number, number>();
  let minL = Infinity;
  let maxL = -Infinity;
  for (const s of samples) {
    const sec = Math.floor(s.time);
    const loud = Math.max(s.loudness, -70);
    loudBySecond.set(sec, Math.max(loudBySecond.get(sec) ?? -Infinity, loud));
    minL = Math.min(minL, loud);
    maxL = Math.max(maxL, loud);
  }
  const range = maxL - minL || 1;

  // 2. Cortes de escena por segundo
  const cutsBySecond = new Map<number, number>();
  for (const t of sceneTimes) {
    const sec = Math.floor(t);
    cutsBySecond.set(sec, (cutsBySecond.get(sec) ?? 0) + 1);
  }

  // 3. Puntuar cada ventana candidata [start, start + CLIP_DURATION)
  const candidates: Highlight[] = [];
  for (let start = 0; start <= maxStart; start++) {
    let loudSum = 0;
    let loudCount = 0;
    let cuts = 0;
    let speechSec = 0;
    for (let sec = start; sec < start + CLIP_DURATION; sec++) {
      const l = loudBySecond.get(sec);
      if (l !== undefined) {
        loudSum += (l - minL) / range;
        loudCount++;
        if (l >= SPEECH_THRESHOLD_LUFS) speechSec++;
      }
      cuts += cutsBySecond.get(sec) ?? 0;
    }
    const audioScore = loudCount ? loudSum / loudCount : 0;
    const speechScore = loudCount ? speechSec / loudCount : 0;
    // 6 o más cortes en 15 s => acción máxima
    const actionScore = Math.min(cuts / 6, 1);
    candidates.push({
      start,
      score: audioScore * 0.5 + speechScore * 0.3 + actionScore * 0.2,
    });
  }

  const best = candidates.reduce((m, c) => Math.max(m, c.score), 0);

  // 4. Sin señal útil (silencio + sin cortes): intervalos regulares cada 60 s
  if (best < 0.05) {
    const regular: Highlight[] = [];
    for (let t = 0; t <= maxStart && regular.length < MAX_CLIPS; t += 60) {
      regular.push({ start: t, score: 0.5 });
    }
    if (regular.length === 0) regular.push({ start: 0, score: 0.5 });
    return regular;
  }

  // 5. Tomar los mejores respetando separación mínima y tope
  candidates.sort((a, b) => b.score - a.score);
  const chosen: Highlight[] = [];
  for (const c of candidates) {
    if (chosen.length >= MAX_CLIPS) break;
    if (chosen.some((x) => Math.abs(x.start - c.start) < MIN_HIGHLIGHT_SPACING)) {
      continue;
    }
    chosen.push(c);
  }

  return chosen.sort((a, b) => a.start - b.start);
}

/**
 * Descarga el video desde una URL de origen.
 *
 * - Si la URL apunta a una plataforma de video conocida (YouTube, TikTok,
 *   Instagram, Twitter/X, Vimeo, OK.ru...), se usa `yt-dlp` (binario instalado
 *   en la imagen Docker) para resolver el stream y descargarlo.
 * - Si es una URL directa a un archivo (MP4/HLS...), se usa ffmpeg HTTP.
 */
async function downloadSource(
  sourceUrl: string,
  outPath: string,
): Promise<void> {
  const VIDEO_PLATFORMS =
    /youtu\.be|youtube\.com|youtu\.nic|tiktok\.com|instagram\.com|twitter\.com|x\.com|vimeo\.com|ok\.ru/i;
  if (VIDEO_PLATFORMS.test(sourceUrl)) {
    await new Promise<void>((resolve, reject) => {
      execFile(
        'yt-dlp',
        [
          '-f',
          'bv*+ba/b',
          '--merge-output-format',
          'mp4',
          '--no-playlist',
          '-o',
          outPath,
          sourceUrl,
        ],
        { maxBuffer: 1024 * 1024 * 100 },
        (err, _stdout, _stderr) => {
          if (err) reject(err);
          else resolve();
        },
      );
    });
  } else {
    await new Promise<void>((resolve, reject) => {
      ffmpeg(sourceUrl)
        .output(outPath)
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .run();
    });
  }
}

/** Genera un clip a partir del video original */
function generateClip(
  sourcePath: string,
  start: number,
  clipDuration: number,
  format: 'VERTICAL' | 'HORIZONTAL',
  outPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const ff = ffmpeg(sourcePath)
      .setStartTime(start)
      .setDuration(clipDuration)
      .outputOptions(
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-c:a', 'aac',
        '-pix_fmt', 'yuv420p', // máxima compatibilidad con reproductores
        '-movflags', '+faststart',
      );

    if (format === 'VERTICAL') {
      // Reencuadre 9:16: escala cubriendo 1080x1920 y recorta al centro.
      // (El recorte anterior `crop=ih*9/16:ih` producía un ancho impar y x264
      // fallaba con "width not divisible by 2".)
      ff.videoFilters([
        'scale=1080:1920:force_original_aspect_ratio=increase',
        'crop=1080:1920',
      ]);
    }
    // HORIZONTAL deja el video tal cual

    ff.output(outPath)
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .run();
  });
}

// -------------------------------------------------
// Worker que consume la cola "video-processing"
// -------------------------------------------------
const videoWorker = new Worker(
  'video-processing',
  async (job: Job) => {
    const { videoId, s3Key, sourceUrl, keepOriginal } = job.data as {
      videoId: string;
      s3Key: string;
      sourceUrl?: string;
      keepOriginal?: boolean;
    };
    console.log(`[Worker] Procesando video ${videoId}`);

    // 1️⃣ Marcar como PROCESSING y notificar
    await prisma.video.update({
      where: { id: videoId },
      data: { status: 'PROCESSING' },
    });
    await publishStatus({ id: videoId, status: 'PROCESSING' });

    // Nombre temporal: para URLs de origen se usa un sufijo simple (el basename
    // de una URL puede traer caracteres especiales como `?`).
    const tmpVideo = path.join(
      TMP_DIR,
      `${videoId}-${sourceUrl ? 'source.mp4' : path.basename(s3Key)}`,
    );

    try {
      // 2️⃣ Descargar video al directorio temporal
      //     - Si hay `sourceUrl` (link directo al video), se descarga por HTTP.
      //     - Si no, se descarga desde S3.
      if (sourceUrl) {
        // URL de origen: yt-dlp para plataformas (YouTube/TikTok/...), ffmpeg HTTP para URLs directas
        await downloadSource(sourceUrl, tmpVideo);
      } else {
        const getCmd = new GetObjectCommand({
          Bucket: process.env.S3_BUCKET,
          Key: s3Key,
        });
        const response = await s3.send(getCmd);
        await new Promise<void>((resolve, reject) => {
          const writable = fs.createWriteStream(tmpVideo);
          (response.Body as any)
            .pipe(writable)
            .on('finish', () => resolve())
            .on('error', reject);
        });
      }

      // 3️⃣ Conservar el video COMPLETO en S3 (opcional, para poder descargarlo)
      if (keepOriginal) {
        try {
          const originalKey = `originals/${videoId}/original.mp4`;
          const putOriginal = new PutObjectCommand({
            Bucket: process.env.S3_BUCKET,
            Key: originalKey,
            Body: fs.createReadStream(tmpVideo),
            ContentType: 'video/mp4',
          });
          await s3.send(putOriginal);
          await prisma.video.update({
            where: { id: videoId },
            data: { originalKey, sourceUrl: sourceUrl ?? null },
          });
          console.log(
            `[Worker] ${videoId}: video completo guardado en S3 (${originalKey})`,
          );
          await publishStatus({
            id: videoId,
            status: 'PROCESSING',
            phase: 'ORIGINAL_SAVED',
          });
        } catch (err) {
          // No es crítico: el resto del pipeline (clips) debe continuar
          console.warn(
            `[Worker] No se pudo guardar el video completo de ${videoId}:`,
            err,
          );
        }
      }

      // 4️⃣ Duración del video (redondeada: el campo Prisma `duration` es Int)
      const rawDuration = await getVideoDuration(tmpVideo);
      const duration = Math.max(0, Math.round(rawDuration));
      if (!duration) {
        throw new Error('No se pudo determinar la duración del video');
      }
      await prisma.video.update({
        where: { id: videoId },
        data: { duration },
      });
      // Se mantiene un status válido (PROCESSING) y la fase va aparte para que
      // el frontend no reciba un estado inexistente.
      await publishStatus({ id: videoId, status: 'PROCESSING', phase: 'DURATION', duration });

      // 5️⃣ Detección de momentos destacados (audio + acción)
      let highlights: Highlight[];
      try {
        const [samples, sceneTimes] = await Promise.all([
          analyzeLoudness(tmpVideo).catch((err) => {
            console.warn(`[Worker] Análisis de audio falló para ${videoId}:`, err);
            return [] as LoudnessSample[];
          }),
          analyzeScenes(tmpVideo).catch((err) => {
            console.warn(`[Worker] Análisis de escenas falló para ${videoId}:`, err);
            return [] as number[];
          }),
        ]);
        highlights = pickHighlights(samples, sceneTimes, duration);
      } catch (err) {
        console.warn(
          `[Worker] Análisis falló para ${videoId}, uso intervalos fijos:`,
          err,
        );
        highlights = pickHighlights([], [], duration);
      }

      console.log(
        `[Worker] ${videoId}: ${highlights.length} highlights -> ` +
          highlights
            .map((h) => `${h.start}s(score ${Math.round(h.score * 100)})`)
            .join(', '),
      );

      // 6️⃣ Generar clips (15 s cada uno, ambos formatos)
      const createdClips: any[] = [];
      for (const highlight of highlights) {
        const startSec = highlight.start;
        const clipDur = Math.min(CLIP_DURATION, duration - startSec);
        if (clipDur <= 0) continue;

        for (const fmt of ['VERTICAL', 'HORIZONTAL'] as const) {
          const clipFile = path.join(
            TMP_DIR,
            `${videoId}-clip-${Math.floor(startSec)}-${fmt}.mp4`,
          );
          try {
            await generateClip(tmpVideo, startSec, clipDur, fmt, clipFile);

            // Subir clip a S3
            const clipKey = `clips/${videoId}/${path.basename(clipFile)}`;
            const putCmd = new PutObjectCommand({
              Bucket: process.env.S3_BUCKET,
              Key: clipKey,
              Body: fs.createReadStream(clipFile),
              ContentType: 'video/mp4',
            });
            await s3.send(putCmd);

            const publicEndpoint =
              process.env.S3_PUBLIC_ENDPOINT ||
              process.env.S3_ENDPOINT?.replace('localstack:4566', 'localhost:4566') ||
              'http://localhost:4566';
            const clipUrl = `${publicEndpoint}/${process.env.S3_BUCKET}/${clipKey}`;
            const clipRecord = await prisma.clip.create({
              data: {
                videoId,
                s3Key: clipKey,
                clipUrl,
                startTime: Math.floor(startSec),
                endTime: Math.floor(startSec + clipDur),
                score: Math.round(highlight.score * 100), // 0..100
                format: fmt,
              },
            });
            createdClips.push(clipRecord);
          } finally {
            // Limpiar archivo temporal del clip (exista o no)
            if (fs.existsSync(clipFile)) fs.unlinkSync(clipFile);
          }
        }
      }

      // 7️⃣ Marcar video como COMPLETED y notificar número de clips
      await prisma.video.update({
        where: { id: videoId },
        data: { status: 'COMPLETED' },
      });
      await publishStatus({
        id: videoId,
        status: 'COMPLETED',
        clipsCreated: createdClips.length,
      });
      console.log(
        `[Worker] Video ${videoId} listo, ${createdClips.length} clips creados`,
      );
    } finally {
      // 8️⃣ Limpiar video original (también si hubo error)
      if (fs.existsSync(tmpVideo)) fs.unlinkSync(tmpVideo);
    }
  },
  {
    connection: parseRedisUrl(REDIS_URL),
  },
);

videoWorker.on('failed', async (job, err) => {
  const videoId = job?.data?.videoId;
  console.error(`[Worker] Job ${job?.id} falló:`, err);

  // Marcar el video como FAILED en la base de datos (antes solo se notificaba
  // por Redis, por lo que el video quedaba "PROCESSING" para siempre).
  if (videoId) {
    try {
      await prisma.video.update({
        where: { id: videoId },
        data: { status: 'FAILED' },
      });
    } catch (dbErr) {
      console.error(`[Worker] No se pudo marcar ${videoId} como FAILED:`, dbErr);
    }
  }

  await publishStatus({
    id: videoId,
    status: 'FAILED',
    error: err.message,
  });
});
