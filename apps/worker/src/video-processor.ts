import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface FaceKeyframe {
  t: number;
  x: number;
}

export interface FaceTrackResult {
  hasFaces: boolean;
  keyframes: FaceKeyframe[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function formatNum(value: number): string {
  return Number(value.toFixed(4)).toString();
}

/**
 * Construye una expresión de coordenada horizontal normalizada `x(t)` interpolando
 * linealmente entre los keyframes, y la convierte en una expresión FFmpeg `X_EXPR`
 * acotada con `clip(..., 0, iw - ow)` para no salirse nunca de los bordes del video.
 */
export function buildFfmpegDynamicCropXExpr(keyframes: FaceKeyframe[]): string {
  const cleaned = keyframes
    .filter((k) => k && Number.isFinite(k.t) && Number.isFinite(k.x) && k.t >= 0)
    .map((k) => ({
      t: Number(k.t.toFixed(3)),
      x: clamp(k.x, 0, 1),
    }))
    .sort((a, b) => a.t - b.t);

  // Deduplicar timestamps idénticos quedándose con el último valor suavizado
  const unique: FaceKeyframe[] = [];
  for (const kf of cleaned) {
    if (unique.length > 0 && Math.abs(unique[unique.length - 1].t - kf.t) < 0.01) {
      unique[unique.length - 1] = kf;
    } else {
      unique.push(kf);
    }
  }

  if (unique.length === 0) {
    return '(iw-ow)/2';
  }

  if (unique.length === 1) {
    return `clip(iw*${formatNum(unique[0].x)}-ow/2,0,iw-ow)`;
  }

  // Construir árbol piecewise-linear desde el último tramo hacia el primero
  let normExpr = formatNum(unique[unique.length - 1].x);

  for (let i = unique.length - 2; i >= 0; i--) {
    const p0 = unique[i];
    const p1 = unique[i + 1];
    const dt = p1.t - p0.t;
    const dx = p1.x - p0.x;

    let segExpr: string;
    if (dt <= 0.001 || Math.abs(dx) < 0.0005) {
      segExpr = formatNum(p0.x);
    } else {
      const slope = dx / dt;
      const sign = slope >= 0 ? '+' : '-';
      const absSlope = formatNum(Math.abs(slope));
      const t0Str = formatNum(p0.t);
      const tDiff = p0.t === 0 ? 't' : `(t-${t0Str})`;
      segExpr = `(${formatNum(p0.x)}${sign}${absSlope}*${tDiff})`;
    }

    normExpr = `if(lt(t,${formatNum(p1.t)}),${segExpr},${normExpr})`;
  }

  if (unique[0].t > 0.05) {
    normExpr = `if(lt(t,${formatNum(unique[0].t)}),${formatNum(unique[0].x)},${normExpr})`;
  }

  return `clip(iw*(${normExpr})-ow/2,0,iw-ow)`;
}

/**
 * Construye la lista de filtros FFmpeg para Auto-Reframe 9:16 dinámico a partir de un
 * resultado ya analizado de `face_tracker.py`. Devuelve `null` si no hay rostros.
 */
export function buildDynamicCropFiltersFromTrack(
  track: FaceTrackResult | null | undefined,
  width = 1080,
  height = 1920,
): string[] | null {
  if (!track?.hasFaces || !Array.isArray(track.keyframes) || track.keyframes.length === 0) {
    return null;
  }

  const xExpr = buildFfmpegDynamicCropXExpr(track.keyframes);
  return [
    `crop=w='min(iw,ih*9/16)':h=ih:x='${xExpr}':y=0`,
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}`,
  ];
}

function resolvePythonBinary(): string {
  const configured = process.env.FACE_TRACKER_PYTHON?.trim();
  if (configured) return configured;
  if (fs.existsSync('/opt/venv/bin/python3')) {
    return '/opt/venv/bin/python3';
  }
  return 'python3';
}

function resolveFaceTrackerScript(): string {
  const fromBuild = path.resolve(__dirname, '../scripts/face_tracker.py');
  if (fs.existsSync(fromBuild)) return fromBuild;
  return path.resolve(process.cwd(), 'apps/worker/scripts/face_tracker.py');
}

/**
 * Ejecuta `face_tracker.py` sobre [startTime, endTime] y devuelve los filtros
 * FFmpeg de reencuadre dinámico (`crop=...` interpolado + `scale=width:height`),
 * o `null` si no hay rostros en escena o el tracker falla (fallback seguro).
 */
export async function buildDynamicCropFilter(
  videoPath: string,
  startTime: number,
  endTime: number,
  width = 1080,
  height = 1920,
): Promise<string[] | null> {
  const scriptPath = resolveFaceTrackerScript();
  if (!fs.existsSync(scriptPath)) {
    return null;
  }

  const pythonBin = resolvePythonBinary();

  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        pythonBin,
        [scriptPath, videoPath, String(startTime), String(endTime)],
        {
          timeout: 15_000,
          maxBuffer: 1024 * 1024 * 4,
        },
        (err, out, stderr) => {
          if (err) {
            reject(new Error(stderr || err.message));
          } else {
            resolve(out);
          }
        },
      );
    });

    const trimmed = stdout.trim();
    if (!trimmed) return null;
    const lastLine = trimmed.split(/\r?\n/).pop() || trimmed;
    const parsed = JSON.parse(lastLine) as FaceTrackResult;
    return buildDynamicCropFiltersFromTrack(parsed, width, height);
  } catch (err: any) {
    console.warn(
      `[VideoProcessor] Auto-reframe facial omitido (fallback a encuadre estándar): ${err?.message || err}`,
    );
    return null;
  }
}
