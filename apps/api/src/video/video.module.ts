import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { RedisService } from '../redis.service';
import { S3Module } from '../s3/s3.module';
import { VideoController } from './video.controller';
import { VideoGateway } from './video.gateway';
import { VideoService } from './video.service';

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
