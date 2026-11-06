import { Global, Module } from '@nestjs/common';
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

@Module({ imports: [CoreModule, TenancyModule], controllers: [HealthController] })
export class AppModule {}
