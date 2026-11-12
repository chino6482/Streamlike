import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsNumber,
  IsBoolean,
} from 'class-validator';

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
}
