import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { AuthActor, Role } from '../common/request-context';

export const IS_PUBLIC = 'isPublic';
export const ROLES = 'roles';

/** Opt a route out of authentication. Everything else requires a valid access token AND an explicit @Roles(). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);
export const CurrentUser = createParamDecorator((_d: unknown, ctx: ExecutionContext): AuthActor => ctx.switchToHttp().getRequest().user);
