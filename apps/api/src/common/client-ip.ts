import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/** Client IP as Express computes it: honours X-Forwarded-For only when TRUST_PROXY=1 (app.setup.ts). */
export const ClientIp = createParamDecorator((_d: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest();
  return String(req.ip ?? req.socket?.remoteAddress ?? 'unknown');
});
