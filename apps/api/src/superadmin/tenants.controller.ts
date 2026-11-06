import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Roles, CurrentUser } from '../auth/decorators';
import type { AuthActor } from '../common/request-context';
import { CreateTenantDto, ListTenantsQuery, ReasonDto, SetExpiryDto } from './tenants.dto';
import { SuperadminTenantsService } from './tenants.service';

@Roles('superadmin')
@Controller('superadmin/tenants')
export class SuperadminTenantsController {
  constructor(private readonly svc: SuperadminTenantsService) {}

  @Post()
  create(@CurrentUser() actor: AuthActor, @Body() dto: CreateTenantDto) {
    return this.svc.create(actor, dto);
  }

  @Get()
  list(@CurrentUser() actor: AuthActor, @Query() q: ListTenantsQuery) {
    return this.svc.list(actor, q);
  }

  @Get(':id')
  get(@CurrentUser() actor: AuthActor, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.get(actor, id);
  }

  @Post(':id/suspend') @HttpCode(200)
  suspend(@CurrentUser() actor: AuthActor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) {
    return this.svc.setStatus(actor, id, 'suspended', dto.reason);
  }

  @Post(':id/unsuspend') @HttpCode(200)
  unsuspend(@CurrentUser() actor: AuthActor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) {
    return this.svc.setStatus(actor, id, 'active', dto.reason);
  }

  @Patch(':id/expiry')
  setExpiry(@CurrentUser() actor: AuthActor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetExpiryDto) {
    return this.svc.setExpiry(actor, id, dto.expiresAt, dto.reason);
  }
}
