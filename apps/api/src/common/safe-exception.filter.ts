import { ArgumentsHost, Catch, HttpException, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { RequestContext } from './request-context';

/**
 * Unknown errors (Prisma, driver, bugs) can carry request data in their message/stack - Prisma validation
 * errors embed the query arguments and Postgres errors embed the failing row. So we log ONLY the error class,
 * a code and the request id, and return a generic 500. HttpExceptions are intentional and pass through.
 */
@Catch()
export class SafeExceptionFilter extends BaseExceptionFilter {
  private readonly log = new Logger('Exception');

  override catch(exception: unknown, host: ArgumentsHost) {
    if (exception instanceof HttpException) return super.catch(exception, host);
    const e = exception as { name?: string; code?: string };
    this.log.error(`unhandled ${e?.name ?? 'error'}${e?.code ? ` (${e.code})` : ''} requestId=${RequestContext.get()?.requestId ?? '-'}`);
    return super.catch(new HttpException({ statusCode: 500, message: 'Internal server error' }, 500), host);
  }
}
