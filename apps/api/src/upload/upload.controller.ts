import { Body, Controller, Post } from '@nestjs/common';
import { PresignDto } from './dto/presign.dto';
import { UploadService } from './upload.service';

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
