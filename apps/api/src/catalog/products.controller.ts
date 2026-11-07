import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Roles } from '../auth/decorators';
import { BulkProductsDto, CreateProductDto, ListProductsQuery, StockDto, UpdateProductDto, UpdateVariantDto, VariantInput } from './products.dto';
import { ProductsService } from './products.service';

/** Store admin: products and variants. Every query is tenant-scoped by the Prisma extension + RLS. */
@Roles('store_owner', 'staff')
@Controller('store/products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get() list(@Query() q: ListProductsQuery) { return this.products.list(q); }
  @Post() create(@Body() dto: CreateProductDto) { return this.products.create(dto); }
  @Post('bulk') @HttpCode(200) bulk(@Body() dto: BulkProductsDto) { return this.products.bulk(dto); }
  @Get(':id') get(@Param('id', ParseUUIDPipe) id: string) { return this.products.get(id); }
  @Patch(':id') update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProductDto) { return this.products.update(id, dto); }
  @Patch(':id/stock') stock(@Param('id', ParseUUIDPipe) id: string, @Body() dto: StockDto) { return this.products.setStock(id, dto); }
  @Delete(':id') @HttpCode(204) async remove(@Param('id', ParseUUIDPipe) id: string) { await this.products.remove(id); }

  @Post(':id/variants') addVariant(@Param('id', ParseUUIDPipe) id: string, @Body() dto: VariantInput) { return this.products.addVariant(id, dto); }
  @Patch(':id/variants/:vid') updateVariant(@Param('id', ParseUUIDPipe) id: string, @Param('vid', ParseUUIDPipe) vid: string, @Body() dto: UpdateVariantDto) {
    return this.products.updateVariant(id, vid, dto);
  }
  @Patch(':id/variants/:vid/stock') variantStock(@Param('id', ParseUUIDPipe) id: string, @Param('vid', ParseUUIDPipe) vid: string, @Body() dto: StockDto) {
    return this.products.setVariantStock(id, vid, dto);
  }
  @Delete(':id/variants/:vid') @HttpCode(204) async removeVariant(@Param('id', ParseUUIDPipe) id: string, @Param('vid', ParseUUIDPipe) vid: string) {
    await this.products.removeVariant(id, vid);
  }
}
