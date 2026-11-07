import { Injectable, Module } from '@nestjs/common';
import { ImportImageResolver } from '../imports/product-import.service';
import { LimitsModule, TenantLimitsService } from '../limits/limits';
import { MediaController } from './media.controller';
import { MediaWorker } from './media-worker';
import { MediaQuotaGuard, MediaService } from './media.service';

/** CSV import's image_filename lookup, backed by the media table. */
@Injectable()
export class MediaImageResolver extends ImportImageResolver {
  constructor(private readonly media: MediaService) { super(); }
  resolve(filenames: string[]) { return this.media.resolveFilenames(filenames); }
}

@Module({
  imports: [LimitsModule],
  controllers: [MediaController],
  providers: [MediaService, MediaWorker, MediaImageResolver, { provide: MediaQuotaGuard, useExisting: TenantLimitsService }],
  exports: [MediaService, MediaWorker, MediaImageResolver],
})
export class MediaModule {}
