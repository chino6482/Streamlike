import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { LayoutMode } from './mock-store';

export interface LoudnessSample {
  time: number;
  loudness: number;
}

export interface Highlight {
  start: number;
  score: number;
}

const SPEECH_THRESHOLD_LUFS = -40;
const MAX_COOKIES_BYTES = 256 * 1024;

function isElfBinary(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4);
    const bytesRead = fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    return (
      bytesRead === 4 &&
      buf[0] === 0x7f &&
      buf[1] === 0x45 &&
      buf[2] === 0x4c &&
      buf[3] === 0x46
    );
  } catch {
    return false;
  }
}

function resolveYtDlpCommand(): { cmd: string; prefixArgs: string[] } {
  const candidates = [
    path.join(process.cwd(), 'bin', 'yt-dlp'),
    path.join(process.cwd(), 'apps', 'web', 'bin', 'yt-dlp'),
    '/app/applet/apps/web/bin/yt-dlp',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return isElfBinary(p)
        ? { cmd: p, prefixArgs: [] }
        : { cmd: 'python3', prefixArgs: [p] };
    }
  }
  return { cmd: 'yt-dlp', prefixArgs: [] };
}

function runExecFile(
  cmd: string,
  args: string[],
  timeoutMs = 180_000,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { maxBuffer: 1024 * 1024 * 64, timeout: timeoutMs },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || err.message || '').trim().slice(-600);
          reject(new Error(detail || err.message));
        } else {
          resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
        }
      },
    );
  });
}

const VIDEO_PLATFORMS =
  /youtu\.be|youtube\.com|tiktok\.com|instagram\.com|twitter\.com|x\.com|vimeo\.com|twitch\.tv|facebook\.com|fb\.watch|dailymotion\.com|ok\.ru/i;
const YOUTUBE_URL_RE = /^(?:https?:\/\/)?(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)\//i;

function sanitizeCookiesText(raw: string): string {
  const cleaned = raw.replace(/\0/g, '').trim();
  if (!cleaned) return '';
  if (Buffer.byteLength(cleaned, 'utf8') > MAX_COOKIES_BYTES) {
    throw new Error('El archivo de cookies supera el tamaño máximo permitido (256 KB).');
  }
  return `${cleaned}\n`;
}

