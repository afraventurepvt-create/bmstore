import { AsyncLocalStorage } from 'node:async_hooks';

export type Role = 'superadmin' | 'store_owner' | 'staff';

/** Non-secret tenant fields only. This object is what gets cached in Redis. */
export interface TenantInfo {
  id: string;
  name: string;
  slug: string;
  subdomain: string;
  customDomain: string | null;
  plan: string;
  status: 'active' | 'suspended';
  gstNumber: string | null;
  address: string | null;
  supportPhone: string | null;
  whatsappNumber: string | null;
  expiresAt: string | null; // ISO
}

export interface AuthActor {
  id: string;
  role: Role;
  tenantId: string | null;
}

export interface BypassInfo {
  kind: 'superadmin' | 'system';
  actorId: string | null;
  reason: string;
}

export interface RequestStore {
  requestId: string;
  tenant?: TenantInfo;
  actor?: AuthActor;
  bypass?: BypassInfo;
}

const als = new AsyncLocalStorage<RequestStore>();

export const RequestContext = {
  run<T>(store: RequestStore, fn: () => T): T {
    return als.run(store, fn);
  },
  get(): RequestStore | undefined {
    return als.getStore();
  },
  tenantId(): string | undefined {
    return als.getStore()?.tenant?.id;
  },
};
