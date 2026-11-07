import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RequestContext, Role } from '../common/request-context';
import { AuthService } from './auth.service';
import { IS_PUBLIC, ROLES } from './decorators';

/** Global. Authenticates the bearer token and binds the user to the tenant resolved from Host. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly auth: AuthService) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];
    const [scheme, token] = header?.split(' ') ?? [];
    if (scheme?.toLowerCase() !== 'bearer' || !token) throw new UnauthorizedException();

    const actor = this.auth.verifyAccess(token);
    const store = RequestContext.get();
    if (actor.role !== 'superadmin') {
      // A store user's token is valid ONLY on its own store's host.
      if (!store?.tenantId || store.tenantId !== actor.tenantId) throw new ForbiddenException('Token not valid for this store');
    }
    req.user = actor;
    if (store) store.actor = actor;
    return true;
  }
}

/** Global. Fail-closed: a non-public route without @Roles() is denied, so a forgotten decorator can't open a route. */
@Injectable()
export class RolesGuard implements CanActivate {
  private readonly log = new Logger(RolesGuard.name);
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    const roles = this.reflector.getAllAndOverride<Role[]>(ROLES, [ctx.getHandler(), ctx.getClass()]);
    if (!roles?.length) {
      this.log.error(`Route ${ctx.getClass().name}.${ctx.getHandler().name} has no @Roles() and is not @Public(); denying`);
      throw new ForbiddenException();
    }
    const user = ctx.switchToHttp().getRequest().user;
    if (!user || !roles.includes(user.role)) throw new ForbiddenException('Insufficient role');
    return true;
  }
}
