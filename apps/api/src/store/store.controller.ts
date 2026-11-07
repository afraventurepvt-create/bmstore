import { Body, Controller, Get, HttpCode, Put } from '@nestjs/common';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { CurrentUser, Roles } from '../auth/decorators';
import { AuthActor, RequestContext } from '../common/request-context';
import { TenantSecretsService } from '../crypto/tenant-secrets.service';

class RazorpayDto {
  @Matches(/^rzp_(test|live)_[A-Za-z0-9]{8,40}$/, { message: 'keyId must look like rzp_test_xxxxxxxx or rzp_live_xxxxxxxx' }) keyId!: string;
  @IsString() @MinLength(10) @MaxLength(100) keySecret!: string;
}

/** Store-admin routes: always run in the Host-resolved tenant. */
@Controller('store')
export class StoreController {
  constructor(private readonly secrets: TenantSecretsService) {}

  @Roles('store_owner', 'staff') @Get('me')
  me(@CurrentUser() user: AuthActor) {
    return { user: { id: user.id, role: user.role }, tenant: RequestContext.get()?.tenant };
  }

  @Roles('store_owner') @Get('razorpay')
  async razorpay() {
    const keyId = await this.secrets.maskedKeyId();
    return { configured: keyId !== null, keyId };
  }

  /** Owner only. The secret is encrypted before it touches the database and is never returned. */
  @Roles('store_owner') @Put('razorpay') @HttpCode(204)
  async setRazorpay(@Body() dto: RazorpayDto) {
    await this.secrets.setRazorpay(dto.keyId, dto.keySecret);
  }
}
