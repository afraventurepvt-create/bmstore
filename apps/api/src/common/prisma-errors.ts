import { BadRequestException, ConflictException, ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PLAN_LIMIT_ERROR } from '../tenancy/plans';

const FIELD_LABELS: Record<string, string> = {
  slug: 'web address (slug)', sku: 'SKU', code: 'coupon code', phone: 'phone number', email: 'email', order_no: 'order number', orderNo: 'order number',
};

/**
 * Turn database errors into plain-language HTTP errors. Never echoes query arguments or row contents.
 * Returns null for anything that is not a known Prisma error (callers fall back to the generic 500 path).
 */
export function prismaToHttp(e: unknown): HttpException | null {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    // meta.target is null when the error happens inside a transaction (which, with the RLS pin, is always); fall back to the message
    const target = (e.meta as any)?.target ?? e.message.match(/fields: \(([^)]*)\)/)?.[1]?.replace(/`/g, '').split(',').map((s) => s.trim());
    const fields: string[] = Array.isArray(target) ? target : typeof target === 'string' ? [target] : [];
    const label = fields.filter((f) => f !== 'tenant_id' && f !== 'tenantId').map((f) => FIELD_LABELS[f] ?? f).join(', ');
    switch (e.code) {
      case 'P2002': return new ConflictException(label ? `This ${label} is already in use` : 'Already exists');
      case 'P2025': return new NotFoundException('Not found');
      case 'P2003': return new BadRequestException('A referenced record does not exist in this store');
      case 'P2000': return new BadRequestException('A value is too long');
      default: return null;
    }
  }
  if (e instanceof Prisma.PrismaClientUnknownRequestError || e instanceof Prisma.PrismaClientKnownRequestError) {
    const msg = String((e as Error).message ?? '');
    if (PLAN_LIMIT_ERROR.test(msg)) return new ForbiddenException('Your STARTER plan allows 10 live products. Archive or delete one, or upgrade your plan.');
    if (/violates check constraint/.test(msg)) return new BadRequestException('A value is out of range');
    if (/row-level security/.test(msg)) return new NotFoundException('Not found');
  }
  if (e instanceof Prisma.PrismaClientValidationError) return new BadRequestException('Invalid request');
  return null;
}
