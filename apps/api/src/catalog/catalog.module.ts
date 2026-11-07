import { Module } from '@nestjs/common';
import { LimitsModule } from '../limits/limits';
import { CategoriesController, CategoriesService } from './categories';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';

@Module({ imports: [LimitsModule], controllers: [ProductsController, CategoriesController], providers: [ProductsService, CategoriesService], exports: [ProductsService, CategoriesService] })
export class CatalogModule {}
