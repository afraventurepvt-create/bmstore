import { ProductStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateNested,
} from 'class-validator';
import { ListQuery, ToBoolean } from '../common/pagination';

export class VariantInput {
  @IsString() @MinLength(1) @MaxLength(40) optionName!: string;
  @IsString() @MinLength(1) @MaxLength(80) optionValue!: string;
  /** paise, may be negative */
  @IsOptional() @IsInt() @Min(-100_000_000) @Max(100_000_000) priceDelta?: number = 0;
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000) stock?: number = 0;
  @IsOptional() @IsString() @MaxLength(60) sku?: string | null;
}

export class UpdateVariantDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(40) optionName?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) optionValue?: string;
  @IsOptional() @IsInt() @Min(-100_000_000) @Max(100_000_000) priceDelta?: number;
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000) stock?: number;
  @IsOptional() @IsString() @MaxLength(60) sku?: string | null;
}

export class CreateProductDto {
  @IsString() @MinLength(1) @MaxLength(200) name!: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) slug?: string;
  @IsOptional() @IsString() @MaxLength(5000) description?: string | null;
  /** paise */
  @IsInt() @Min(0) @Max(2_000_000_000) price!: number;
  /** paise */
  @IsInt() @Min(0) @Max(2_000_000_000) mrp!: number;
  @IsOptional() @IsString() @MaxLength(60) sku?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000) stock?: number = 0;
  @IsOptional() @IsEnum(ProductStatus) status?: ProductStatus = 'DRAFT';
  @IsOptional() @IsUUID() categoryId?: string | null;
  /** Public URLs of this store's media (validated against the tenant's media prefix). */
  @IsOptional() @IsArray() @ArrayMaxSize(12) @IsString({ each: true }) @MaxLength(500, { each: true }) images?: string[] = [];
  @IsOptional() @IsString() @MaxLength(8) hsnCode?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => VariantInput) variants?: VariantInput[];
}

export class UpdateProductDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) slug?: string;
  @IsOptional() @IsString() @MaxLength(5000) description?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(2_000_000_000) price?: number;
  @IsOptional() @IsInt() @Min(0) @Max(2_000_000_000) mrp?: number;
  @IsOptional() @IsString() @MaxLength(60) sku?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000) stock?: number;
  @IsOptional() @IsEnum(ProductStatus) status?: ProductStatus;
  @IsOptional() @IsUUID() categoryId?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(12) @IsString({ each: true }) @MaxLength(500, { each: true }) images?: string[];
  @IsOptional() @IsString() @MaxLength(8) hsnCode?: string | null;
}

export class StockDto {
  /** Absolute stock … */
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000) stock?: number;
  /** … or a delta (+received / −damaged). One of the two. */
  @IsOptional() @IsInt() @Min(-1_000_000) @Max(1_000_000) delta?: number;
}

export class ListProductsQuery extends ListQuery {
  @IsOptional() @IsEnum(ProductStatus) status?: ProductStatus;
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @ToBoolean() @IsBoolean() lowStock?: boolean;
  @IsOptional() @IsIn(['newest', 'name', 'price', 'stock']) sort?: 'newest' | 'name' | 'price' | 'stock' = 'newest';
}

export const BULK_ACTIONS = ['ACTIVATE', 'DRAFT', 'ARCHIVE', 'DELETE'] as const;
export class BulkProductsDto {
  @IsArray() @ArrayMaxSize(200) @IsUUID(undefined, { each: true }) ids!: string[];
  @IsIn(BULK_ACTIONS as unknown as string[]) action!: (typeof BULK_ACTIONS)[number];
}
