import type { S3ClientConfig } from '@aws-sdk/client-s3';

/**
 * Construye la configuración de `@aws-sdk/client-s3` compatible sin cambios con
 * LocalStack, Cloudflare R2 (`AWS_REGION=auto`) y Supabase Storage (`forcePathStyle: true`).
 */
export function resolveWorkerS3Config(
  env: Record<string, string | undefined> = process.env,
): S3ClientConfig {
  const endpoint = env.S3_ENDPOINT?.trim() || undefined;
  const region = env.AWS_REGION?.trim() || 'auto';
  const forcePathStyle = env.S3_FORCE_PATH_STYLE?.trim().toLowerCase() !== 'false';

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
 * Genera la URL pública final de un clip considerando:
 * - Cloudflare R2 public domain (`https://pub-xxx.r2.dev` / custom domain): raíz del bucket, sin duplicar `bucket`.
 * - Supabase Storage public URL (`https://xxx.supabase.co/storage/v1/object/public/<bucket>`): ya incluye `bucket`.
 * - LocalStack / S3 path-style (`http://localhost:4566`): incluye `/<bucket>/<key>`.
 */
export function buildPublicObjectUrl(params: {
  bucket: string;
  key: string;
  publicEndpoint?: string;
  s3Endpoint?: string;
}): string {
  const cleanKey = params.key.replace(/^\/+/, '');
  const cleanBucket = params.bucket.replace(/^\/+|\/+$/g, '');
  const explicitPublic = params.publicEndpoint?.trim().replace(/\/+$/, '');

  if (explicitPublic) {
    const isBucketRootDomain =
      /\.r2\.dev$/i.test(explicitPublic) ||
      /\/storage\/v1\/object\/public\/[^/]+$/i.test(explicitPublic) ||
      (cleanBucket.length > 0 && explicitPublic.endsWith(`/${cleanBucket}`));

    return isBucketRootDomain || !cleanBucket
      ? `${explicitPublic}/${cleanKey}`
      : `${explicitPublic}/${cleanBucket}/${cleanKey}`;
  }

  const derivedBase = (
    params.s3Endpoint?.trim().replace('localstack:4566', 'localhost:4566') ||
    'http://localhost:4566'
  ).replace(/\/+$/, '');

  return cleanBucket ? `${derivedBase}/${cleanBucket}/${cleanKey}` : `${derivedBase}/${cleanKey}`;
}
