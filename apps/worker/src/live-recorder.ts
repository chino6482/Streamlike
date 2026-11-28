import { ChildProcess, execFile, spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import Redis from 'ioredis';
import * as os from 'os';
import * as path from 'path';

export const DEFAULT_LIVE_DURATION_MINUTES = 30;
export const MIN_LIVE_DURATION_MINUTES = 5;
export const MAX_LIVE_DURATION_MINUTES = 120;

export type LiveStatus = 'RECORDING' | 'STOPPED' | 'FINISHED';

export interface LiveProgressEvent {
  videoId: string;
  recordedSeconds: number;
  recordedMinutes: number;
  fileSizeBytes: number;
  fileSizeMb: number;
  liveStatus: LiveStatus;
}

export interface RecordLiveStreamOptions {
  videoId: string;
  sourceUrl: string;
  maxDurationSeconds: number;
  outMp4Path: string;
  redisUrl: string;
  cookiesText?: string;
  onProgress?: (event: LiveProgressEvent) => void | Promise<void>;
}

export interface RecordLiveStreamResult {
  outMp4Path: string;
  recordedSeconds: number;
  fileSizeBytes: number;
  stoppedManually: boolean;
}

const YOUTUBE_URL_RE = /^(?:https?:\/\/)?(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)\//i;
const MAX_COOKIES_BYTES = 256 * 1024;

export function normalizeLiveDurationMinutes(raw?: number | null): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return DEFAULT_LIVE_DURATION_MINUTES;
  }
  return Math.max(MIN_LIVE_DURATION_MINUTES, Math.min(MAX_LIVE_DURATION_MINUTES, Math.round(raw)));
}

export function buildLiveStopChannel(videoId: string): string {
  return `live-stop:${videoId}`;
}

export function isYoutubeLiveUrl(sourceUrl: string): boolean {
  return YOUTUBE_URL_RE.test(sourceUrl);
}

export function buildYtDlpLiveArgs(opts: {
  sourceUrl: string;
  cookiePath?: string | null;
  isYoutube?: boolean;
}): string[] {
  const isYoutube = opts.isYoutube ?? isYoutubeLiveUrl(opts.sourceUrl);
  return [
    '--no-part',
    '--hls-use-mpegts',
    '--no-playlist',
    '--no-warnings',
    '--socket-timeout',
    '20',
    ...(isYoutube ? ['--js-runtimes', 'node'] : []),
    ...(opts.cookiePath ? ['--cookies', opts.cookiePath] : []),
    '-f',
    'b',
    '-o',
    '-',
    '--',
    opts.sourceUrl,
  ];
}

export function buildFfmpegLiveCaptureArgs(opts: {
  outTsPath: string;
  maxDurationSeconds: number;
}): string[] {
  const boundedSeconds = Math.max(10, Math.round(opts.maxDurationSeconds));
  return [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-y',
    '-i',
    'pipe:0',
    '-t',
    String(boundedSeconds),
    '-c',
    'copy',
    '-f',
    'mpegts',
    opts.outTsPath,
  ];
}

export function buildFfmpegRemuxMp4Args(opts: {
  inTsPath: string;
  outMp4Path: string;
  transcode?: boolean;
}): string[] {
  if (opts.transcode) {
    return [
      '-hide_banner',
      '-loglevel',
      'warning',
      '-y',
      '-i',
      opts.inTsPath,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-c:a',
      'aac',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      opts.outMp4Path,
    ];
  }

  return [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-y',
    '-i',
    opts.inTsPath,
    '-c',
    'copy',
    '-bsf:a',
    'aac_adtstoasc',
    '-movflags',
    '+faststart',
    opts.outMp4Path,
  ];
}

export function formatLiveProgressPayload(opts: {
  videoId: string;
  recordedSeconds: number;
  fileSizeBytes: number;
  liveStatus: LiveStatus;
}): LiveProgressEvent {
  const recordedSeconds = Math.max(0, Math.round(opts.recordedSeconds));
  const fileSizeBytes = Math.max(0, Math.round(opts.fileSizeBytes));
  return {
    videoId: opts.videoId,
    recordedSeconds,
    recordedMinutes: Number((recordedSeconds / 60).toFixed(2)),
    fileSizeBytes,
    fileSizeMb: Number((fileSizeBytes / (1024 * 1024)).toFixed(2)),
    liveStatus: opts.liveStatus,
  };
}

function resolveFfmpegBinary(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ffmpegStatic = require('ffmpeg-static');
    if (typeof ffmpegStatic === 'string' && ffmpegStatic) {
      return ffmpegStatic;
    }
  } catch {
    /* usar ffmpeg del PATH */
  }
  return 'ffmpeg';
}

function resolveYtDlpBinary(): string {
  const envBin = process.env.YTDLP_PATH?.trim();
  if (envBin && fs.existsSync(envBin)) {
    return envBin;
  }
  return 'yt-dlp';
}

