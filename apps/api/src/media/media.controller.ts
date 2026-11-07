import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Roles } from '../auth/decorators';
import { MediaWorker } from './media-worker';
import { CompleteDto, ListMediaQuery, MediaService, PresignBatchDto } from './media.service';

/**
 * Bulk image uploads:
 *   1. POST /store/media/presign { files: [{ filename, contentType, size, kind }] } -> one presigned PUT per file
 *   2. the browser PUTs each file to its uploadUrl with exactly the returned headers
 *   3. POST /store/media/complete { ids } -> objects verified, queued for WebP conversion
 *   4. GET /store/media/:id until status is READY (url, thumbUrl)
 */
@Roles('store_owner', 'staff')
@Controller('store/media')
export class MediaController {
  constructor(private readonly media: MediaService, private readonly worker: MediaWorker) {}

  @Post('presign') @HttpCode(200) presign(@Body() dto: PresignBatchDto) { return this.media.presign(dto); }
  @Post('complete') @HttpCode(200) async complete(@Body() dto: CompleteDto) {
    const r = await this.media.complete(dto);
    if (r.results.some((x) => x.status === 'UPLOADED')) this.worker.poke();
    return r;
  }
  @Get() list(@Query() q: ListMediaQuery) { return this.media.list(q); }
  @Get(':id') get(@Param('id', ParseUUIDPipe) id: string) { return this.media.get(id); }
  @Delete(':id') @HttpCode(204) async remove(@Param('id', ParseUUIDPipe) id: string) { await this.media.remove(id); }
}
