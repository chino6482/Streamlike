import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Job, Worker } from 'bullmq';
import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as dotenv from 'dotenv';
import ffmpeg from 'fluent-ffmpeg';
import * as fs from 'fs';
import Redis from 'ioredis';
import * as os from 'os';
import * as path from 'path';
import { analyzeVideoWithGemini, GEMINI_MODEL, resolveGeminiApiKey } from './gemini-analyzer';
import {
  formatLiveProgressPayload,
  normalizeLiveDurationMinutes,
  recordLiveStream,
} from './live-recorder';
import { prisma } from './prisma.service';
import { buildPublicObjectUrl, resolveWorkerS3Config } from './s3-config';
import { escapeFfmpegFilterPath, writeAssSubtitleFile } from './subtitle-generator';
import { buildDynamicCropFilter } from './video-processor';

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

// Parámetros de generación de clips (adaptativos al estilo OpenShorts)
const DEFAULT_CLIP_DURATION = 15; // segundos por clip por defecto
const MAX_CLIPS = 10; // tope de clips por video (evita cientos de encodes)
/** Umbral de LUFS bajo el cual un segundo se considera "habla" (comentario / charla). */
const SPEECH_THRESHOLD_LUFS = -40;

type LayoutMode = 'AUTO' | 'VERTICAL_CROP' | 'BLUR_FILL' | 'SPLIT' | 'SCREENCAST';

function computeClipTarget(duration: number): number {
  return Math.max(3, Math.min(MAX_CLIPS, Math.floor(duration / 90) + 2));
}

// ---------- Configuración S3 (LocalStack, Cloudflare R2, Supabase Storage) ----------
const s3 = new S3Client(resolveWorkerS3Config());

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

