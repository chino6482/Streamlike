import { GoogleGenAI, Type, createPartFromUri } from '@google/genai';
import ffmpeg from 'fluent-ffmpeg';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ffmpegPath = require('ffmpeg-static');
  if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
} catch {
  /* usa ffmpeg del PATH */
}

export const GEMINI_MODEL = 'gemini-3-flash-preview';
export const MAX_VIRAL_MOMENTS = 8;
export const MIN_CLIP_SECONDS = 20;
export const MAX_CLIP_SECONDS = 55;

export interface ViralMoment {
  startTime: number;
  endTime: number;
  title: string;
  viralScore: number;
  hookReason: string;
  transcript: string;
}

export interface AnalyzeVideoWithGeminiOptions {
  videoPath: string;
  duration: number;
  geminiApiKey?: string;
  topicHint?: string;
}

export function resolveGeminiApiKey(overrideKey?: string): string | null {
  const candidate = overrideKey?.trim() || process.env.GEMINI_API_KEY?.trim() || '';
  if (!candidate || candidate === 'MY_GEMINI_API_KEY') {
    return null;
  }
  return candidate;
}

/**
 * Normaliza, valida y ajusta los momentos devueltos por Gemini:
 * - Limita al rango [0, videoDuration]
 * - Asegura clips entre 20s y 55s cuando la duración del video lo permite
 * - Limita `viralScore` a entero 1..100
 * - Descarta duplicados con solapamiento > 50% (conservando el de mayor score)
 * - Devuelve hasta 8 clips ordenados cronológicamente
 */
export function normalizeViralMoments(
  raw: unknown,
  videoDuration: number,
  maxMoments = MAX_VIRAL_MOMENTS,
): ViralMoment[] {
  if (!Array.isArray(raw) || videoDuration <= 0) {
    return [];
  }

  const normalized: ViralMoment[] = [];
  const safeDuration = Math.max(1, videoDuration);

  for (let idx = 0; idx < raw.length; idx++) {
    const item = raw[idx];
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;

    const rawStart = Number(record.startTime);
    const rawEnd = Number(record.endTime);
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) continue;

    let startTime = Math.max(0, Math.min(rawStart, safeDuration - 1));
    let endTime = Math.max(startTime + 1, Math.min(rawEnd, safeDuration));

    if (safeDuration >= MIN_CLIP_SECONDS) {
      let clipLen = endTime - startTime;
      if (clipLen < MIN_CLIP_SECONDS) {
        endTime = Math.min(safeDuration, startTime + MIN_CLIP_SECONDS);
        clipLen = endTime - startTime;
        if (clipLen < MIN_CLIP_SECONDS) {
          startTime = Math.max(0, endTime - MIN_CLIP_SECONDS);
        }
      } else if (clipLen > MAX_CLIP_SECONDS) {
        endTime = startTime + MAX_CLIP_SECONDS;
      }
    } else {
      startTime = Math.max(0, Math.min(startTime, safeDuration - 1));
      endTime = Math.min(safeDuration, Math.max(startTime + 1, endTime));
    }

    startTime = Math.round(startTime * 10) / 10;
    endTime = Math.round(endTime * 10) / 10;
    if (endTime <= startTime) continue;

    const rawScore = Number(record.viralScore);
    const viralScore = Number.isFinite(rawScore)
      ? Math.max(1, Math.min(100, Math.round(rawScore)))
      : 70;

    const rawTitle = typeof record.title === 'string' ? record.title.trim() : '';
    const title = (rawTitle || `Momento viral #${idx + 1}`).slice(0, 120);

    const rawReason =
      typeof record.hookReason === 'string' ? record.hookReason.trim() : '';
    const hookReason = rawReason.slice(0, 500);

    const rawTranscript =
      typeof record.transcript === 'string' ? record.transcript.trim() : '';
    const transcript = rawTranscript.slice(0, 4000);

    normalized.push({
      startTime,
      endTime,
      title,
      viralScore,
      hookReason,
      transcript,
    });
  }

  // Seleccionar los de mayor viralScore evitando solapamientos > 50%
  normalized.sort((a, b) => b.viralScore - a.viralScore);
  const selected: ViralMoment[] = [];
  for (const candidate of normalized) {
    if (selected.length >= maxMoments) break;
    const overlapsSignificantly = selected.some((existing) => {
      const overlapStart = Math.max(existing.startTime, candidate.startTime);
      const overlapEnd = Math.min(existing.endTime, candidate.endTime);
      const overlap = Math.max(0, overlapEnd - overlapStart);
      const minLen = Math.min(
        existing.endTime - existing.startTime,
        candidate.endTime - candidate.startTime,
      );
      return minLen > 0 && overlap / minLen > 0.5;
    });
    if (!overlapsSignificantly) {
      selected.push(candidate);
    }
  }

  return selected.sort((a, b) => a.startTime - b.startTime);
}

/**
 * Extrae una pista de audio ligera (.mp3 mono a 16kHz / 32kbps) para subirla
 * rápidamente a la File API de Gemini consumiendo el mínimo de tokens.
 */
