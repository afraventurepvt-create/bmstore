import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { Roles } from '../auth/decorators';
import { RequestContext } from '../common/request-context';
import { slugify, uniqueSlug } from '../common/slug';
import { PrismaService } from '../prisma/prisma.service';
import { assertOwnMediaUrls } from './media-url';

export class CreateCategoryDto {
  @IsString() @MinLength(1) @MaxLength(80) name!: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) slug?: string;
  @IsOptional() @IsUUID() parentId?: string | null;
  @IsOptional() @IsString() @MaxLength(500) image?: string | null;
}
export class UpdateCategoryDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) slug?: string;
  @IsOptional() @IsUUID() parentId?: string | null;
  @IsOptional() @IsString() @MaxLength(500) image?: string | null;
}

const MAX_DEPTH = 3;

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}
  private get db() { return this.prisma.db; }

  /** Flat list with product counts, plus a nested tree (parents first). */
  async list() {
    const rows = await this.db.category.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { products: true } } } });
    const byId = new Map(rows.map((c) => [c.id, { ...c, productCount: c._count.products, children: [] as any[] }]));
    const tree: any[] = [];
    for (const c of byId.values()) {
      if (c.parentId && byId.has(c.parentId)) byId.get(c.parentId)!.children.push(c);
      else tree.push(c);
    }
    return { items: [...byId.values()].map(({ children, _count, ...c }) => c), tree };
  }

  async get(id: string) {
    const c = await this.db.category.findUnique({ where: { id }, include: { children: true, _count: { select: { products: true } } } });
    if (!c) throw new NotFoundException('Category not found');
    return c;
  }

  private async depthOf(parentId: string | null | undefined): Promise<number> {
    let d = 0;
    let cur = parentId ?? null;
    while (cur) {
      const p = await this.db.category.findUnique({ where: { id: cur }, select: { parentId: true } });
      if (!p) throw new BadRequestException('Parent category not found');
      d++;
      if (d > MAX_DEPTH) break;
      cur = p.parentId;
    }
    return d;
  }

  private async slugFor(name: string, wanted?: string, excludeId?: string) {
    return uniqueSlug(slugify(wanted ?? name, 'category'), async (slug) => (await this.db.category.count({ where: { slug, ...(excludeId ? { id: { not: excludeId } } : {}) } })) > 0);
  }

  async create(dto: CreateCategoryDto) {
    if (dto.image) assertOwnMediaUrls(RequestContext.tenantId()!, [dto.image]);
    if ((await this.depthOf(dto.parentId)) >= MAX_DEPTH) throw new BadRequestException(`Categories can be nested at most ${MAX_DEPTH} levels deep`);
    return this.db.category.create({ data: { tenantId: RequestContext.tenantId()!, name: dto.name, slug: await this.slugFor(dto.name, dto.slug), parentId: dto.parentId ?? null, image: dto.image ?? null } });
  }

  async update(id: string, dto: UpdateCategoryDto) {
    const cur = await this.get(id);
    if (dto.image) assertOwnMediaUrls(RequestContext.tenantId()!, [dto.image]);
    if (dto.parentId !== undefined && dto.parentId !== cur.parentId) {
      if (dto.parentId === id) throw new BadRequestException('A category cannot be its own parent');
      // no cycles: the new parent must not be a descendant of this category
      let p = dto.parentId;
      while (p) {
        if (p === id) throw new BadRequestException('A category cannot be moved under one of its own sub-categories');
        p = (await this.db.category.findUnique({ where: { id: p }, select: { parentId: true } }))?.parentId ?? null;
      }
      if ((await this.depthOf(dto.parentId)) >= MAX_DEPTH) throw new BadRequestException(`Categories can be nested at most ${MAX_DEPTH} levels deep`);
    }
    const data: any = { ...dto };
    if (dto.slug !== undefined) data.slug = await this.slugFor(dto.name ?? cur.name, dto.slug, id);
    return this.db.category.update({ where: { id }, data });
  }

  async remove(id: string) {
    const c = await this.get(id);
    if (c.children.length) throw new ConflictException('Move or delete its sub-categories first');
    if (c._count.products) throw new ConflictException(`${c._count.products} product(s) are in this category. Move them first.`);
    await this.db.category.delete({ where: { id } });
  }
}

@Roles('store_owner', 'staff')
@Controller('store/categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}
  @Get() list() { return this.categories.list(); }
  @Post() create(@Body() dto: CreateCategoryDto) { return this.categories.create(dto); }
  @Get(':id') get(@Param('id', ParseUUIDPipe) id: string) { return this.categories.get(id); }
  @Patch(':id') update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCategoryDto) { return this.categories.update(id, dto); }
  @Delete(':id') @HttpCode(204) async remove(@Param('id', ParseUUIDPipe) id: string) { await this.categories.remove(id); }
}
