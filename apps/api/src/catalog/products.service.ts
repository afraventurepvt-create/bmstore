import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RequestContext } from '../common/request-context';
import { listPage } from '../common/pagination';
import { slugify, uniqueSlug } from '../common/slug';
import { PrismaService } from '../prisma/prisma.service';
import { TenantLimitsService } from '../limits/limits';
import { PLAN_LIMITS } from '../tenancy/plans';
import { assertOwnMediaUrls } from './media-url';
import { BulkProductsDto, CreateProductDto, ListProductsQuery, StockDto, UpdateProductDto, UpdateVariantDto, VariantInput } from './products.dto';

const INCLUDE: Prisma.ProductInclude = { variants: { orderBy: [{ optionName: 'asc' }, { optionValue: 'asc' }] }, category: { select: { id: true, name: true, slug: true } } };

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService, private readonly limits: TenantLimitsService) {}
  private get db() { return this.prisma.db; }
  private tenantId() { return RequestContext.tenantId()!; }

  /** Friendly, early version of the database cap (the trigger remains the hard guarantee). */
  async assertCanAddLiveProducts(n: number) {
    if (n <= 0) return;
    const plan = RequestContext.get()?.tenant?.plan ?? (await this.db.tenant.findUniqueOrThrow({ where: { id: this.tenantId() }, select: { plan: true } })).plan;
    const max = PLAN_LIMITS[plan].maxProducts;
    if (max === null) return;
    const live = await this.db.product.count({ where: { status: { not: 'ARCHIVED' } } });
    if (live + n > max) {
      throw new ForbiddenException(`Your ${plan} plan allows ${max} live products (you have ${live}). Archive or delete some, or upgrade your plan.`);
    }
  }

  /** Friendly uniqueness errors (inside a transaction Prisma drops the P2002 field list, so we check first). */
  private async assertSkuFree(sku: string | null | undefined, excludeId?: string) {
    if (!sku) return;
    if (await this.db.product.count({ where: { sku, ...(excludeId ? { id: { not: excludeId } } : {}) } })) throw new ConflictException(`This SKU is already in use: ${sku}`);
  }
  private async assertVariantSkuFree(sku: string | null | undefined, excludeId?: string) {
    if (!sku) return;
    if (await this.db.variant.count({ where: { sku, ...(excludeId ? { id: { not: excludeId } } : {}) } })) throw new ConflictException(`This variant SKU is already in use: ${sku}`);
  }

  async slugFor(name: string, wanted?: string, excludeId?: string) {
    const base = slugify(wanted ?? name, 'product');
    return uniqueSlug(base, async (slug) => (await this.db.product.count({ where: { slug, ...(excludeId ? { id: { not: excludeId } } : {}) } })) > 0);
  }

  async list(q: ListProductsQuery) {
    const settings = q.lowStock ? await this.db.settings.findUnique({ where: { tenantId: this.tenantId() } }) : null;
    const where: Prisma.ProductWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.categoryId ? { categoryId: q.categoryId } : {}),
      ...(q.lowStock ? { status: 'ACTIVE', stock: { lte: settings?.lowStockThreshold ?? 5 } } : {}),
      ...(q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { sku: { contains: q.q, mode: 'insensitive' } }, { slug: { contains: q.q, mode: 'insensitive' } }] } : {}),
    };
    const orderBy: Prisma.ProductOrderByWithRelationInput =
      q.sort === 'name' ? { name: 'asc' } : q.sort === 'price' ? { price: 'asc' } : q.sort === 'stock' ? { stock: 'asc' } : { createdAt: 'desc' };
    return listPage(q, async (skip, take) => [
      await this.db.product.findMany({ where, orderBy, skip, take, include: INCLUDE }),
      await this.db.product.count({ where }),
    ]);
  }

  async get(id: string) {
    const p = await this.db.product.findUnique({ where: { id }, include: INCLUDE });
    if (!p) throw new NotFoundException('Product not found');
    return p;
  }

  async create(dto: CreateProductDto) {
    if (dto.mrp < dto.price) throw new BadRequestException('MRP cannot be lower than the selling price');
    assertOwnMediaUrls(this.tenantId(), dto.images);
    await this.limits.assertProductRoom(1);
    if (dto.status !== 'ARCHIVED') await this.assertCanAddLiveProducts(1);
    await this.assertSkuFree(dto.sku);
    for (const v of dto.variants ?? []) await this.assertVariantSkuFree(v.sku);
    const slug = await this.slugFor(dto.name, dto.slug);
    const { variants, ...rest } = dto;
    return this.db.product.create({
      data: { ...rest, tenantId: this.tenantId(), slug, sku: rest.sku || null, ...(variants?.length ? { variants: { create: variants.map(cleanVariant) } } : {}) },
      include: INCLUDE,
    });
  }

  async update(id: string, dto: UpdateProductDto) {
    const cur = await this.get(id);
    const price = dto.price ?? cur.price;
    const mrp = dto.mrp ?? cur.mrp;
    if (mrp < price) throw new BadRequestException('MRP cannot be lower than the selling price');
    if (dto.images) assertOwnMediaUrls(this.tenantId(), dto.images);
    if (dto.status && dto.status !== 'ARCHIVED' && cur.status === 'ARCHIVED') await this.assertCanAddLiveProducts(1);
    const data: Prisma.ProductUpdateInput = { ...dto };
    if (dto.slug !== undefined || (dto.name && !dto.slug && cur.slug.startsWith('product-'))) data.slug = await this.slugFor(dto.name ?? cur.name, dto.slug, id);
    if (dto.sku !== undefined) { await this.assertSkuFree(dto.sku, id); data.sku = dto.sku || null; }
    return this.db.product.update({ where: { id }, data, include: INCLUDE });
  }

  async setStock(id: string, dto: StockDto) {
    if (dto.stock === undefined && dto.delta === undefined) throw new BadRequestException('Send stock or delta');
    const cur = await this.get(id);
    const next = dto.stock ?? cur.stock + (dto.delta ?? 0);
    if (next < 0) throw new BadRequestException(`Stock cannot go below 0 (currently ${cur.stock})`);
    return this.db.product.update({ where: { id }, data: { stock: next }, include: INCLUDE });
  }

  async remove(id: string) {
    await this.get(id);
    await this.db.product.delete({ where: { id } });
  }

  async bulk(dto: BulkProductsDto) {
    const ids = [...new Set(dto.ids)];
    if (dto.action === 'DELETE') return { affected: (await this.db.product.deleteMany({ where: { id: { in: ids } } })).count };
    const status = dto.action === 'ACTIVATE' ? 'ACTIVE' : dto.action === 'DRAFT' ? 'DRAFT' : 'ARCHIVED';
    if (status !== 'ARCHIVED') {
      const reviving = await this.db.product.count({ where: { id: { in: ids }, status: 'ARCHIVED' } });
      await this.assertCanAddLiveProducts(reviving);
    }
    return { affected: (await this.db.product.updateMany({ where: { id: { in: ids } }, data: { status } })).count };
  }

  // ---- variants --------------------------------------------------------------------------------
  async addVariant(productId: string, dto: VariantInput) {
    await this.get(productId);
    await this.assertVariantSkuFree(dto.sku);
    if (await this.db.variant.count({ where: { productId, optionName: dto.optionName, optionValue: dto.optionValue } })) throw new ConflictException(`This product already has ${dto.optionName}: ${dto.optionValue}`);
    return this.db.variant.create({ data: { tenantId: this.tenantId(), productId, ...cleanVariant(dto) } });
  }

  async updateVariant(productId: string, id: string, dto: UpdateVariantDto) {
    const v = await this.db.variant.findFirst({ where: { id, productId } });
    if (!v) throw new NotFoundException('Variant not found');
    if (dto.sku !== undefined) await this.assertVariantSkuFree(dto.sku, id);
    return this.db.variant.update({ where: { id }, data: { ...dto, ...(dto.sku !== undefined ? { sku: dto.sku || null } : {}) } });
  }

  async setVariantStock(productId: string, id: string, dto: StockDto) {
    if (dto.stock === undefined && dto.delta === undefined) throw new BadRequestException('Send stock or delta');
    const v = await this.db.variant.findFirst({ where: { id, productId } });
    if (!v) throw new NotFoundException('Variant not found');
    const next = dto.stock ?? v.stock + (dto.delta ?? 0);
    if (next < 0) throw new BadRequestException(`Stock cannot go below 0 (currently ${v.stock})`);
    return this.db.variant.update({ where: { id }, data: { stock: next } });
  }

  async removeVariant(productId: string, id: string) {
    const r = await this.db.variant.deleteMany({ where: { id, productId } });
    if (r.count === 0) throw new NotFoundException('Variant not found');
  }
}

const cleanVariant = (v: VariantInput) => ({ optionName: v.optionName, optionValue: v.optionValue, priceDelta: v.priceDelta ?? 0, stock: v.stock ?? 0, sku: v.sku || null });
