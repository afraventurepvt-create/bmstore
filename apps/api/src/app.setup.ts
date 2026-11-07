import { INestApplication, ValidationPipe } from '@nestjs/common';
import { raw } from 'express';
import { HttpAdapterHost } from '@nestjs/core';
import { SafeExceptionFilter } from './common/safe-exception.filter';
import { AppConfig } from './config/app-config';

/** Shared by main.ts and e2e tests so both run the same pipeline. */
export function configureApp(app: INestApplication) {
  const cfg = app.get(AppConfig);
  (app as any).set?.('trust proxy', cfg.trustProxy);
  // File imports arrive as the raw request body (CSV / XLSX bytes): no multipart parser anywhere in the API.
  app.use(raw({ type: ['text/csv', 'text/plain', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel', 'application/octet-stream'], limit: '25mb' }));
  app.useGlobalFilters(new SafeExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
}
