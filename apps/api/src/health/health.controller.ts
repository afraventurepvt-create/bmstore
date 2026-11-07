import { Controller, Get } from '@nestjs/common';
import { RequestContext } from '../common/request-context';
import { Public } from '../auth/decorators';

@Controller()
export class HealthController {
  @Public()
  @Get('health')
  health() {
    return { ok: true, tenant: RequestContext.get()?.tenant?.slug ?? null };
  }
}
