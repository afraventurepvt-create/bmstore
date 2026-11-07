import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
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

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public() @Post('login') @HttpCode(200)
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  @Public() @Post('refresh') @HttpCode(200)
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @Public() @Post('logout') @HttpCode(204)
  async logout(@Body() dto: RefreshDto) {
    await this.auth.logout(dto.refreshToken);
  }

  @Roles('superadmin', 'store_owner', 'staff') @Get('me')
  me(@CurrentUser() user: AuthActor) {
    return { id: user.id, role: user.role, tenantId: user.tenantId, store: RequestContext.get()?.tenant?.slug ?? null };
  }
}
