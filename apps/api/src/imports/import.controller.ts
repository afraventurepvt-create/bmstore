import { BadRequestException, Body, Controller, Get, HttpCode, Post, Query, Req, Res } from '@nestjs/common';
import { ProductStatus } from '@prisma/client';
import { IsEnum, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Request, Response } from 'express';
import { Roles } from '../auth/decorators';
import { ToBoolean } from '../common/pagination';
import { buildTemplate } from './import-parse';
import { ProductImportService } from './product-import.service';

export class ImportQuery {
  @IsString() @MaxLength(200) filename!: string;
  @IsOptional() @ToBoolean() dryRun?: boolean;
  @IsOptional() @IsEnum(ProductStatus) status?: ProductStatus;
  @IsOptional() @IsIn(['create', 'upsert']) mode?: 'create' | 'upsert';
}

/**
 * POST /store/import/products?filename=products.csv[&dryRun=true][&status=DRAFT][&mode=upsert]
 * Body: the raw file bytes (Content-Type text/csv or the xlsx type). No multipart, no multer.
 */
@Roles('store_owner', 'staff')
@Controller('store/import')
export class ImportController {
  constructor(private readonly imports: ProductImportService) {}

  @Post('products') @HttpCode(200)
  importProducts(@Query() q: ImportQuery, @Req() req: Request, @Body() body: unknown) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.isBuffer(req.body) ? req.body : null;
    if (!buf || !buf.length) throw new BadRequestException('Send the file bytes as the request body with Content-Type text/csv or application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return this.imports.run(buf, { filename: q.filename, contentType: req.headers['content-type'], dryRun: q.dryRun, status: q.status, mode: q.mode });
  }

  @Get('products/template')
  async template(@Query('format') format: string | undefined, @Res() res: Response) {
    const f = format === 'xlsx' ? 'xlsx' : 'csv';
    const t = await buildTemplate(f);
    res.setHeader('Content-Type', t.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${t.filename}"`);
    res.send(t.body);
  }
}
