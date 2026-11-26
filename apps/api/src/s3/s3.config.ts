import type { S3ClientConfig } from '@aws-sdk/client-s3';

/**
 * Construye la configuración de `@aws-sdk/client-s3` compatible sin cambios con:
 * - LocalStack (desarrollo local)
 * - Cloudflare R2 (`AWS_REGION=auto`, endpoint `https://<account>.r2.cloudflarestorage.com`)
 * - Supabase Storage S3 (`https://<project>.supabase.co/storage/v1/s3`)
 * - AWS S3 estándar
 */
export function resolveS3ClientConfig(
  env: Record<string, string | undefined> = process.env,
): S3ClientConfig {
  const endpoint = env.S3_ENDPOINT?.trim() || undefined;
  const region = env.AWS_REGION?.trim() || 'auto';
  const forcePathStyle =
    env.S3_FORCE_PATH_STYLE?.trim().toLowerCase() === 'false' ? false : true;

  return {
    region,
    ...(endpoint ? { endpoint } : {}),
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID?.trim() || '',
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY?.trim() || '',
    },
    forcePathStyle,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  };
}

/**
 * Reescribe el host interno de Docker (`localstack:4566`) a `localhost:4566` en URLs
 * prefirmadas para que el navegador pueda subir/descargar directamente en local,
 * sin alterar URLs de Cloudflare R2, Supabase Storage o AWS S3.
 */
export function rewritePresignedS3Url(url: string): string {
  if (!url) return url;
  if (url.includes('localstack:4566')) {
    return url.replace('localstack:4566', 'localhost:4566');
  }
  return url;
}
