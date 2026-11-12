import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { VideoController } from './video.controller';
import { VideoService } from './video.service';
import { VideoGateway } from './video.gateway';
import { RedisService } from '../redis.service';
import { S3Module } from '../s3/s3.module';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'video-processing',
    }),
    S3Module,
  ],
  controllers: [VideoController],
  providers: [VideoService, VideoGateway, RedisService],
  exports: [VideoService],
})
export class VideoModule {}
