import { Controller, Get, NotFoundException } from '@nestjs/common';
import { Public } from '../auth/decorators';
import { RequestContext } from '../common/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { ObjectStorageService } from '../storage/object-storage.service';

/** What anyone on the store host may know: name and look. Used by the admin login screen and the storefront. */
@Controller('store')
export class StorePublicController {
  constructor(private readonly prisma: PrismaService, private readonly storage: ObjectStorageService) {}

  @Public() @Get('public')
  async info() {
    const t = RequestContext.get()?.tenant;
    if (!t) throw new NotFoundException('Store not found');
    const theme = await this.prisma.db.themeConfig.findUnique({ where: { tenantId: t.id }, select: { logoUrl: true, primaryColor: true, secondaryColor: true, fontPairId: true } });
    return { name: t.name, slug: t.slug, status: t.status, supportPhone: t.supportPhone, whatsappNumber: t.whatsappNumber, theme: theme ?? null, uploadsEnabled: this.storage.configured };
  }
}