/** Publica progreso de captura en vivo en el canal Redis "live:progress" */
async function publishLiveProgress(payload: object) {
  await redis.publish('live:progress', JSON.stringify(payload));
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

/** Instante candidato para iniciar un clip, con su puntuación 0..1 y metadatos opcionales de IA. */
interface Highlight {
  start: number;
  end?: number;
  score: number;
  title?: string;
  viralScore?: number;
  hookReason?: string;
  transcript?: string;
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
  clipDuration = DEFAULT_CLIP_DURATION,
): Highlight[] {
  if (duration <= 0) return [{ start: 0, score: 0 }];

  const targetClips = computeClipTarget(duration);
  const minSpacing = Math.max(10, clipDuration);
  const maxStart = Math.max(0, duration - clipDuration);

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

  // 3. Puntuar cada ventana candidata [start, start + clipDuration)
  const candidates: Highlight[] = [];
  for (let start = 0; start <= maxStart; start++) {
    let loudSum = 0;
    let loudCount = 0;
    let cuts = 0;
    let speechSec = 0;
    for (let sec = start; sec < start + clipDuration; sec++) {
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
    // 6 o más cortes en ventana => acción máxima
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
    for (let t = 0; t <= maxStart && regular.length < targetClips; t += 60) {
      regular.push({ start: t, score: 0.5 });
    }
    if (regular.length === 0) regular.push({ start: 0, score: 0.5 });
    return regular;
  }

  // 5. Tomar los mejores respetando separación mínima y objetivo adaptativo
  candidates.sort((a, b) => b.score - a.score);
  const chosen: Highlight[] = [];
  for (const c of candidates) {
    if (chosen.length >= targetClips) break;
    if (chosen.some((x) => Math.abs(x.start - c.start) < minSpacing)) {
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
async function downloadSource(sourceUrl: string, outPath: string): Promise<void> {
  const VIDEO_PLATFORMS =
    /youtu\.be|youtube\.com|youtu\.nic|tiktok\.com|instagram\.com|twitter\.com|x\.com|vimeo\.com|ok\.ru/i;
  if (VIDEO_PLATFORMS.test(sourceUrl)) {
    const isYoutube = /^(?:https?:\/\/)?(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)\//i.test(
      sourceUrl,
    );
    let tmpCookiePath: string | null = null;
    let cookiePath: string | null = null;

    if (process.env.YOUTUBE_COOKIES?.trim()) {
      tmpCookiePath = path.join(TMP_DIR, `worker-cookies-${crypto.randomUUID()}.txt`);
      fs.writeFileSync(tmpCookiePath, `${process.env.YOUTUBE_COOKIES.trim()}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      cookiePath = tmpCookiePath;
    } else if (
      process.env.YTDLP_COOKIES_PATH?.trim() &&
      fs.existsSync(process.env.YTDLP_COOKIES_PATH.trim())
    ) {
      cookiePath = process.env.YTDLP_COOKIES_PATH.trim();
    }

    const clients: (string | null)[] = isYoutube
      ? cookiePath
        ? [null, 'web,default', 'tv,web_embedded']
        : [null, 'tv,android_vr', 'ios,android']
      : [null];

    try {
      let lastErr: Error | null = null;
      for (const client of clients) {
        if (fs.existsSync(outPath)) {
          try {
            fs.unlinkSync(outPath);
          } catch {
            /* ignore */
          }
        }
        const args = [
          '-f',
          'bv*+ba/b',
          '--merge-output-format',
          'mp4',
          '--no-playlist',
          ...(isYoutube ? ['--js-runtimes', 'node'] : []),
          ...(cookiePath ? ['--cookies', cookiePath] : []),
          ...(client ? ['--extractor-args', `youtube:player_client=${client}`] : []),
          '-o',
          outPath,
          '--',
          sourceUrl,
        ];
        try {
          await new Promise<void>((resolve, reject) => {
            execFile('yt-dlp', args, { maxBuffer: 1024 * 1024 * 100 }, (err, _stdout, stderr) => {
              if (err) reject(new Error(stderr || err.message));
              else resolve();
            });
          });
          lastErr = null;
          break;
        } catch (err: any) {
          lastErr = err instanceof Error ? err : new Error(String(err));
        }
      }
      if (lastErr) throw lastErr;
    } finally {
      if (tmpCookiePath && fs.existsSync(tmpCookiePath)) {
        try {
          fs.unlinkSync(tmpCookiePath);
        } catch {
          /* ignore */
        }
      }
    }
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

/** Genera un clip a partir del video original con el layout de reencuadre seleccionado, Auto-Reframe facial opcional y subtítulos ASS en vertical */
function generateClip(
  sourcePath: string,
  start: number,
  clipDuration: number,
  format: 'VERTICAL' | 'HORIZONTAL',
  outPath: string,
  layoutMode: LayoutMode = 'AUTO',
  assSubtitlePath?: string | null,
  dynamicCropFilters?: string[] | null,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const ff = ffmpeg(sourcePath).setStartTime(start).setDuration(clipDuration).outputOptions(
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-c:a',
      'aac',
      '-pix_fmt',
      'yuv420p', // máxima compatibilidad con reproductores
      '-movflags',
      '+faststart',
    );

    if (format === 'VERTICAL') {
      const escapedAss = assSubtitlePath ? escapeFfmpegFilterPath(assSubtitlePath) : null;

      if (dynamicCropFilters && dynamicCropFilters.length > 0) {
        const filters = [...dynamicCropFilters];
        if (escapedAss) {
          filters.push(`ass=${escapedAss}`);
        }
        ff.videoFilters(filters);
      } else if (layoutMode === 'BLUR_FILL') {
        // Layout GENERAL estilo OpenShorts: fondo desenfocado 9:16 + contenido 16:9 nítido centrado
        const filters = [
          '[0:v]split=2[bg][fg]',
          '[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:5[b]',
          '[fg]scale=1080:-2[f]',
          escapedAss ? '[b][f]overlay=(W-w)/2:(H-h)/2[vpre]' : '[b][f]overlay=(W-w)/2:(H-h)/2[v]',
        ];
        if (escapedAss) {
          filters.push(`[vpre]ass=${escapedAss}[v]`);
        }
        ff.complexFilter(filters).outputOptions('-map', '[v]', '-map', '0:a?');
      } else if (layoutMode === 'SPLIT') {
        // Layout SPLIT estilo OpenShorts: 2 hablantes lado a lado apilados en 9:16 (mitad izq arriba, der abajo)
        const filters = [
          '[0:v]split=2[left][right]',
          '[left]crop=iw/2:ih:0:0,scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960[top]',
          '[right]crop=iw/2:ih:iw/2:0,scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960[bot]',
          escapedAss ? '[top][bot]vstack=inputs=2[vpre]' : '[top][bot]vstack=inputs=2[v]',
        ];
        if (escapedAss) {
          filters.push(`[vpre]ass=${escapedAss}[v]`);
        }
        ff.complexFilter(filters).outputOptions('-map', '[v]', '-map', '0:a?');
      } else if (layoutMode === 'SCREENCAST') {
        // Layout SCREENCAST estilo OpenShorts: pantalla arriba + cámara/recorte abajo
        const filters = [
          '[0:v]split=2[scr][cam]',
          '[scr]scale=1080:1120:force_original_aspect_ratio=decrease,pad=1080:1120:(ow-iw)/2:(oh-ih)/2:black[top]',
          '[cam]scale=1080:800:force_original_aspect_ratio=increase,crop=1080:800[bot]',
          escapedAss ? '[top][bot]vstack=inputs=2[vpre]' : '[top][bot]vstack=inputs=2[v]',
        ];
        if (escapedAss) {
          filters.push(`[vpre]ass=${escapedAss}[v]`);
        }
        ff.complexFilter(filters).outputOptions('-map', '[v]', '-map', '0:a?');
      } else {
        // VERTICAL_CROP / AUTO: reencuadre 9:16 centrado (dimensiones pares para x264)
        const filters = ['scale=1080:1920:force_original_aspect_ratio=increase', 'crop=1080:1920'];
        if (escapedAss) {
          filters.push(`ass=${escapedAss}`);
        }
        ff.videoFilters(filters);
      }
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
    const {
      videoId,
      s3Key,
      sourceUrl,
      keepOriginal,
      clipDuration,
      layoutMode,
      autoReframe,
      topicHint,
      geminiApiKey,
      isLiveCapture,
      liveDurationMinutes,
    } = job.data as {
      videoId: string;
      s3Key: string;
      sourceUrl?: string;
      keepOriginal?: boolean;
      clipDuration?: number;
      layoutMode?: LayoutMode;
      autoReframe?: boolean;
      topicHint?: string;
      geminiApiKey?: string;
      isLiveCapture?: boolean;
      liveDurationMinutes?: number;
    };
    const targetClipDuration =
      clipDuration && [15, 30, 45, 60].includes(clipDuration)
        ? clipDuration
        : DEFAULT_CLIP_DURATION;
    const targetLayoutMode: LayoutMode = layoutMode || 'AUTO';
    const useAutoReframe = autoReframe !== false;
    const liveMode = isLiveCapture === true;
    console.log(
      `[Worker] Procesando video ${videoId} (duración clip=${targetClipDuration}s, layout=${targetLayoutMode}, autoReframe=${useAutoReframe}, live=${liveMode})`,
    );

    // 1️⃣ Marcar como PROCESSING y notificar
    const currentVideo = await prisma.video.findUnique({
      where: { id: videoId },
      select: { liveStatus: true },
    });
    const alreadyStopped = currentVideo?.liveStatus === 'STOPPED';

    await prisma.video.update({
      where: { id: videoId },
      data: {
        status: 'PROCESSING',
        ...(liveMode && !alreadyStopped ? { liveStatus: 'RECORDING' } : {}),
      },
    });
    await publishStatus({
      id: videoId,
      status: 'PROCESSING',
      ...(liveMode
        ? {
            phase: 'LIVE_RECORDING',
            liveStatus: alreadyStopped ? 'STOPPED' : 'RECORDING',
          }
        : {}),
    });

    // Nombre temporal: para URLs de origen se usa un sufijo simple (el basename
    // de una URL puede traer caracteres especiales como `?`).
    const tmpVideo = path.join(
      TMP_DIR,
      `${videoId}-${sourceUrl ? 'source.mp4' : path.basename(s3Key)}`,
    );

    try {
      // 2️⃣ Obtener video fuente: captura en vivo, descarga desde URL o desde S3
      if (liveMode) {
        if (!sourceUrl) {
          throw new Error('Se requiere una URL pública para capturar una transmisión en vivo.');
        }
        if (alreadyStopped) {
          throw new Error('La captura en vivo fue detenida antes de iniciar la grabación.');
        }

        const boundedMinutes = normalizeLiveDurationMinutes(liveDurationMinutes);
        const maxDurationSeconds = boundedMinutes * 60;
        console.log(
          `[Worker] ${videoId}: iniciando captura en vivo (máx ${boundedMinutes} min) desde ${sourceUrl}`,
        );

        const captureResult = await recordLiveStream({
          videoId,
          sourceUrl,
          maxDurationSeconds,
          outMp4Path: tmpVideo,
          redisUrl: REDIS_URL,
          onProgress: (event) => publishLiveProgress(event),
        });

        const latestRecord = await prisma.video.findUnique({
          where: { id: videoId },
          select: { liveStatus: true },
        });
        const finalLiveStatus =
          captureResult.stoppedManually || latestRecord?.liveStatus === 'STOPPED'
            ? 'STOPPED'
            : 'FINISHED';

        await prisma.video.update({
          where: { id: videoId },
          data: { liveStatus: finalLiveStatus },
        });

        await publishLiveProgress(
          formatLiveProgressPayload({
            videoId,
            recordedSeconds: captureResult.recordedSeconds,
            fileSizeBytes: captureResult.fileSizeBytes,
            liveStatus: finalLiveStatus,
          }),
        );
        await publishStatus({
          id: videoId,
          status: 'PROCESSING',
          phase: 'ANALYZING',
          liveStatus: finalLiveStatus,
        });
      } else if (sourceUrl) {
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
          console.log(`[Worker] ${videoId}: video completo guardado en S3 (${originalKey})`);
          await publishStatus({
            id: videoId,
            status: 'PROCESSING',
            phase: 'ORIGINAL_SAVED',
          });
        } catch (err) {
          // No es crítico: el resto del pipeline (clips) debe continuar
          console.warn(`[Worker] No se pudo guardar el video completo de ${videoId}:`, err);
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

      // 5️⃣ Detección de momentos destacados: Gemini 3 multimodal (primario) -> heurística ebur128 + escenas (respaldo)
      let highlights: Highlight[] | null = null;
      const effectiveGeminiKey = resolveGeminiApiKey(geminiApiKey);
      if (effectiveGeminiKey) {
        try {
          console.log(`[Worker] ${videoId}: analizando momentos virales con ${GEMINI_MODEL}...`);
          const aiMoments = await analyzeVideoWithGemini({
            videoPath: tmpVideo,
            duration,
            geminiApiKey: effectiveGeminiKey,
            topicHint,
          });
          highlights = aiMoments.map((m) => ({
            start: m.startTime,
            end: m.endTime,
            score: m.viralScore / 100,
            title: m.title,
            viralScore: m.viralScore,
            hookReason: m.hookReason,
            transcript: m.transcript,
          }));
        } catch (err: any) {
          console.warn(
            `[Worker] Análisis multimodal con Gemini falló para ${videoId} (${err?.message || 'error'}), haciendo fallback a heurística ebur128 + escenas.`,
          );
          highlights = null;
        }
      } else {
        console.log(
          `[Worker] ${videoId}: sin GEMINI_API_KEY disponible, usando heurística ebur128 + escenas.`,
        );
      }

      if (!highlights) {
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
          highlights = pickHighlights(samples, sceneTimes, duration, targetClipDuration);
        } catch (err) {
          console.warn(`[Worker] Análisis falló para ${videoId}, uso intervalos fijos:`, err);
          highlights = pickHighlights([], [], duration, targetClipDuration);
        }
      }

      console.log(
        `[Worker] ${videoId}: ${highlights.length} highlights -> ` +
          highlights.map((h) => `${h.start}s(score ${Math.round(h.score * 100)})`).join(', '),
      );

      // 6️⃣ Generar clips (duración devuelta por Gemini o duración configurada en respaldo, ambos formatos)
      const createdClips: any[] = [];
      for (const highlight of highlights) {
        const startSec = highlight.start;
        const requestedDur =
          highlight.end !== undefined && highlight.end > startSec
            ? highlight.end - startSec
            : targetClipDuration;
        const clipDur = Math.min(requestedDur, duration - startSec);
        if (clipDur <= 0) continue;

        let assSubtitlePath: string | null = null;
        if (highlight.transcript?.trim()) {
          const tmpAssFile = path.join(TMP_DIR, `${videoId}-clip-${Math.floor(startSec)}.ass`);
          assSubtitlePath = await writeAssSubtitleFile(
            {
              transcript: highlight.transcript,
              startTime: startSec,
              endTime: startSec + clipDur,
            },
            tmpAssFile,
          ).catch((subErr) => {
            console.warn(`[Worker] Error generando subtítulos .ass para ${videoId}:`, subErr);
            return null;
          });
        }

        let dynamicCropFilters: string[] | null = null;
        if (useAutoReframe && targetLayoutMode !== 'SPLIT' && targetLayoutMode !== 'SCREENCAST') {
          dynamicCropFilters = await buildDynamicCropFilter(
            tmpVideo,
            startSec,
            startSec + clipDur,
            1080,
            1920,
          );
        }

        try {
          for (const fmt of ['VERTICAL', 'HORIZONTAL'] as const) {
            const clipFile = path.join(
              TMP_DIR,
              `${videoId}-clip-${Math.floor(startSec)}-${fmt}.mp4`,
            );
            try {
              await generateClip(
                tmpVideo,
                startSec,
                clipDur,
                fmt,
                clipFile,
                targetLayoutMode,
                fmt === 'VERTICAL' ? assSubtitlePath : null,
                fmt === 'VERTICAL' ? dynamicCropFilters : null,
              );

              // Subir clip a S3
              const clipKey = `clips/${videoId}/${path.basename(clipFile)}`;
              const putCmd = new PutObjectCommand({
                Bucket: process.env.S3_BUCKET,
                Key: clipKey,
                Body: fs.createReadStream(clipFile),
                ContentType: 'video/mp4',
              });
              await s3.send(putCmd);

              const clipUrl = buildPublicObjectUrl({
                bucket: process.env.S3_BUCKET || '',
                key: clipKey,
                publicEndpoint: process.env.S3_PUBLIC_ENDPOINT,
                s3Endpoint: process.env.S3_ENDPOINT,
              });
              const clipRecord = await prisma.clip.create({
                data: {
                  videoId,
                  s3Key: clipKey,
                  clipUrl,
                  startTime: Math.floor(startSec),
                  endTime: Math.round(startSec + clipDur),
                  score: Math.round(highlight.score * 100), // 0..100
                  format: fmt,
                  ...(highlight.title !== undefined ? { title: highlight.title } : {}),
                  ...(highlight.viralScore !== undefined
                    ? { viralScore: highlight.viralScore }
                    : {}),
                  ...(highlight.hookReason !== undefined
                    ? { hookReason: highlight.hookReason }
                    : {}),
                  ...(highlight.transcript !== undefined
                    ? { transcript: highlight.transcript }
                    : {}),
                },
              });
              createdClips.push(clipRecord);
            } finally {
              // Limpiar archivo temporal del clip (exista o no)
              if (fs.existsSync(clipFile)) fs.unlinkSync(clipFile);
            }
          }
        } finally {
          if (assSubtitlePath && fs.existsSync(assSubtitlePath)) {
            fs.unlinkSync(assSubtitlePath);
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
      console.log(`[Worker] Video ${videoId} listo, ${createdClips.length} clips creados`);
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
  const isLiveCapture = job?.data?.isLiveCapture === true;
  console.error(`[Worker] Job ${job?.id} falló:`, err);

  // Marcar el video como FAILED en la base de datos y liberar cualquier bloqueo LIVE
  if (videoId) {
    try {
      await prisma.video.update({
        where: { id: videoId },
        data: { status: 'FAILED' },
      });
      if (isLiveCapture) {
        await prisma.video.updateMany({
          where: { id: videoId, liveStatus: 'RECORDING' },
          data: { liveStatus: 'FINISHED' },
        });
      }
    } catch (dbErr) {
      console.error(`[Worker] No se pudo marcar ${videoId} como FAILED:`, dbErr);
    }
  }

  await publishStatus({
    id: videoId,
    status: 'FAILED',
    ...(isLiveCapture ? { liveStatus: 'FINISHED' } : {}),
    error: err.message,
  });
});
