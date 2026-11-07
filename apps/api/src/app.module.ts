import { Global, Module } from '@nestjs/common';
import { StoreModule } from './store/store.module';
import { CatalogModule } from './catalog/catalog.module';
import { OrdersModule } from './orders/orders.module';
import { CustomersModule } from './crm/customers';
import { CouponsModule } from './crm/coupons';
import { PagesModule } from './content/pages';
import { SettingsModule } from './settings/settings';
import { SuperadminModule } from './superadmin/superadmin.module';
import { AuthModule } from './auth/auth.module';
import { AppConfig } from './config/app-config';
import { HealthController } from './health/health.controller';
import { MailModule } from './mail/mail.module';
import { PrismaService } from './prisma/prisma.service';
import { RedisService } from './redis/redis.service';
import { TenancyModule } from './tenancy/tenancy.module';
import { UploadsModule } from './uploads/uploads.module';

@Global()
@Module({
  providers: [AppConfig, PrismaService, RedisService],
  exports: [AppConfig, PrismaService, RedisService],
})
class CoreModule {}

@Module({ imports: [CoreModule, MailModule, TenancyModule, AuthModule, SuperadminModule, StoreModule, UploadsModule, CatalogModule, OrdersModule, CustomersModule, CouponsModule, PagesModule, SettingsModule], controllers: [HealthController] })
export class AppModule {}