export function extractLightAudioTrack(
  videoPath: string,
  outAudioPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .noVideo()
      .audioChannels(1)
      .audioFrequency(16000)
      .audioBitrate('32k')
      .format('mp3')
      .output(outAudioPath)
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err))
      .run();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Analiza un video con Gemini 3 (`gemini-3-flash-preview`) usando su pista de audio
 * ligera subida mediante la File API de Gemini, devolviendo hasta 8 momentos virales
 * estructurados (20–55s) listos para recortar y guardar en Prisma.
 */
export async function analyzeVideoWithGemini(
  options: AnalyzeVideoWithGeminiOptions,
): Promise<ViralMoment[]> {
  const apiKey = resolveGeminiApiKey(options.geminiApiKey);
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY no configurada para análisis multimodal.');
  }

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  const tmpAudioPath = path.join(
    os.tmpdir(),
    `streamlike-gemini-${crypto.randomUUID()}.mp3`,
  );
  let uploadedFileName: string | null = null;

  try {
    await extractLightAudioTrack(options.videoPath, tmpAudioPath);

    let uploadedFile = await ai.files.upload({
      file: tmpAudioPath,
      config: {
        mimeType: 'audio/mpeg',
        displayName: path.basename(tmpAudioPath),
      },
    });
    uploadedFileName = uploadedFile.name ?? null;

    // Esperar activación del archivo en la File API si está procesándose
    const deadline = Date.now() + 60_000;
    while (uploadedFile.state === 'PROCESSING' && uploadedFileName) {
      if (Date.now() > deadline) {
        throw new Error('Tiempo de espera agotado procesando el audio en Gemini File API.');
      }
      await sleep(1500);
      uploadedFile = await ai.files.get({ name: uploadedFileName });
    }

    if (uploadedFile.state === 'FAILED') {
      throw new Error(
        uploadedFile.error?.message || 'Gemini File API falló al procesar el audio.',
      );
    }

    if (!uploadedFile.uri) {
      throw new Error('Gemini File API no devolvió URI para el archivo subido.');
    }

    const prompt = [
      'Eres un editor experto en retención viral para TikTok, YouTube Shorts e Instagram Reels.',
      `Analiza el audio completo del video (duración total: ${options.duration} segundos) e identifica hasta ${MAX_VIRAL_MOMENTS} momentos con mayor potencial viral.`,
      'Reglas estrictas para cada momento:',
      `- Cada clip debe durar entre ${MIN_CLIP_SECONDS} y ${MAX_CLIP_SECONDS} segundos (si el video dura menos de ${MIN_CLIP_SECONDS}s, ajústalo a la duración disponible) y terminar con un cierre natural de la idea o remate (sin cortar frases a la mitad).`,
      '- startTime y endTime deben ser números en segundos dentro de [0, duración total].',
      '- title: título gancho corto y llamativo para redes sociales (en el idioma del audio).',
      '- viralScore: puntuación entera de 1 a 100 según fuerza del gancho inicial, emoción, ritmo y cierre.',
      '- hookReason: explicación breve (1-2 frases) de por qué retiene audiencia.',
      '- transcript: transcripción exacta y fiel de lo que se dice en ese fragmento.',
      options.topicHint ? `Contexto o temática adicional: ${options.topicHint}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [
        createPartFromUri(
          uploadedFile.uri,
          uploadedFile.mimeType || 'audio/mpeg',
        ),
        prompt,
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              startTime: {
                type: Type.NUMBER,
                description: 'Inicio del clip en segundos.',
              },
              endTime: {
                type: Type.NUMBER,
                description: 'Fin del clip en segundos (20 a 55s después de startTime, con cierre natural).',
              },
              title: {
                type: Type.STRING,
                description: 'Título gancho corto para redes sociales.',
              },
              viralScore: {
                type: Type.INTEGER,
                description: 'Puntuación de viralidad de 1 a 100.',
              },
              hookReason: {
                type: Type.STRING,
                description: 'Explicación breve de por qué este momento retiene audiencia.',
              },
              transcript: {
                type: Type.STRING,
                description: 'Transcripción exacta de ese fragmento.',
              },
            },
            required: [
              'startTime',
              'endTime',
              'title',
              'viralScore',
              'hookReason',
              'transcript',
            ],
          },
        },
      },
    });

    const rawText = (response.text ?? '[]').trim();
    const parsed = JSON.parse(rawText);
    const moments = normalizeViralMoments(parsed, options.duration, MAX_VIRAL_MOMENTS);
    if (moments.length === 0) {
      throw new Error('Gemini no devolvió momentos virales válidos.');
    }
    return moments;
  } finally {
    if (uploadedFileName) {
      await ai.files.delete({ name: uploadedFileName }).catch((delErr) => {
        console.warn('[GeminiAnalyzer] No se pudo borrar archivo temporal de File API:', delErr?.message || delErr);
      });
    }
    if (fs.existsSync(tmpAudioPath)) {
      try {
        fs.unlinkSync(tmpAudioPath);
      } catch {
        /* ignorar error al limpiar tmpAudioPath */
      }
    }
  }
}
