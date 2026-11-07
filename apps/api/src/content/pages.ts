import { Body, Controller, Delete, Get, HttpCode, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Roles } from '../auth/decorators';
import { ListQuery, listPage, ToBoolean } from '../common/pagination';
import { RequestContext } from '../common/request-context';
import { slugify, uniqueSlug } from '../common/slug';
import { PrismaService } from '../prisma/prisma.service';

/** Policy pages every Indian store needs; created on demand with an empty body so the admin can fill them in. */
export const POLICY_PAGES = [
  { slug: 'privacy-policy', title: 'Privacy Policy' },
  { slug: 'terms-and-conditions', title: 'Terms and Conditions' },
  { slug: 'shipping-policy', title: 'Shipping Policy' },
  { slug: 'refund-and-returns', title: 'Refund and Returns Policy' },
  { slug: 'contact-us', title: 'Contact Us' },
] as const;

export class CreatePageDto {
  @IsString() @MinLength(1) @MaxLength(120) title!: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) slug?: string;
  @IsOptional() @IsString() @MaxLength(100_000) content?: string = '';
  @IsOptional() @IsBoolean() isPolicy?: boolean = false;
}
export class UpdatePageDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) title?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) slug?: string;
  @IsOptional() @IsString() @MaxLength(100_000) content?: string;
  @IsOptional() @IsBoolean() isPolicy?: boolean;
}
export class ListPagesQuery extends ListQuery {
  @IsOptional() @ToBoolean() @IsBoolean() policy?: boolean;
}

@Injectable()
export class PagesService {
  constructor(private readonly prisma: PrismaService) {}
  private get db() { return this.prisma.db; }

  list(q: ListPagesQuery) {
    const where = { ...(q.policy !== undefined ? { isPolicy: q.policy } : {}), ...(q.q ? { title: { contains: q.q, mode: 'insensitive' as const } } : {}) };
    return listPage(q, async (skip, take) => [
      await this.db.page.findMany({ where, orderBy: [{ isPolicy: 'desc' }, { title: 'asc' }], skip, take, select: { id: true, slug: true, title: true, isPolicy: true } }),
      await this.db.page.count({ where }),
    ]);
  }
  async get(id: string) {
    const p = await this.db.page.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Page not found');
    return p;
  }
  private slugFor(title: string, wanted?: string, excludeId?: string) {
    return uniqueSlug(slugify(wanted ?? title, 'page'), async (slug) => (await this.db.page.count({ where: { slug, ...(excludeId ? { id: { not: excludeId } } : {}) } })) > 0);
  }
  async create(dto: CreatePageDto) {
    return this.db.page.create({ data: { tenantId: RequestContext.tenantId()!, title: dto.title, slug: await this.slugFor(dto.title, dto.slug), content: dto.content ?? '', isPolicy: dto.isPolicy ?? false } });
  }
  async update(id: string, dto: UpdatePageDto) {
    const cur = await this.get(id);
    const data: any = { ...dto };
    if (dto.slug !== undefined) data.slug = await this.slugFor(dto.title ?? cur.title, dto.slug, id);
    return this.db.page.update({ where: { id }, data });
  }
  async remove(id: string) {
    await this.get(id);
    await this.db.page.delete({ where: { id } });
  }
  /** Make sure the standard policy pages exist (empty), returning all of them. */
  async ensurePolicyPages() {
    const have = new Set((await this.db.page.findMany({ where: { isPolicy: true }, select: { slug: true } })).map((p) => p.slug));
    const missing = POLICY_PAGES.filter((p) => !have.has(p.slug));
    if (missing.length) await this.db.page.createMany({ data: missing.map((p) => ({ tenantId: RequestContext.tenantId()!, slug: p.slug, title: p.title, content: '', isPolicy: true })) });
    return this.db.page.findMany({ where: { isPolicy: true }, orderBy: { title: 'asc' }, select: { id: true, slug: true, title: true, isPolicy: true, content: true } });
  }
}

@Roles('store_owner', 'staff')
@Controller('store/pages')
export class PagesController {
  constructor(private readonly pages: PagesService) {}
  @Get() list(@Query() q: ListPagesQuery) { return this.pages.list(q); }
  @Post() create(@Body() dto: CreatePageDto) { return this.pages.create(dto); }
  @Post('policies') @HttpCode(200) policies() { return this.pages.ensurePolicyPages(); }
  @Get(':id') get(@Param('id', ParseUUIDPipe) id: string) { return this.pages.get(id); }
  @Patch(':id') update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePageDto) { return this.pages.update(id, dto); }
  @Delete(':id') @HttpCode(204) async remove(@Param('id', ParseUUIDPipe) id: string) { await this.pages.remove(id); }
}

@Module({ controllers: [PagesController], providers: [PagesService], exports: [PagesService] })
export class PagesModule {}
