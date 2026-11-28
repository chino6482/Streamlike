import { S3Client } from '@aws-sdk/client-s3';
import { Global, Module } from '@nestjs/common';
import { resolveS3ClientConfig } from './s3.config';

/** Token de inyección del cliente S3 compartido. */
export const S3_CLIENT = 'S3_CLIENT';

/**
 * Crea el cliente S3 apuntando a LocalStack, Cloudflare R2 (`AWS_REGION=auto`),
 * Supabase Storage (`/storage/v1/s3`) o AWS S3 estándar.
 */
export function createS3Client(): S3Client {
  return new S3Client(resolveS3ClientConfig());
}

/**
 * Módulo global que expone el cliente S3 a toda la aplicación (upload, video,
 * etc.) evitando duplicar la configuración en cada módulo.
 */
@Global()
@Module({
  providers: [{ provide: S3_CLIENT, useFactory: createS3Client }],
  exports: [S3_CLIENT],
})
export class S3Module {}
