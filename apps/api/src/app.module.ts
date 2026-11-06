import { Global, Module } from '@nestjs/common';
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

@Module({ imports: [CoreModule, TenancyModule, AuthModule], controllers: [HealthController] })
export class AppModule {}
