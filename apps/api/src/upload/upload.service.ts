import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BadRequestException, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { sanitizeStorageKey, UnsafeUrlError } from '../common/ssrf-guard';
import { rewritePresignedS3Url } from '../s3/s3.config';
import { S3_CLIENT } from '../s3/s3.module';
import { PresignDto } from './dto/presign.dto';

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
    let safeKey: string;
    try {
      safeKey = sanitizeStorageKey(fileName);
    } catch (err) {
      if (err instanceof UnsafeUrlError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
    const bucket = process.env.S3_BUCKET;
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: safeKey,
      ContentType: contentType,
    });
    const rawUrl = await getSignedUrl(this.s3Client, command, { expiresIn: 3600 });
    const url = rewritePresignedS3Url(rawUrl);
    return { url, bucket, key: safeKey };
  }
}
