import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { LimitsModule } from '../limits/limits';
import { MediaImageResolver, MediaModule } from '../media/media.module';
import { ImportController } from './import.controller';
import { ImportImageResolver, ProductImportService } from './product-import.service';

@Module({
  imports: [CatalogModule, MediaModule, LimitsModule],
  controllers: [ImportController],
  providers: [ProductImportService, { provide: ImportImageResolver, useExisting: MediaImageResolver }],
  exports: [ProductImportService],
})
export class ImportModule {}
