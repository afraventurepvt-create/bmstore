import { Injectable, Module } from '@nestjs/common';
import { ImportImageResolver } from '../imports/product-import.service';
import { MediaController } from './media.controller';
import { MediaWorker } from './media-worker';
import { MediaQuotaGuard, MediaService, NoMediaQuota } from './media.service';

/** CSV import's image_filename lookup, backed by the media table. */
@Injectable()
export class MediaImageResolver extends ImportImageResolver {
  constructor(private readonly media: MediaService) { super(); }
  resolve(filenames: string[]) { return this.media.resolveFilenames(filenames); }
}

@Module({
  controllers: [MediaController],
  providers: [MediaService, MediaWorker, MediaImageResolver, { provide: MediaQuotaGuard, useClass: NoMediaQuota }],
  exports: [MediaService, MediaWorker, MediaImageResolver],
})
export class MediaModule {}
