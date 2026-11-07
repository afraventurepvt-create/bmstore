import { ForbiddenException, Injectable, NestMiddleware, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { RequestContext, RequestStore } from '../common/request-context';
import { TenantResolver } from './tenant-resolver.service';

/**
 * Resolves the tenant from the Host header (subdomain or custom domain), and runs the rest of the
 * request inside an AsyncLocalStorage context carrying that tenant.
 *  - platform host (root/admin/api/IP)  -> no tenant in context
 *  - unknown store host                 -> 404
 *  - suspended or expired store         -> 403
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(private readonly resolver: TenantResolver) {}

  use(req: Request, res: Response, next: NextFunction) {
    const requestId = randomUUID();
    res.setHeader('x-request-id', requestId);
    this.resolver
      .resolve(req.hostname)
      .then((r) => {
        const store: RequestStore = { requestId };
        if (r.kind === 'unknown') throw new NotFoundException('Store not found');
        if (r.kind === 'tenant') {
          const t = r.tenant;
          if (t.status !== 'active') throw new ForbiddenException('Store suspended');
          if (t.expiresAt && new Date(t.expiresAt) <= new Date()) throw new ForbiddenException('Store subscription expired');
          store.tenant = t;
          store.tenantId = t.id;
        }
        RequestContext.run(store, () => next());
      })
      .catch(next);
  }
}
