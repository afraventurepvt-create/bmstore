import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SuperadminTenantsController } from './tenants.controller';
import { SuperadminTenantsService } from './tenants.service';

@Module({ imports: [AuthModule], controllers: [SuperadminTenantsController], providers: [SuperadminTenantsService] })
export class SuperadminModule {}
