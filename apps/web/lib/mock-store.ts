import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  downloadVideoFromUrl,
  captureLiveStreamLocal,
  probeVideoDuration,
  analyzeVideoLoudness,
  analyzeVideoScenes,
  pickAudioSceneHighlights,
  cutClipWithFfmpeg,
  getClipTempPath,
} from './video-processor';
import { generateViralClipMetadata } from './gemini-clips';

export type LayoutMode =
  | 'AUTO'
  | 'VERTICAL_CROP'
  | 'BLUR_FILL'
  | 'SPLIT'
  | 'SCREENCAST';

export type HookStyle = 'pill' | 'banner' | 'minimal';
export type HookPosition = 'top' | 'center' | 'bottom';

export interface MockClip {
  id: string;
  videoId: string;
  s3Key: string;
  clipUrl: string;
  startTime: number;
  endTime: number;
  score: number;
  format: 'VERTICAL' | 'HORIZONTAL';
  layoutMode?: LayoutMode;
  title?: string;
  viralScore?: number | null;
  hookReason?: string | null;
  transcript?: string | null;
  hookText?: string;
  hookStyle?: HookStyle;
  hookPosition?: HookPosition;
  why?: string;
  caption?: string;
  createdAt: string;
}

export interface MockVideo {
  id: string;
  title: string;
  s3Key: string;
  duration: number;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  phase?: string;
  errorMessage?: string | null;
  sourceUrl?: string | null;
  originalKey?: string | null;
  clipDuration?: number;
  layoutMode?: LayoutMode;
  autoReframe?: boolean;
  topicHint?: string | null;
  isLiveCapture?: boolean;
  liveDurationMinutes?: number | null;
  liveStatus?: 'RECORDING' | 'STOPPED' | 'FINISHED' | null;
  liveRecordedSeconds?: number;
  liveFileSizeBytes?: number;
  createdAt: string;
  clips: MockClip[];
}

interface UploadedFileMeta {
  filePath: string;
  contentType: string;
}

interface MockStore {
  videos: Map<string, MockVideo>;
  files: Map<string, UploadedFileMeta>;
  clipFiles: Map<string, string>;
  liveStopHandlers: Map<string, () => void>;
}

const globalForStore = globalThis as unknown as {
  __streamlikeMockStore?: MockStore;
};

export const mockStore: MockStore =
  globalForStore.__streamlikeMockStore ??
  (globalForStore.__streamlikeMockStore = {
    videos: new Map<string, MockVideo>(),
    files: new Map<string, UploadedFileMeta>(),
    clipFiles: new Map<string, string>(),
    liveStopHandlers: new Map<string, () => void>(),
  });

// Garantizar que clipFiles y liveStopHandlers existan si el store ya fue inicializado en HMR
if (!mockStore.clipFiles) {
  mockStore.clipFiles = new Map<string, string>();
}
if (!mockStore.liveStopHandlers) {
  mockStore.liveStopHandlers = new Map<string, () => void>();
}

export function stopLiveLocal(videoId: string): boolean {
  const v = mockStore.videos.get(videoId);
  if (!v || !v.isLiveCapture) return false;
  if (v.liveStatus === 'FINISHED') return false;
  v.liveStatus = 'STOPPED';
  v.phase = 'ANALYZING';
  const stopFn = mockStore.liveStopHandlers.get(videoId);
  if (stopFn) {
    stopFn();
  }
  return true;
}

export function getUploadTempPath(key: string): string {
  const safeKey = path.basename(key).replace(/[^\w.\-]+/g, '_');
  return path.join(os.tmpdir(), `streamlike-${safeKey}`);
}

export function saveUploadedFile(
  key: string,
  data: Buffer,
  contentType: string,
): string {
  const filePath = getUploadTempPath(key);
  fs.writeFileSync(filePath, data);
  mockStore.files.set(key, { filePath, contentType });
  return filePath;
}

export function registerExistingFile(
  key: string,
  filePath: string,
  contentType = 'video/mp4',
): void {
  mockStore.files.set(key, { filePath, contentType });
}

export function getUploadedFile(key: string): UploadedFileMeta | undefined {
  const meta = mockStore.files.get(key);
  if (meta && fs.existsSync(meta.filePath)) {
    return meta;
  }
  return undefined;
}

export function getClipFilePath(clipId: string): string | undefined {
  const p = mockStore.clipFiles.get(clipId) || getClipTempPath(clipId);
  return fs.existsSync(p) ? p : undefined;
}

export function deleteVideoFiles(video: MockVideo): void {
  const keys = [video.s3Key, video.originalKey].filter((k): k is string =>
    Boolean(k),
  );
  for (const key of keys) {
    const meta = mockStore.files.get(key);
    if (meta && fs.existsSync(meta.filePath)) {
      try {
        fs.unlinkSync(meta.filePath);
      } catch {
        /* ignore cleanup errors */
      }
    }
    mockStore.files.delete(key);
  }
  for (const clip of video.clips || []) {
    const cp = mockStore.clipFiles.get(clip.id) || getClipTempPath(clip.id);
    if (fs.existsSync(cp)) {
      try {
        fs.unlinkSync(cp);
      } catch {
        /* ignore cleanup errors */
      }
    }
    mockStore.clipFiles.delete(clip.id);
  }
}

