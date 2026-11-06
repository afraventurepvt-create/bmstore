import { Global, Module } from '@nestjs/common';
import { SuperadminModule } from './superadmin/superadmin.module';
import { AuthModule } from './auth/auth.module';
import { AppConfig } from './config/app-config';
import { HealthController } from './health/health.controller';
import { PrismaService } from './prisma/prisma.service';
import { RedisService } from './redis/redis.service';
import { TenancyModule } from './tenancy/tenancy.module';

@Global()
@Module({
  providers: [AppConfig, PrismaService, RedisService],
  exports: [AppConfig, PrismaService, RedisService],
})
class CoreModule {}

@Module({ imports: [CoreModule, TenancyModule, AuthModule, SuperadminModule], controllers: [HealthController] })
export class AppModule {}
