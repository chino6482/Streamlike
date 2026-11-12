import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { VideoModule } from './video/video.module';
import { UploadModule } from './upload/upload.module';
import { S3Module } from './s3/s3.module';
import { BullModule } from '@nestjs/bullmq';
import { parseRedisUrl } from './redis.config';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    BullModule.forRoot({
      connection: parseRedisUrl(process.env.REDIS_URL),
    }),
    S3Module,
    VideoModule,
    UploadModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
