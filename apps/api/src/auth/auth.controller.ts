import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';
import { ClientIp } from '../common/client-ip';
import { AuthActor, RequestContext } from '../common/request-context';
import { AuthService } from './auth.service';
import { CurrentUser, Public, Roles } from './decorators';

class LoginDto {
  @IsEmail() @MaxLength(254) email!: string;
  @IsString() @MinLength(1) @MaxLength(200) password!: string;
}
class RefreshDto {
  @IsString() @MinLength(20) @MaxLength(200) refreshToken!: string;
}
class ForgotPasswordDto {
  @IsEmail() @MaxLength(254) email!: string;
}
class ResetPasswordDto {
  @IsString() @MinLength(20) @MaxLength(200) token!: string;
  @IsString() @MinLength(10) @MaxLength(200) password!: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public() @Post('login') @HttpCode(200)
  login(@Body() dto: LoginDto, @ClientIp() ip: string) {
    return this.auth.login(dto.email, dto.password, ip);
  }

  @Public() @Post('refresh') @HttpCode(200)
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @Public() @Post('logout') @HttpCode(204)
  async logout(@Body() dto: RefreshDto) {
    await this.auth.logout(dto.refreshToken);
  }

  /** Always 202, whether or not the address exists. */
  @Public() @Post('forgot-password') @HttpCode(202)
  async forgotPassword(@Body() dto: ForgotPasswordDto, @ClientIp() ip: string, @Req() req: Request) {
    await this.auth.forgotPassword(dto.email, req.hostname, ip);
    return { ok: true };
  }

  @Public() @Post('reset-password') @HttpCode(204)
  async resetPassword(@Body() dto: ResetPasswordDto, @ClientIp() ip: string) {
    await this.auth.resetPassword(dto.token, dto.password, ip);
  }

  @Roles('superadmin', 'store_owner', 'staff') @Get('me')
  me(@CurrentUser() user: AuthActor) {
    return { id: user.id, role: user.role, tenantId: user.tenantId, store: RequestContext.get()?.tenant?.slug ?? null };
  }
}