function resolveEphemeralCookies(cookiesText?: string): {
  cookiePath: string | null;
  cleanup: () => void;
} {
  const raw = cookiesText?.trim() || process.env.YOUTUBE_COOKIES?.trim() || '';
  if (raw) {
    const cleaned = raw.replace(/\0/g, '').trim();
    if (Buffer.byteLength(cleaned, 'utf8') > MAX_COOKIES_BYTES) {
      throw new Error('Las cookies superan el límite permitido de 256 KB.');
    }
    if (cleaned) {
      const tmpCookie = path.join(os.tmpdir(), `worker-live-cookies-${crypto.randomUUID()}.txt`);
      fs.writeFileSync(tmpCookie, `${cleaned}\n`, { encoding: 'utf8', mode: 0o600 });
      return {
        cookiePath: tmpCookie,
        cleanup: () => {
          try {
            if (fs.existsSync(tmpCookie)) fs.unlinkSync(tmpCookie);
          } catch {
            /* ignore */
          }
        },
      };
    }
  }

  const envPath = process.env.YTDLP_COOKIES_PATH?.trim();
  if (envPath && fs.existsSync(envPath)) {
    return { cookiePath: envPath, cleanup: () => {} };
  }

  return { cookiePath: null, cleanup: () => {} };
}

function runExecFileAsync(cmd: string, args: string[], timeoutMs = 120_000): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { maxBuffer: 1024 * 1024 * 16, timeout: timeoutMs },
      (err, _stdout, stderr) => {
        if (err) {
          reject(new Error((stderr || err.message || '').trim() || err.message));
        } else {
          resolve();
        }
      },
    );
  });
}

function safeFileSize(filePath: string): number {
  try {
    if (fs.existsSync(filePath)) {
      return fs.statSync(filePath).size;
    }
  } catch {
    /* ignore */
  }
  return 0;
}

/**
 * Graba una transmisión en vivo (YouTube Live, Twitch, Kick, TikTok Live) mediante
 * `yt-dlp --no-part --hls-use-mpegts` conectado por pipe a `ffmpeg` en formato
 * MPEG-TS (resiliente a micro-cortes y detenciones repentinas), y al finalizar
 * remuxea a `.mp4` con `+faststart` listo para análisis con Gemini y FFmpeg.
 */
