import { Controller, Post, Body } from '@nestjs/common';
import { UploadService } from './upload.service';
import { PresignDto } from './dto/presign.dto';

@Controller('upload')
export class UploadController {
  constructor(private readonly uploadService: UploadService) {}

  @Post('presign')
  async getPresignUrl(@Body() presignDto: PresignDto) {
    return this.uploadService.createPresignedUrl(presignDto);
  }

  @Post('presigned')
  async getPresignedUrl(@Body() presignDto: PresignDto) {
    return this.uploadService.createPresignedUrl(presignDto);
  }
}
