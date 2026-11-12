import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  HttpCode,
} from '@nestjs/common';
import { VideoService } from './video.service';
import { CreateVideoDto } from './dto/create-video.dto';

@Controller('videos')
export class VideoController {
  constructor(private readonly videoService: VideoService) {}

  @Post()
  async create(@Body() dto: CreateVideoDto) {
    return this.videoService.create(dto);
  }

  @Get()
  async findAll() {
    return this.videoService.findAll();
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.videoService.findOne(id);
  }

  /**
   * URL prefirmada para descargar el video completo (no solo los clips).
   * Solo funciona si el video se procesó con la opción "guardar video completo".
   */
  @Get(':id/download')
  @HttpCode(200)
  async download(@Param('id') id: string) {
    return this.videoService.getDownloadUrl(id);
  }

  /** Elimina el video, sus clips y los objetos asociados en S3. */
  @Delete(':id')
  @HttpCode(200)
  async remove(@Param('id') id: string) {
    return this.videoService.remove(id);
  }
}
