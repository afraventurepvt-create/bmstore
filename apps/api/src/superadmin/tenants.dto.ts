import { Transform, Type } from 'class-transformer';
import {
  IsBoolean, IsDateString, IsEmail, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested,
} from 'class-validator';

export const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export class OwnerDto {
  @IsEmail() @MaxLength(254) email!: string;
  @IsString() @MinLength(10) @MaxLength(200) password!: string;
  @IsOptional() @IsString() @MaxLength(20) phone?: string;
}

export class CreateTenantDto {
  @IsString() @MinLength(2) @MaxLength(120) name!: string;
  @Matches(LABEL_RE, { message: 'slug must be lowercase letters, digits and hyphens' }) slug!: string;
  @Matches(LABEL_RE, { message: 'subdomain must be lowercase letters, digits and hyphens' }) subdomain!: string;
  @IsOptional() @Matches(DOMAIN_RE, { message: 'customDomain must be a lowercase hostname' }) customDomain?: string;
  @IsOptional() @IsString() @MaxLength(40) plan?: string;
  @IsOptional() @IsString() @MaxLength(20) gstNumber?: string;
  @IsOptional() @IsString() @MaxLength(500) address?: string;
  @IsOptional() @IsString() @MaxLength(20) supportPhone?: string;
  @IsOptional() @IsString() @MaxLength(20) whatsappNumber?: string;
  @IsOptional() @IsDateString() expiresAt?: string;
  @ValidateNested() @Type(() => OwnerDto) owner!: OwnerDto;
}

export class ListTenantsQuery {
  @IsOptional() @IsIn(['active', 'suspended']) status?: 'active' | 'suspended';
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number = 20;
  @IsOptional() @Transform(({ value }) => value === true || value === 'true') @IsBoolean() expired?: boolean;
}

export class ReasonDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class SetExpiryDto {
  /** ISO date, or null for "never expires". */
  @ValidateIf((o) => o.expiresAt !== null) @IsDateString() expiresAt!: string | null;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
