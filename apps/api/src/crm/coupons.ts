import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { CouponType } from '@prisma/client';
import { IsDateString, IsEnum, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { Roles } from '../auth/decorators';
import { ListQuery, listPage } from '../common/pagination';
import { RequestContext } from '../common/request-context';
import { PrismaService } from '../prisma/prisma.service';

const CODE = /^[A-Za-z0-9_-]{3,30}$/; // stored upper-cased
export class CreateCouponDto {
  @Matches(CODE, { message: 'code: 3-30 letters, digits, - or _' }) code!: string;
  @IsEnum(CouponType) type!: CouponType;
  /** PERCENT: whole percent 1-100. FLAT: paise. */
  @IsInt() @Min(1) @Max(2_000_000_000) value!: number;
  /** paise */
  @IsOptional() @IsInt() @Min(0) @Max(2_000_000_000) minOrder?: number = 0;
  @IsOptional() @IsInt() @Min(1) @Max(1_000_000) usageLimit?: number | null;
  @ValidateIf((o) => o.expiresAt !== null) @IsOptional() @IsDateString() expiresAt?: string | null;
}
export class UpdateCouponDto {
  @IsOptional() @Matches(CODE, { message: 'code: 3-30 letters, digits, - or _' }) code?: string;
  @IsOptional() @IsEnum(CouponType) type?: CouponType;
  @IsOptional() @IsInt() @Min(1) @Max(2_000_000_000) value?: number;
  @IsOptional() @IsInt() @Min(0) @Max(2_000_000_000) minOrder?: number;
  @IsOptional() @IsInt() @Min(1) @Max(1_000_000) usageLimit?: number | null;
  @ValidateIf((o) => o.expiresAt !== null) @IsOptional() @IsDateString() expiresAt?: string | null;
}

function check(type: CouponType, value: number) {
  if (type === 'PERCENT' && value > 100) throw new BadRequestException('A percent discount cannot exceed 100');
}

@Injectable()
export class CouponsService {
  constructor(private readonly prisma: PrismaService) {}
  private get db() { return this.prisma.db; }

  list(q: ListQuery) {
    const where = q.q ? { code: { contains: q.q.toUpperCase() } } : {};
    return listPage(q, async (skip, take) => [
      (await this.db.coupon.findMany({ where, orderBy: { code: 'asc' }, skip, take })).map(present),
      await this.db.coupon.count({ where }),
    ]);
  }
  async get(id: string) {
    const c = await this.db.coupon.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('Coupon not found');
    return present(c);
  }
  async create(dto: CreateCouponDto) {
    check(dto.type, dto.value);
    if (await this.db.coupon.count({ where: { code: dto.code.toUpperCase() } })) throw new ConflictException('This coupon code is already in use');
    return present(await this.db.coupon.create({ data: { ...dto, tenantId: RequestContext.tenantId()!, code: dto.code.toUpperCase(), expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null } }));
  }
  async update(id: string, dto: UpdateCouponDto) {
    const cur = await this.get(id);
    check(dto.type ?? cur.type, dto.value ?? cur.value);
    return present(await this.db.coupon.update({ where: { id }, data: { ...dto, ...(dto.code ? { code: dto.code.toUpperCase() } : {}), ...(dto.expiresAt !== undefined ? { expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null } : {}) } }));
  }
  async remove(id: string) {
    await this.get(id);
    await this.db.coupon.delete({ where: { id } });
  }
}

const present = (c: any) => ({ ...c, expired: Boolean(c.expiresAt && c.expiresAt <= new Date()) });

@Roles('store_owner', 'staff')
@Controller('store/coupons')
export class CouponsController {
  constructor(private readonly coupons: CouponsService) {}
  @Get() list(@Query() q: ListQuery) { return this.coupons.list(q); }
  @Post() create(@Body() dto: CreateCouponDto) { return this.coupons.create(dto); }
  @Get(':id') get(@Param('id', ParseUUIDPipe) id: string) { return this.coupons.get(id); }
  @Patch(':id') update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCouponDto) { return this.coupons.update(id, dto); }
  @Delete(':id') @HttpCode(204) async remove(@Param('id', ParseUUIDPipe) id: string) { await this.coupons.remove(id); }
}

@Module({ controllers: [CouponsController], providers: [CouponsService] })
export class CouponsModule {}
