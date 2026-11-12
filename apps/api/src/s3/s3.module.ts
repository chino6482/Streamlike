import { Global, Module } from '@nestjs/common';
import { S3Client } from '@aws-sdk/client-s3';

/** Token de inyección del cliente S3 compartido. */
export const S3_CLIENT = 'S3_CLIENT';

/**
 * Crea el cliente S3 apuntando a LocalStack (o a S3 real si se cambian las
 * variables de entorno).
 *
 * Los flags `requestChecksumCalculation` / `responseChecksumValidation` en
 * `WHEN_REQUIRED` son obligatorios para que funcione contra LocalStack 2.3:
 * el SDK v3 reciente calcula checksums CRC32 por defecto y LocalStack responde
 * con un `x-amz-checksum-crc32` inválido.
 */
export function createS3Client(): S3Client {
  return new S3Client({
    region: process.env.AWS_REGION || 'us-east-1',
    endpoint: process.env.S3_ENDPOINT,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
    },
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
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
