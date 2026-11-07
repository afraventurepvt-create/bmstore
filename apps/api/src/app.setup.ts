import { INestApplication, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { SafeExceptionFilter } from './common/safe-exception.filter';
import { AppConfig } from './config/app-config';

/** Shared by main.ts and e2e tests so both run the same pipeline. */
export function configureApp(app: INestApplication) {
  const cfg = app.get(AppConfig);
  (app as any).set?.('trust proxy', cfg.trustProxy);
  app.useGlobalFilters(new SafeExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
}
