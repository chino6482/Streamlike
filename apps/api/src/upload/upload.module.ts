import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { UploadController } from './upload.controller';
import { UploadService } from './upload.service';
import { S3Module } from '../s3/s3.module';

@Module({
  imports: [ConfigModule, S3Module],
  controllers: [UploadController],
  providers: [UploadService],
})
export class UploadModule {}
