import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Roles, CurrentUser } from '../auth/decorators';
import type { AuthActor } from '../common/request-context';
import { CreateTenantDto, ListTenantsQuery, ReasonDto, SetExpiryDto, SetLimitsDto, SetPlanDto, SetStatusDto } from './tenants.dto';
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
    return this.svc.setStatus(actor, id, 'SUSPENDED', dto.reason);
  }

  @Post(':id/unsuspend') @HttpCode(200)
  unsuspend(@CurrentUser() actor: AuthActor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) {
    return this.svc.setStatus(actor, id, 'LIVE', dto.reason);
  }

  /** BUILDING | LIVE | SUSPENDED | PARKED */
  @Post(':id/status') @HttpCode(200)
  setStatus(@CurrentUser() actor: AuthActor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetStatusDto) {
    return this.svc.setStatus(actor, id, dto.status, dto.reason);
  }

  /** Fair-use limits: max products (rows) and max media storage in MB. */
  @Patch(':id/limits')
  setLimits(@CurrentUser() actor: AuthActor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetLimitsDto) {
    return this.svc.setLimits(actor, id, dto);
  }

  /** STARTER (10 products max) | STANDARD */
  @Patch(':id/plan')
  setPlan(@CurrentUser() actor: AuthActor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetPlanDto) {
    return this.svc.setPlan(actor, id, dto.plan, dto.reason);
  }

  @Patch(':id/expiry')
  setExpiry(@CurrentUser() actor: AuthActor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetExpiryDto) {
    return this.svc.setExpiry(actor, id, dto.expiresAt, dto.reason);
  }
}