function resolveCookiesFile(cookiesText?: string): {
  cookiePath: string | null;
  cleanup: () => void;
} {
  const raw = cookiesText?.trim() || process.env.YOUTUBE_COOKIES?.trim() || '';
  if (raw) {
    const normalized = sanitizeCookiesText(raw);
    if (normalized) {
      const tmpCookie = path.join(
        os.tmpdir(),
        `streamlike-cookies-${crypto.randomUUID()}.txt`,
      );
      fs.writeFileSync(tmpCookie, normalized, { encoding: 'utf8', mode: 0o600 });
      return {
        cookiePath: tmpCookie,
        cleanup: () => {
          try {
            if (fs.existsSync(tmpCookie)) fs.unlinkSync(tmpCookie);
          } catch {
            /* ignore cleanup errors */
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

async function fetchYoutubeOEmbedTitle(sourceUrl: string): Promise<string | undefined> {
  if (!YOUTUBE_URL_RE.test(sourceUrl)) return undefined;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(sourceUrl)}&format=json`,
      { signal: controller.signal },
    );
    clearTimeout(timer);
    if (!res.ok) return undefined;
    const data = (await res.json()) as { title?: string };
    if (typeof data?.title === 'string' && data.title.trim()) {
      return data.title.trim().slice(0, 140);
    }
  } catch {
    /* ignore oembed failures */
  }
  return undefined;
}

function isYoutubeBotError(message: string): boolean {
  return /sign in to confirm|not a bot|--cookies-from-browser|--cookies for the authentication/i.test(
    message,
  );
}

/**
 * Descarga un video desde una URL pública (yt-dlp para plataformas, fetch/ffmpeg para enlaces directos).
 * Devuelve el título detectado si está disponible.
 */
export async function downloadVideoFromUrl(
  sourceUrl: string,
  outPath: string,
  options?: {
    cookiesText?: string;
    onTitleDetected?: (title: string) => void;
  },
): Promise<{ title?: string }> {
  const dir = path.dirname(outPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(outPath)) fs.unlinkSync(outPath);

  if (VIDEO_PLATFORMS.test(sourceUrl)) {
    const { cmd, prefixArgs } = resolveYtDlpCommand();
    const isYoutube = YOUTUBE_URL_RE.test(sourceUrl);
    const { cookiePath, cleanup } = resolveCookiesFile(options?.cookiesText);

    try {
      let title = await fetchYoutubeOEmbedTitle(sourceUrl);
      if (title) {
        options?.onTitleDetected?.(title);
      }

      const cookieArgs = cookiePath ? ['--cookies', cookiePath] : [];
      const runtimeArgs = isYoutube ? ['--js-runtimes', 'node'] : [];

      if (!title) {
        try {
          const info = await runExecFile(
            cmd,
            [
              ...prefixArgs,
              '--no-playlist',
              '--no-warnings',
              ...runtimeArgs,
              ...cookieArgs,
              '--print',
              'title',
              '--',
              sourceUrl,
            ],
            25_000,
          );
          const t = info.stdout.trim().split('\n')[0]?.trim();
          if (t) {
            title = t.slice(0, 140);
            options?.onTitleDetected?.(title);
          }
        } catch {
          /* ignore title probe errors */
        }
      }

      const strategies: string[][] = isYoutube
        ? cookiePath
          ? [
              [],
              ['--extractor-args', 'youtube:player_client=web,default'],
              ['--extractor-args', 'youtube:player_client=tv,web_embedded'],
            ]
          : [
              [],
              ['--extractor-args', 'youtube:player_client=tv,android_vr'],
              ['--extractor-args', 'youtube:player_client=ios,android'],
              ['--extractor-args', 'youtube:player_client=mweb,web_safari'],
            ]
        : [[], ['--impersonate', 'chrome']];

      let lastError: Error | null = null;

      for (const extraArgs of strategies) {
        if (fs.existsSync(outPath)) {
          try {
            fs.unlinkSync(outPath);
          } catch {
            /* ignore */
          }
        }

        try {
          await runExecFile(
            cmd,
            [
              ...prefixArgs,
              '--no-playlist',
              '--no-warnings',
              '--socket-timeout',
              '25',
              ...runtimeArgs,
              ...cookieArgs,
              ...extraArgs,
              '-f',
              'bv*[vcodec~="^(avc|h264)"][height<=1080][ext=mp4]+ba/b[vcodec~="^(avc|h264)"][ext=mp4][format_id!=download]/bv*[height<=1080][ext=mp4]+ba/b[ext=mp4][format_id!=download]/b[ext=mp4]/bv*+ba/b',
              '--merge-output-format',
              'mp4',
              '-o',
              outPath,
              '--',
              sourceUrl,
            ],
            240_000,
          );
          lastError = null;
          break;
        } catch (err: any) {
          lastError = err instanceof Error ? err : new Error(String(err));
        }
      }

      if (lastError) {
        if (isYoutubeBotError(lastError.message)) {
          throw new Error(
            cookiePath
              ? 'YouTube rechazó las cookies proporcionadas o solicitó nueva verificación ("Sign in to confirm you’re not a bot"). Exporta cookies frescas de youtube.com en formato Netscape (.txt) o sube el archivo MP4 directamente.'
              : 'YouTube bloqueó la descarga automática desde la IP del servidor ("Sign in to confirm you’re not a bot"). Solución: abre "Opciones avanzadas" y pega o sube tus cookies de YouTube (cookies.txt en formato Netscape), configura YOUTUBE_COOKIES en el servidor, o sube el video MP4 directamente.',
          );
        }
        throw lastError;
      }

      if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
        throw new Error('yt-dlp finalizó sin generar el archivo de video');
      }
      return { title };
    } finally {
      cleanup();
    }
  }

  // URL directa (MP4, WebM, MOV, HLS m3u8...)
  if (/\.m3u8(\?|$)/i.test(sourceUrl)) {
    await runExecFile(
      'ffmpeg',
      ['-y', '-i', sourceUrl, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', outPath],
      240_000,
    );
  } else {
    const res = await fetch(sourceUrl, { redirect: 'follow' });
    if (!res.ok) {
      throw new Error(`No se pudo descargar el enlace (HTTP ${res.status})`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) {
      throw new Error('El archivo descargado está vacío');
    }
    fs.writeFileSync(outPath, buf);
  }

  if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
    throw new Error('No se pudo guardar el video descargado');
  }
  return {};
}

export async function probeVideoDuration(filePath: string): Promise<number> {
  const { stdout } = await runExecFile(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      filePath,
    ],
    20_000,
  );
  const val = parseFloat(stdout.trim());
  return Number.isFinite(val) ? Math.max(0, Math.round(val)) : 0;
}

export async function analyzeVideoLoudness(
  filePath: string,
): Promise<LoudnessSample[]> {
  const { stderr } = await runExecFile(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostats',
      '-i',
      filePath,
      '-vn',
      '-af',
      'ebur128',
      '-f',
      'null',
      '-',
    ],
    90_000,
  ).catch((err) => ({ stdout: '', stderr: String(err.message || '') }));

  const samples: LoudnessSample[] = [];
  for (const line of stderr.split('\n')) {
    const match = line.match(/t:\s*([\d.]+).*?M:\s*(-?[\d.]+)/);
    if (!match) continue;
    const time = parseFloat(match[1]);
    const loudness = parseFloat(match[2]);
    if (Number.isFinite(time) && Number.isFinite(loudness)) {
      samples.push({ time, loudness });
    }
  }
  return samples;
}

export async function analyzeVideoScenes(filePath: string): Promise<number[]> {
  const { stderr } = await runExecFile(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostats',
      '-skip_frame',
      'nokey',
      '-i',
      filePath,
      '-vf',
      "scale=320:-2,select='gt(scene,0.3)',showinfo",
      '-an',
      '-f',
      'null',
      '-',
    ],
    90_000,
  ).catch((err) => ({ stdout: '', stderr: String(err.message || '') }));

  const times = new Set<number>();
  for (const line of stderr.split('\n')) {
    const match = line.match(/pts_time:([\d.]+)/);
    if (!match) continue;
    const t = parseFloat(match[1]);
    if (Number.isFinite(t)) times.add(Math.round(t * 10) / 10);
  }
  return [...times];
}

export function pickAudioSceneHighlights(
  samples: LoudnessSample[],
  sceneTimes: number[],
  duration: number,
  clipDuration: number,
  maxClips = 4,
): Highlight[] {
  if (duration <= 0) return [{ start: 0, score: 0.75 }];
  if (duration <= clipDuration) return [{ start: 0, score: 0.85 }];

  const targetClips = Math.max(
    1,
    Math.min(maxClips, Math.floor(duration / Math.max(20, clipDuration))),
  );
  const minSpacing = Math.max(10, clipDuration);
  const maxStart = Math.max(0, duration - clipDuration);

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

  const cutsBySecond = new Map<number, number>();
  for (const t of sceneTimes) {
    const sec = Math.floor(t);
    cutsBySecond.set(sec, (cutsBySecond.get(sec) ?? 0) + 1);
  }

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
    const actionScore = Math.min(cuts / 4, 1);
    candidates.push({
      start,
      score: audioScore * 0.5 + speechScore * 0.3 + actionScore * 0.2,
    });
  }

  const best = candidates.reduce((m, c) => Math.max(m, c.score), 0);
  if (best < 0.05) {
    const regular: Highlight[] = [];
    const step = Math.max(clipDuration, Math.floor(maxStart / Math.max(1, targetClips)));
    for (let t = 0; t <= maxStart && regular.length < targetClips; t += step) {
      regular.push({ start: t, score: 0.72 });
    }
    if (regular.length === 0) regular.push({ start: 0, score: 0.72 });
    return regular;
  }

  candidates.sort((a, b) => b.score - a.score);
  const chosen: Highlight[] = [];
  for (const c of candidates) {
    if (chosen.length >= targetClips) break;
    if (chosen.some((x) => Math.abs(x.start - c.start) < minSpacing)) continue;
    chosen.push(c);
  }
  return chosen.sort((a, b) => a.start - b.start);
}

/**
 * Corta y reencuadra un clip real con FFmpeg usando búsqueda rápida (-ss antes de -i).
 */
export async function cutClipWithFfmpeg(options: {
  sourcePath: string;
  outPath: string;
  startTime: number;
  duration: number;
  format: 'VERTICAL' | 'HORIZONTAL';
  layoutMode?: LayoutMode;
}): Promise<void> {
  const { sourcePath, outPath, startTime, duration, format, layoutMode = 'AUTO' } =
    options;

  const args: string[] = [
    '-y',
    '-ss',
    String(Math.max(0, startTime)),
    '-i',
    sourcePath,
    '-t',
    String(Math.max(1, duration)),
  ];

  if (format === 'VERTICAL') {
    if (layoutMode === 'BLUR_FILL') {
      args.push(
        '-filter_complex',
        '[0:v]split=2[bg][fg];[bg]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,boxblur=20:5[b];[fg]scale=720:-2[f];[b][f]overlay=(W-w)/2:(H-h)/2[v]',
        '-map',
        '[v]',
        '-map',
        '0:a?',
      );
    } else if (layoutMode === 'SPLIT') {
      args.push(
        '-filter_complex',
        '[0:v]split=2[left][right];[left]crop=iw/2:ih:0:0,scale=720:640:force_original_aspect_ratio=increase,crop=720:640[top];[right]crop=iw/2:ih:iw/2:0,scale=720:640:force_original_aspect_ratio=increase,crop=720:640[bot];[top][bot]vstack=inputs=2[v]',
        '-map',
        '[v]',
        '-map',
        '0:a?',
      );
    } else if (layoutMode === 'SCREENCAST') {
      args.push(
        '-filter_complex',
        '[0:v]split=2[scr][cam];[scr]scale=720:760:force_original_aspect_ratio=decrease,pad=720:760:(ow-iw)/2:(oh-ih)/2:black[top];[cam]scale=720:520:force_original_aspect_ratio=increase,crop=720:520[bot];[top][bot]vstack=inputs=2[v]',
        '-map',
        '[v]',
        '-map',
        '0:a?',
      );
    } else {
      args.push(
        '-vf',
        'scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280',
      );
    }
  } else {
    args.push('-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2');
  }

  args.push(
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    outPath,
  );

  await runExecFile('ffmpeg', args, 180_000);
  if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
    throw new Error('FFmpeg no pudo generar el archivo del clip');
  }
}

export function getClipTempPath(clipId: string): string {
  const safe = clipId.replace(/[^\w\-]+/g, '_');
  return path.join(os.tmpdir(), `streamlike-clip-${safe}.mp4`);
}
