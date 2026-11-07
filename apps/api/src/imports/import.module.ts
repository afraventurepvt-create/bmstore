import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { ImportController } from './import.controller';
import { ImportImageResolver, NoImageResolver, ProductImportService } from './product-import.service';

@Module({
  imports: [CatalogModule],
  controllers: [ImportController],
  providers: [ProductImportService, { provide: ImportImageResolver, useClass: NoImageResolver }],
  exports: [ProductImportService],
})
export class ImportModule {}
