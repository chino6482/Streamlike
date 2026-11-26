import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsNumber,
  IsBoolean,
  IsInt,
  Min,
  Max,
} from 'class-validator';

export const DEFAULT_LIVE_DURATION_MINUTES = 30;
export const MIN_LIVE_DURATION_MINUTES = 5;
export const MAX_LIVE_DURATION_MINUTES = 120;

export function normalizeLiveDurationMinutes(raw?: number | null): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return DEFAULT_LIVE_DURATION_MINUTES;
  }
  return Math.max(
    MIN_LIVE_DURATION_MINUTES,
    Math.min(MAX_LIVE_DURATION_MINUTES, Math.round(raw)),
  );
}

export class CreateVideoDto {
  @IsNotEmpty()
  @IsString()
  title: string;

  @IsNotEmpty()
  @IsString()
  s3Key: string;

  @IsOptional()
  @IsNumber()
  duration?: number;

  @IsOptional()
  @IsString()
  userId?: string;

  /**
   * URL directa del video (p. ej. enlace a un MP4 o a YouTube/TikTok). Si se
   * indica, el worker descarga el video desde esa URL y genera los clips (no
   * requiere subida previa).
   */
  @IsOptional()
  @IsString()
  sourceUrl?: string;

  /**
   * Si es `true`, el worker guarda además el video COMPLETO en S3 para que se
   * pueda descargar desde la web (no solo los clips).
   */
  @IsOptional()
  @IsBoolean()
  keepOriginal?: boolean;

  /** Duración objetivo por clip en segundos (15, 30, 45 o 60). */
  @IsOptional()
  @IsNumber()
  clipDuration?: number;

  /** Modo de reencuadre 9:16 inspirado en OpenShorts (AUTO, VERTICAL_CROP, BLUR_FILL, SPLIT, SCREENCAST). */
  @IsOptional()
  @IsString()
  layoutMode?: string;

  /** Temática / contexto opcional para guiar títulos y hooks virales. */
  @IsOptional()
  @IsString()
  topicHint?: string;

  /** Habilita Auto-Reframe facial dinámico en formato vertical 9:16 (por defecto true). */
  @IsOptional()
  @IsBoolean()
  autoReframe?: boolean;

  /** Habilita captura en vivo (YouTube Live, Twitch, Kick, TikTok Live), máximo 1 activa a la vez. */
  @IsOptional()
  @IsBoolean()
  isLiveCapture?: boolean;

  /** Límite máximo de captura en vivo en minutos (entre 5 y 120, por defecto 30). */
  @IsOptional()
  @IsInt()
  @Min(MIN_LIVE_DURATION_MINUTES)
  @Max(MAX_LIVE_DURATION_MINUTES)
  liveDurationMinutes?: number;
}

/**
 * Contexto efímero de ejecución derivado de cabeceras HTTP (no se persiste en BD).
 */
export interface VideoProcessingContext {
  geminiApiKey?: string;
}

export function sanitizeGeminiHeaderKey(
  rawHeader?: string | string[],
): string | undefined {
  const raw = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (typeof raw !== 'string') return undefined;
  const cleaned = raw.replace(/[\r\n\0]/g, '').trim();
  if (!cleaned || cleaned.length > 512) return undefined;
  return cleaned;
}
