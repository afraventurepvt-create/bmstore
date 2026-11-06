import { Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { TenantMiddleware } from './tenant.middleware';
import { TenantResolver } from './tenant-resolver.service';

@Global()
@Module({ providers: [TenantResolver, TenantMiddleware], exports: [TenantResolver] })
export class TenancyModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TenantMiddleware).forRoutes('*');
  }
}
