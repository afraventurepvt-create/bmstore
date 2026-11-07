import { TenantPlan, TenantStatus } from '@prisma/client';

/** Plan limits. STARTER's cap counts DRAFT + ACTIVE products (archived ones free a slot); ALSO enforced by a DB trigger. */
export const PLAN_LIMITS: Record<TenantPlan, { maxProducts: number | null }> = {
  STARTER: { maxProducts: 10 },
  STANDARD: { maxProducts: null }, // unlimited within fair use
};

/** Error text raised by the trigger when the cap is hit. */
export const PLAN_LIMIT_ERROR = /plan_limit_exceeded/;

/**
 * Which tenant statuses answer requests on the store host at all.
 * BUILDING: the store is being set up; its admins can log in and work and the storefront is served as a PREVIEW
 * (X-Robots-Tag noindex, robots meta tag, ribbon: see preview.ts), so it is never indexed before go-live.
 */
export const SERVES_REQUESTS: Record<TenantStatus, boolean> = {
  BUILDING: true,
  LIVE: true,
  SUSPENDED: false,
  PARKED: false,
};

export const BLOCKED_MESSAGE: Partial<Record<TenantStatus, string>> = {
  SUSPENDED: 'Store suspended',
  PARKED: 'Store parked',
};
