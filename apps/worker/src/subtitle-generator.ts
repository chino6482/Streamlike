import * as fs from 'fs';

export interface WordTimestamp {
  word: string;
  start: number;
  end: number;
}

export interface AssSubtitleOptions {
  transcript?: string | null;
  startTime: number;
  endTime: number;
  wordTimestamps?: WordTimestamp[];
  wordsPerBlock?: number;
  fontName?: string;
}

export interface SubtitleCue {
  start: number;
  end: number;
  text: string;
}

const DEFAULT_FONT_NAME = 'DejaVu Sans';

/**
 * Formatea segundos relativos (>= 0) al formato ASS `H:MM:SS.cc` (centésimas).
 */
export function formatAssTimestamp(seconds: number): string {
  const safeSeconds = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const totalCs = Math.round(safeSeconds * 100);
  const cs = totalCs % 100;
  const totalSec = Math.floor(totalCs / 100);
  const sec = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const min = totalMin % 60;
  const hrs = Math.floor(totalMin / 60);

  return `${hrs}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/**
 * Escapa caracteres especiales de eventos ASS.
 */
export function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r?\n/g, '\\N')
    .trim();
}

/**
 * Escapa una ruta de archivo para pasarla al filtro `ass=...` de FFmpeg (-vf / -filter_complex).
 */
export function escapeFfmpegFilterPath(filePath: string): string {
  return filePath
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/,/g, '\\,')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/;/g, '\\;');
}

/**
 * Divide una transcripción en bloques cortos de 3 a 4 palabras,
 * evitando bloques huérfanos de 1 palabra cuando hay suficientes palabras.
 */
export function splitTranscriptIntoBlocks(transcript: string, targetSize = 4): string[] {
  const words = transcript.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const blockSize = Math.max(3, Math.min(4, Math.round(targetSize)));
  const blocks: string[][] = [];

  for (let i = 0; i < words.length; i += blockSize) {
    blocks.push(words.slice(i, i + blockSize));
  }

  // Evitar un último bloque de solo 1 palabra si el anterior tiene 4 palabras (4+1 -> 3+2)
  if (blocks.length >= 2) {
    const last = blocks[blocks.length - 1];
    const prev = blocks[blocks.length - 2];
    if (last.length === 1 && prev.length >= 4) {
      const moved = prev.pop();
      if (moved) last.unshift(moved);
    }
  }

  return blocks.map((b) => b.join(' '));
}

/**
 * Construye los cues [start, end, text] relativos al inicio del clip (0 .. clipDuration).
 * Usa timestamps precisos por palabra si están disponibles; si no, sincroniza
 * proporcionalmente los bloques de 3–4 palabras según la duración del clip.
 */
export function buildSubtitleCues(options: AssSubtitleOptions): SubtitleCue[] {
  const clipDuration = Math.max(0.5, options.endTime - options.startTime);

  // 1. Soporte para timestamps precisos por palabra si se proveen
  if (Array.isArray(options.wordTimestamps) && options.wordTimestamps.length > 0) {
    const inside = options.wordTimestamps
      .map((w) => {
        // Detectar si vienen en tiempo absoluto del video o ya relativos al clip
        const isAbsolute = options.startTime > 0 && w.start >= options.startTime - 0.5;
        const relStart = isAbsolute ? w.start - options.startTime : w.start;
        const relEnd = isAbsolute ? w.end - options.startTime : w.end;
        return {
          word: String(w.word || '').trim(),
          start: Math.max(0, Math.min(clipDuration, relStart)),
          end: Math.max(0, Math.min(clipDuration, relEnd)),
        };
      })
      .filter((w) => w.word.length > 0 && w.end > w.start);

    if (inside.length > 0) {
      const blockSize = Math.max(3, Math.min(4, options.wordsPerBlock ?? 4));
      const cues: SubtitleCue[] = [];
      for (let i = 0; i < inside.length; i += blockSize) {
        const group = inside.slice(i, i + blockSize);
        const start = group[0].start;
        const end = Math.max(start + 0.25, group[group.length - 1].end);
        cues.push({
          start,
          end: Math.min(clipDuration, end),
          text: group.map((g) => g.word).join(' '),
        });
      }
      return cues;
    }
  }

  // 2. Sincronización proporcional con el transcript completo
  const transcript = (options.transcript || '').trim();
  if (!transcript) return [];

  const blocks = splitTranscriptIntoBlocks(transcript, options.wordsPerBlock ?? 4);
  if (blocks.length === 0) return [];

  const weights = blocks.map((block) => Math.max(4, block.replace(/\s+/g, '').length));
  const totalWeight = weights.reduce((acc, w) => acc + w, 0) || 1;

  const cues: SubtitleCue[] = [];
  let cursor = 0;

  for (let i = 0; i < blocks.length; i++) {
    const isLast = i === blocks.length - 1;
    const sliceDur = isLast
      ? Math.max(0.2, clipDuration - cursor)
      : (weights[i] / totalWeight) * clipDuration;
    const start = cursor;
    const end = isLast
      ? clipDuration
      : Math.min(clipDuration, Math.max(start + 0.2, start + sliceDur));

    cues.push({
      start,
      end,
      text: blocks[i],
    });
    cursor = end;
  }

  return cues;
}

/**
 * Genera el contenido completo de un archivo `.ass` (Advanced SubStation Alpha)
 * optimizado para video vertical 1080x1920 en el tercio inferior seguro (MarginV=380).
 */
export function generateAssContent(options: AssSubtitleOptions): string | null {
  const cues = buildSubtitleCues(options);
  if (cues.length === 0) return null;

  const fontName = options.fontName?.trim() || DEFAULT_FONT_NAME;

  const header = [
    '[Script Info]',
    'Title: Streamlike Dynamic Subtitles',
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    'PlayResX: 1080',
    'PlayResY: 1920',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: ViralBold,${fontName},68,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,2,2,60,60,380,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const events = cues.map((cue) => {
    const startStr = formatAssTimestamp(cue.start);
    const endStr = formatAssTimestamp(cue.end);
    const escaped = escapeAssText(cue.text);
    return `Dialogue: 0,${startStr},${endStr},ViralBold,,0,0,0,,${escaped}`;
  });

  return `${[...header, ...events].join('\n')}\n`;
}

/**
 * Escribe el archivo `.ass` en disco si hay transcript válido; devuelve la ruta o `null`.
 */
export async function writeAssSubtitleFile(
  options: AssSubtitleOptions,
  outAssPath: string,
): Promise<string | null> {
  const content = generateAssContent(options);
  if (!content) return null;
  await fs.promises.writeFile(outAssPath, content, 'utf8');
  return outAssPath;
}
