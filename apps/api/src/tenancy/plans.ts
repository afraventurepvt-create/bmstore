import { TenantPlan, TenantStatus } from '@prisma/client';

/** Plan limits. STARTER's product cap is ALSO enforced by a database trigger (migration *_vocabulary_and_paise). */
export const PLAN_LIMITS: Record<TenantPlan, { maxProducts: number | null }> = {
  STARTER: { maxProducts: 10 },
  STANDARD: { maxProducts: null }, // unlimited within fair use
};

/** Error text raised by the trigger when the cap is hit. */
export const PLAN_LIMIT_ERROR = /plan_limit_exceeded/;

/**
 * Which tenant statuses answer requests on the store host at all.
 * BUILDING: the store is being set up; its admins can log in and work. The public storefront, when it lands, must
 * additionally check status === LIVE before rendering for shoppers.
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
