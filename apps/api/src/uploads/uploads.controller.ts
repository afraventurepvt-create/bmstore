import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { IsIn, IsInt, Min } from 'class-validator';
import { Roles } from '../auth/decorators';
import { IMAGE_TYPES, UPLOAD_KINDS, UploadKind, UploadsService } from './uploads.service';

class PresignDto {
  @IsIn(UPLOAD_KINDS as unknown as string[]) kind!: UploadKind;
  @IsIn(Object.keys(IMAGE_TYPES)) contentType!: string;
  @IsInt() @Min(1) size!: number;
}

/**
 * Direct-to-S3 uploads. The client asks for permission here, then PUTs the file to `uploadUrl` with exactly the
 * returned headers, and finally stores `key`/`publicUrl` on the product/category/theme through the normal API.
 */
@Controller('store/uploads')
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  @Roles('store_owner', 'staff') @Post('presign') @HttpCode(200)
  presign(@Body() dto: PresignDto) {
    return this.uploads.presign(dto);
  }
}
