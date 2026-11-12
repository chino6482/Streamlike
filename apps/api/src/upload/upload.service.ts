import { Injectable, Inject, OnModuleInit, Logger } from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PresignDto } from './dto/presign.dto';
import { S3_CLIENT } from '../s3/s3.module';

@Injectable()
export class UploadService implements OnModuleInit {
  private readonly logger = new Logger(UploadService.name);

  constructor(@Inject(S3_CLIENT) private readonly s3Client: S3Client) {}

  /**
   * Garantiza que el bucket exista al arrancar (idempotente). Así no dependemos
   * de scripts de inicialización de LocalStack ni de crearlo a mano.
   */
  async onModuleInit() {
    const bucket = process.env.S3_BUCKET;
    if (!bucket) return;
    try {
      await this.s3Client.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
      try {
        await this.s3Client.send(new CreateBucketCommand({ Bucket: bucket }));
        this.logger.log(`Bucket S3 creado: ${bucket}`);
      } catch (err) {
        this.logger.warn(
          `No se pudo verificar/crear el bucket ${bucket}: ${(err as Error).message}`,
        );
      }
    }
  }

  async createPresignedUrl(dto: PresignDto) {
    const { fileName, contentType } = dto;
    const bucket = process.env.S3_BUCKET;
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: fileName,
      ContentType: contentType,
    });
    let url = await getSignedUrl(this.s3Client, command, { expiresIn: 3600 });
    // Reemplaza host interno de docker para que el navegador del usuario (host) pueda subir a LocalStack
    if (url.includes('localstack:4566')) {
      url = url.replace('localstack:4566', 'localhost:4566');
    }
    return { url, bucket, key: fileName };
  }
}
