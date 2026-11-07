import { BadRequestException } from '@nestjs/common';

/**
 * Image URLs stored on products / categories / theme must point at THIS tenant's media prefix. The object key
 * scheme is tenants/<tenantId>/… (uploads + media services), so a URL for another store's file is refused here
 * even before any storage check.
 */
export function assertOwnMediaUrls(tenantId: string, urls: readonly string[] | undefined | null) {
  for (const u of urls ?? []) {
    let path: string;
    try { path = new URL(u).pathname; } catch { throw new BadRequestException(`Not a valid image URL: ${u.slice(0, 80)}`); }
    if (!path.includes(`/tenants/${tenantId}/`)) throw new BadRequestException('Images must be uploaded to this store first');
  }
}