export function computeAdaptiveClipCount(durationSeconds: number): number {
  return Math.max(1, Math.min(4, Math.floor(durationSeconds / 45) + 2));
}

/**
 * Pipeline REAL de procesamiento:
 * 1. Descarga desde URL (yt-dlp / HTTP) o lee el archivo subido.
 * 2. Conserva el original completo si `keepOriginal` está activo.
 * 3. Analiza duración, sonoridad (ebur128) y cortes de escena con FFmpeg.
 * 4. Corta y reencuadra los clips MP4 reales en disco listos para reproducir y descargar.
 */
export function startRealVideoProcessing(
  videoId: string,
  keepOriginal: boolean,
  options?: { cookiesText?: string; geminiApiKey?: string },
): void {
  void (async () => {
    const v = mockStore.videos.get(videoId);
    if (!v) return;

    let sourcePath = '';
    let shouldCleanupSource = false;

    try {
      v.status = 'PROCESSING';
      v.phase = 'DOWNLOADING';
      v.errorMessage = null;

      if (v.sourceUrl && v.isLiveCapture) {
        const downloadedKey = `originals-${v.id}.mp4`;
        const targetPath = getUploadTempPath(downloadedKey);
        v.phase = 'LIVE_RECORDING';
        if (v.liveStatus !== 'STOPPED') {
          v.liveStatus = 'RECORDING';
        }
        const boundedMinutes = Math.max(
          5,
          Math.min(120, Math.round(v.liveDurationMinutes || 30)),
        );
        const captureRes = await captureLiveStreamLocal(v.sourceUrl, targetPath, {
          maxDurationSeconds: boundedMinutes * 60,
          cookiesText: options?.cookiesText,
          registerStopHandler: (stopFn) => {
            mockStore.liveStopHandlers.set(v.id, stopFn);
          },
          onProgress: (recordedSeconds, fileSizeBytes) => {
            v.liveRecordedSeconds = recordedSeconds;
            v.liveFileSizeBytes = fileSizeBytes;
          },
        });
        mockStore.liveStopHandlers.delete(v.id);
        v.liveRecordedSeconds = captureRes.recordedSeconds;
        v.liveFileSizeBytes = captureRes.fileSizeBytes;
        v.liveStatus =
          captureRes.stoppedManually || v.liveStatus === 'STOPPED'
            ? 'STOPPED'
            : 'FINISHED';
        sourcePath = targetPath;
        if (keepOriginal) {
          registerExistingFile(downloadedKey, targetPath, 'video/mp4');
          v.originalKey = downloadedKey;
        } else {
          v.originalKey = null;
          shouldCleanupSource = true;
        }
      } else if (v.sourceUrl) {
        const downloadedKey = `originals-${v.id}.mp4`;
        const targetPath = getUploadTempPath(downloadedKey);
        const { title } = await downloadVideoFromUrl(v.sourceUrl, targetPath, {
          cookiesText: options?.cookiesText,
          onTitleDetected: (detectedTitle) => {
            if (/^video-\d+\.mp4$/i.test(v.title)) {
              v.title = detectedTitle;
            }
          },
        });
        if (title && /^video-\d+\.mp4$/i.test(v.title)) {
          v.title = title;
        }
        sourcePath = targetPath;
        if (keepOriginal) {
          registerExistingFile(downloadedKey, targetPath, 'video/mp4');
          v.originalKey = downloadedKey;
        } else {
          v.originalKey = null;
          shouldCleanupSource = true;
        }
      } else {
        const uploaded = getUploadedFile(v.s3Key);
        if (!uploaded) {
          throw new Error('No se encontró el archivo subido en el servidor');
        }
        sourcePath = uploaded.filePath;
        v.originalKey = keepOriginal ? v.s3Key : null;
      }

      // Medir duración real con ffprobe
      v.phase = 'DURATION';
      const duration = await probeVideoDuration(sourcePath);
      if (!duration) {
        throw new Error('No se pudo determinar la duración del video con ffprobe');
      }
      v.duration = duration;

      // Analizar sonoridad y escenas con FFmpeg
      v.phase = 'ANALYZING';
      const [samples, sceneTimes] = await Promise.all([
        analyzeVideoLoudness(sourcePath).catch(() => []),
        analyzeVideoScenes(sourcePath).catch(() => []),
      ]);

      const clipLen = Math.min(
        Math.max(5, v.clipDuration || 15),
        Math.max(5, duration),
      );
      const maxClips = Math.min(3, computeAdaptiveClipCount(duration));
      const highlights = pickAudioSceneHighlights(
        samples,
        sceneTimes,
        duration,
        clipLen,
        maxClips,
      );

      // Cortar clips reales con FFmpeg
      v.phase = 'CUTTING';
      const layoutMode: LayoutMode = v.layoutMode || 'AUTO';
      const createdClips: MockClip[] = [];

      for (const h of highlights) {
        const startTime = Math.floor(h.start);
        const dur = Math.max(3, Math.min(clipLen, duration - startTime));
        const endTime = startTime + dur;
        const score = Math.max(55, Math.min(99, Math.round(h.score * 100) || 75));

        for (const format of ['VERTICAL', 'HORIZONTAL'] as const) {
          const clipId = crypto.randomUUID();
          const clipOutPath = getClipTempPath(clipId);

          await cutClipWithFfmpeg({
            sourcePath,
            outPath: clipOutPath,
            startTime,
            duration: dur,
            format,
            layoutMode,
          });

          mockStore.clipFiles.set(clipId, clipOutPath);
          createdClips.push({
            id: clipId,
            videoId: v.id,
            s3Key: `clips/${v.id}/${clipId}-${format}.mp4`,
            clipUrl: `/videos/${v.id}/clips/${clipId}/file`,
            startTime,
            endTime,
            score,
            format,
            layoutMode: format === 'VERTICAL' ? layoutMode : undefined,
            title: `Momento destacado ${startTime}s – ${endTime}s`,
            viralScore: score,
            hookReason:
              samples.length > 0
                ? 'Detectado por pico de sonoridad EBU R128, actividad de habla y cambios de escena.'
                : 'Segmento extraído y reencuadrado automáticamente con FFmpeg.',
            hookStyle: 'pill',
            hookPosition: 'top',
            why:
              samples.length > 0
                ? 'Detectado por pico de sonoridad EBU R128, actividad de habla y cambios de escena.'
                : 'Segmento extraído y reencuadrado automáticamente con FFmpeg.',
            createdAt: new Date().toISOString(),
          });
        }
      }

      // Enriquecimiento automático opcional con Gemini si hay clave del usuario o de entorno
      const hasEffectiveGeminiKey = Boolean(
        options?.geminiApiKey?.trim() ||
          (process.env.GEMINI_API_KEY &&
            process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'),
      );

      if (hasEffectiveGeminiKey && createdClips.length > 0) {
        try {
          const uniqueWindows = new Map<
            number,
            { startTime: number; endTime: number; audioScore: number }
          >();
          for (const c of createdClips) {
            if (!uniqueWindows.has(c.startTime)) {
              uniqueWindows.set(c.startTime, {
                startTime: c.startTime,
                endTime: c.endTime,
                audioScore: c.score,
              });
            }
          }
          const aiResults = await generateViralClipMetadata(
            {
              videoTitle: v.title,
              sourceUrl: v.sourceUrl,
              topicHint: v.topicHint || undefined,
              duration: v.duration,
              windows: Array.from(uniqueWindows.values()),
            },
            options?.geminiApiKey,
          );
          const byStart = new Map(aiResults.map((r) => [r.startTime, r]));
          for (const clip of createdClips) {
            const match =
              byStart.get(clip.startTime) ??
              aiResults.find((r) => Math.abs(r.startTime - clip.startTime) <= 2);
            if (!match) continue;
            clip.title = match.title;
            clip.hookText = match.hookText;
            clip.why = match.why;
            clip.hookReason = match.why;
            clip.caption = match.caption;
            if (Number.isFinite(match.suggestedScore)) {
              const bounded = Math.max(
                0,
                Math.min(100, Math.round(match.suggestedScore)),
              );
              clip.score = bounded;
              clip.viralScore = bounded;
            }
          }
        } catch {
          /* fallback silencioso a metadatos heurísticos */
        }
      }

      v.clips = createdClips;
      v.status = 'COMPLETED';
      v.phase = undefined;
    } catch (err: any) {
      const msg = err?.message || 'Error al procesar o cortar el video';
      console.warn(`[Processor] Video ${videoId} detenido: ${msg}`);
      v.status = 'FAILED';
      v.phase = undefined;
      if (v.isLiveCapture && v.liveStatus === 'RECORDING') {
        v.liveStatus = 'FINISHED';
      }
      v.errorMessage = msg;
    } finally {
      mockStore.liveStopHandlers.delete(v.id);
      if (shouldCleanupSource && sourcePath && fs.existsSync(sourcePath)) {
        try {
          fs.unlinkSync(sourcePath);
        } catch {
          /* ignore */
        }
      }
    }
  })();
}

/**
 * Re-corta un clip existente con FFmpeg cuando el usuario ajusta inicio/fin o layout en el editor.
 */
export async function recutClipReal(
  video: MockVideo,
  clip: MockClip,
): Promise<void> {
  const keyToFind = video.originalKey || video.s3Key;
  const uploaded = getUploadedFile(keyToFind);
  if (!uploaded) {
    // Si no se conservó el original en disco, solo actualizamos metadatos
    return;
  }

  const dur = Math.max(3, clip.endTime - clip.startTime);
  const clipOutPath = getClipTempPath(clip.id);
  await cutClipWithFfmpeg({
    sourcePath: uploaded.filePath,
    outPath: clipOutPath,
    startTime: clip.startTime,
    duration: dur,
    format: clip.format,
    layoutMode: clip.layoutMode || video.layoutMode || 'AUTO',
  });
  mockStore.clipFiles.set(clip.id, clipOutPath);
}
