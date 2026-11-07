import { BadRequestException, Body, Controller, Get, Injectable, Module, Patch, Put } from '@nestjs/common';
import { Prisma, ShippingMode } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsHexColor, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested } from 'class-validator';
import { Roles } from '../auth/decorators';
import { RequestContext } from '../common/request-context';
import { assertOwnMediaUrls } from '../catalog/media-url';
import { PrismaService } from '../prisma/prisma.service';
import { TenantResolver } from '../tenancy/tenant-resolver.service';

export class CityRateDto {
  @IsString() @MinLength(1) @MaxLength(60) city!: string;
  /** paise */
  @IsInt() @Min(0) @Max(100_000_000) ratePaise!: number;
}
export class UpdateSettingsDto {
  @IsOptional() @IsEnum(ShippingMode) shippingMode?: ShippingMode;
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000) flatRate?: number;
  @ValidateIf((o) => o.freeAbove !== null) @IsOptional() @IsInt() @Min(0) @Max(2_000_000_000) freeAbove?: number | null;
  @IsOptional() @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => CityRateDto) cityRates?: CityRateDto[];
  @IsOptional() @IsBoolean() codEnabled?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000) codCharge?: number;
  @IsOptional() @Matches(/^[A-Z0-9]{2,6}$/, { message: 'orderPrefix: 2-6 capital letters or digits' }) orderPrefix?: string;
  @IsOptional() @IsInt() @Min(0) @Max(100_000) lowStockThreshold?: number;
}
export class UpdateThemeDto {
  @IsOptional() @IsString() @MaxLength(40) layoutVariant?: string;
  @IsOptional() @IsString() @MaxLength(40) paletteId?: string;
  @IsOptional() @IsHexColor() primaryColor?: string;
  @IsOptional() @IsHexColor() secondaryColor?: string;
  @IsOptional() @IsString() @MaxLength(40) fontPairId?: string;
  @IsOptional() @IsString() @MaxLength(40) headerStyle?: string;
  @IsOptional() @IsString() @MaxLength(40) cardStyle?: string;
  @ValidateIf((o) => o.logoUrl !== null) @IsOptional() @IsString() @MaxLength(500) logoUrl?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) @MaxLength(500, { each: true }) bannerUrls?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(30) homepageSections?: unknown[];
}
/** The store's own profile: the columns a tenant may edit about itself (plan/status/domains are superadmin-only). */
export class UpdateProfileDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @ValidateIf((o) => o.address !== null) @IsOptional() @IsString() @MaxLength(500) address?: string | null;
  @ValidateIf((o) => o.gstNumber !== null) @IsOptional() @Matches(/^[0-9A-Z]{15}$/, { message: 'GST number must be 15 characters' }) gstNumber?: string | null;
  @ValidateIf((o) => o.supportPhone !== null) @IsOptional() @Matches(/^\+?[0-9]{10,15}$/, { message: 'supportPhone: 10-15 digits' }) supportPhone?: string | null;
  @ValidateIf((o) => o.whatsappNumber !== null) @IsOptional() @Matches(/^\+?[0-9]{10,15}$/, { message: 'whatsappNumber: 10-15 digits' }) whatsappNumber?: string | null;
}

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService, private readonly resolver: TenantResolver) {}
  private get db() { return this.prisma.db; }
  private tid() { return RequestContext.tenantId()!; }

  getSettings() {
    return this.db.settings.upsert({ where: { tenantId: this.tid() }, create: { tenantId: this.tid() }, update: {} });
  }
  async updateSettings(dto: UpdateSettingsDto) {
    if (dto.shippingMode === 'FREE_ABOVE' || (dto.freeAbove === undefined && dto.shippingMode === undefined)) {
      const cur = await this.getSettings();
      const mode = dto.shippingMode ?? cur.shippingMode;
      const free = dto.freeAbove === undefined ? cur.freeAbove : dto.freeAbove;
      if (mode === 'FREE_ABOVE' && (free === null || free === undefined)) throw new BadRequestException('Set the order value above which shipping is free');
    }
    if (dto.cityRates) {
      const seen = new Set<string>();
      for (const c of dto.cityRates) {
        const k = c.city.trim().toLowerCase();
        if (seen.has(k)) throw new BadRequestException(`City listed twice: ${c.city}`);
        seen.add(k);
      }
    }
    const { cityRates, ...rest } = dto;
    const data: Prisma.SettingsUpdateInput = { ...rest, ...(cityRates ? { cityRates: cityRates.map((c) => ({ city: c.city.trim(), ratePaise: c.ratePaise })) as Prisma.InputJsonValue } : {}) };
    return this.db.settings.upsert({ where: { tenantId: this.tid() }, create: { ...(data as Prisma.SettingsUncheckedCreateInput), tenantId: this.tid() }, update: data });
  }

  getTheme() {
    return this.db.themeConfig.upsert({ where: { tenantId: this.tid() }, create: { tenantId: this.tid() }, update: {} });
  }
  updateTheme(dto: UpdateThemeDto) {
    assertOwnMediaUrls(this.tid(), [...(dto.logoUrl ? [dto.logoUrl] : []), ...(dto.bannerUrls ?? [])]);
    const { homepageSections, ...rest } = dto;
    const data: Prisma.ThemeConfigUpdateInput = { ...rest, ...(homepageSections ? { homepageSections: homepageSections as Prisma.InputJsonValue } : {}) };
    return this.db.themeConfig.upsert({ where: { tenantId: this.tid() }, create: { ...(data as Prisma.ThemeConfigUncheckedCreateInput), tenantId: this.tid() }, update: data });
  }

  async getProfile() {
    const t = await this.db.tenant.findUniqueOrThrow({ where: { id: this.tid() } });
    const { razorpayKeyEnc, razorpaySecretEnc, ...rest } = t;
    return { ...rest, razorpayConfigured: Boolean(razorpayKeyEnc && razorpaySecretEnc) };
  }
  async updateProfile(dto: UpdateProfileDto) {
    const t = await this.db.tenant.update({ where: { id: this.tid() }, data: dto });
    await this.resolver.invalidate(t); // the cached TenantInfo carries name/address/phones
    const { razorpayKeyEnc, razorpaySecretEnc, ...rest } = t;
    return { ...rest, razorpayConfigured: Boolean(razorpayKeyEnc && razorpaySecretEnc) };
  }
}

@Controller('store')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}
  @Roles('store_owner', 'staff') @Get('settings') getSettings() { return this.settings.getSettings(); }
  @Roles('store_owner') @Put('settings') updateSettings(@Body() dto: UpdateSettingsDto) { return this.settings.updateSettings(dto); }
  @Roles('store_owner', 'staff') @Get('theme') getTheme() { return this.settings.getTheme(); }
  @Roles('store_owner') @Put('theme') updateTheme(@Body() dto: UpdateThemeDto) { return this.settings.updateTheme(dto); }
  @Roles('store_owner', 'staff') @Get('profile') getProfile() { return this.settings.getProfile(); }
  @Roles('store_owner') @Patch('profile') updateProfile(@Body() dto: UpdateProfileDto) { return this.settings.updateProfile(dto); }
}

@Module({ controllers: [SettingsController], providers: [SettingsService], exports: [SettingsService] })
export class SettingsModule {}