export async function recordLiveStream(
  options: RecordLiveStreamOptions,
): Promise<RecordLiveStreamResult> {
  const { videoId, sourceUrl, maxDurationSeconds, outMp4Path, redisUrl, cookiesText, onProgress } =
    options;

  const outDir = path.dirname(outMp4Path);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  if (fs.existsSync(outMp4Path)) {
    fs.unlinkSync(outMp4Path);
  }

  const tmpTsPath = `${outMp4Path}.ts`;
  if (fs.existsSync(tmpTsPath)) {
    fs.unlinkSync(tmpTsPath);
  }

  const ffmpegBin = resolveFfmpegBinary();
  const ytdlpBin = resolveYtDlpBinary();
  const { cookiePath, cleanup: cleanupCookies } = resolveEphemeralCookies(cookiesText);

  const stopChannel = buildLiveStopChannel(videoId);
  const subscriber = new Redis(redisUrl);

  let ytdlpProc: ChildProcess | null = null;
  let ffmpegProc: ChildProcess | null = null;
  let stoppedManually = false;
  let stopTriggered = false;
  let progressTimer: NodeJS.Timeout | null = null;
  let hardTimeoutTimer: NodeJS.Timeout | null = null;
  let stopGraceTimer: NodeJS.Timeout | null = null;

  const startedAtMs = Date.now();
  const ytdlpStderrChunks: string[] = [];
  const ffmpegStderrChunks: string[] = [];

  const stopProcessesGracefully = (manual: boolean) => {
    if (stopTriggered) return;
    stopTriggered = true;
    if (manual) stoppedManually = true;

    try {
      if (ffmpegProc && !ffmpegProc.killed) {
        if (ffmpegProc.stdin?.writable) {
          ffmpegProc.stdin.write('q\n');
          ffmpegProc.stdin.end();
        }
        ffmpegProc.kill('SIGINT');
      }
    } catch {
      /* ignore */
    }

    stopGraceTimer = setTimeout(() => {
      try {
        if (ffmpegProc && ffmpegProc.exitCode === null) {
          ffmpegProc.kill('SIGKILL');
        }
      } catch {
        /* ignore */
      }
    }, 3_000);

    try {
      if (ytdlpProc && ytdlpProc.exitCode === null) {
        ytdlpProc.kill('SIGTERM');
      }
    } catch {
      /* ignore */
    }
  };

  try {
    await subscriber.subscribe(stopChannel);
    subscriber.on('message', (channel) => {
      if (channel === stopChannel) {
        console.log(`[LiveRecorder] Señal STOP recibida para ${videoId}`);
        stopProcessesGracefully(true);
      }
    });

    const ytdlpArgs = buildYtDlpLiveArgs({
      sourceUrl,
      cookiePath,
    });
    const ffmpegArgs = buildFfmpegLiveCaptureArgs({
      outTsPath: tmpTsPath,
      maxDurationSeconds,
    });

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };

      ytdlpProc = spawn(ytdlpBin, ytdlpArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      });

      ffmpegProc = spawn(ffmpegBin, ffmpegArgs, {
        stdio: ['pipe', 'ignore', 'pipe'],
        shell: false,
      });

      ytdlpProc.stderr?.on('data', (chunk) => {
        ytdlpStderrChunks.push(String(chunk));
        if (ytdlpStderrChunks.length > 40) ytdlpStderrChunks.shift();
      });

      ffmpegProc.stderr?.on('data', (chunk) => {
        ffmpegStderrChunks.push(String(chunk));
        if (ffmpegStderrChunks.length > 40) ffmpegStderrChunks.shift();
      });

      if (ytdlpProc.stdout && ffmpegProc.stdin) {
        ytdlpProc.stdout.pipe(ffmpegProc.stdin);
        ytdlpProc.stdout.on('error', () => {
          /* EPIPE esperado cuando ffmpeg cierra al llegar a -t o recibir SIGINT */
        });
        ffmpegProc.stdin.on('error', () => {
          /* EPIPE esperado si ffmpeg termina antes que yt-dlp */
        });
      }

      ytdlpProc.on('error', (err) => {
        stopProcessesGracefully(false);
        finish(new Error(`Error iniciando yt-dlp para captura en vivo: ${err.message}`));
      });

      ffmpegProc.on('error', (err) => {
        stopProcessesGracefully(false);
        finish(new Error(`Error iniciando ffmpeg para captura en vivo: ${err.message}`));
      });

      progressTimer = setInterval(() => {
        const elapsedSeconds = Math.floor((Date.now() - startedAtMs) / 1000);
        const fileSizeBytes = safeFileSize(tmpTsPath);
        if (onProgress) {
          void Promise.resolve(
            onProgress(
              formatLiveProgressPayload({
                videoId,
                recordedSeconds: elapsedSeconds,
                fileSizeBytes,
                liveStatus: stoppedManually ? 'STOPPED' : 'RECORDING',
              }),
            ),
          ).catch(() => {});
        }
      }, 2_000);

      hardTimeoutTimer = setTimeout(
        () => {
          stopProcessesGracefully(false);
        },
        (Math.max(10, Math.round(maxDurationSeconds)) + 45) * 1000,
      );

      ffmpegProc.on('close', (code) => {
        try {
          if (ytdlpProc && ytdlpProc.exitCode === null) {
            ytdlpProc.kill('SIGTERM');
          }
        } catch {
          /* ignore */
        }

        const capturedBytes = safeFileSize(tmpTsPath);
        if (capturedBytes > 0) {
          finish();
          return;
        }

        const ytdlpDetail = ytdlpStderrChunks.join('').trim().slice(-500);
        const ffmpegDetail = ffmpegStderrChunks.join('').trim().slice(-500);
        finish(
          new Error(
            ytdlpDetail ||
              ffmpegDetail ||
              `No se recibió video de la transmisión en vivo (ffmpeg exit ${code ?? 'unknown'}).`,
          ),
        );
      });
    });

    // Remux MPEG-TS -> MP4 válido (+faststart) para compatibilidad total con Gemini & FFmpeg
    try {
      await runExecFileAsync(
        ffmpegBin,
        buildFfmpegRemuxMp4Args({ inTsPath: tmpTsPath, outMp4Path, transcode: false }),
        180_000,
      );
    } catch {
      await runExecFileAsync(
        ffmpegBin,
        buildFfmpegRemuxMp4Args({ inTsPath: tmpTsPath, outMp4Path, transcode: true }),
        240_000,
      );
    }

    const finalBytes = safeFileSize(outMp4Path);
    if (finalBytes === 0) {
      throw new Error('La captura en vivo finalizó sin generar un archivo MP4 válido.');
    }

    const recordedSeconds = Math.max(1, Math.round((Date.now() - startedAtMs) / 1000));
    return {
      outMp4Path,
      recordedSeconds,
      fileSizeBytes: finalBytes,
      stoppedManually,
    };
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    if (hardTimeoutTimer) clearTimeout(hardTimeoutTimer);
    if (stopGraceTimer) clearTimeout(stopGraceTimer);
    cleanupCookies();
    if (fs.existsSync(tmpTsPath)) {
      try {
        fs.unlinkSync(tmpTsPath);
      } catch {
        /* ignore */
      }
    }
    try {
      await subscriber.unsubscribe(stopChannel);
    } catch {
      /* ignore */
    }
    try {
      await subscriber.quit();
    } catch {
      subscriber.disconnect();
    }
  }
}
