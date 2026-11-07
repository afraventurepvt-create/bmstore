import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { RequestContext } from '../common/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from './crypto.service';

const aad = (tenantId: string, column: 'razorpay_key_enc' | 'razorpay_secret_enc') => `${tenantId}:${column}`;

/** The only code that touches razorpay_*_enc. Plaintext exists only inside these methods. */
@Injectable()
export class TenantSecretsService {
  constructor(private readonly prisma: PrismaService, private readonly crypto: CryptoService) {}

  private tenantId(): string {
    const id = RequestContext.tenantId();
    if (!id) throw new InternalServerErrorException('No tenant context');
    return id;
  }

  async setRazorpay(keyId: string, keySecret: string): Promise<void> {
    const tid = this.tenantId();
    await this.prisma.db.tenant.update({
      where: { id: tid },
      data: {
        razorpayKeyEnc: this.crypto.encrypt(keyId, aad(tid, 'razorpay_key_enc')),
        razorpaySecretEnc: this.crypto.encrypt(keySecret, aad(tid, 'razorpay_secret_enc')),
      },
    });
  }

  /** For the payments module (Phase 2). Never return this from a controller. */
  async getRazorpayCredentials(): Promise<{ keyId: string; keySecret: string } | null> {
    const tid = this.tenantId();
    const t = await this.prisma.db.tenant.findUnique({ where: { id: tid }, select: { razorpayKeyEnc: true, razorpaySecretEnc: true } });
    if (!t?.razorpayKeyEnc || !t.razorpaySecretEnc) return null;
    return {
      keyId: this.crypto.decrypt(t.razorpayKeyEnc, aad(tid, 'razorpay_key_enc')),
      keySecret: this.crypto.decrypt(t.razorpaySecretEnc, aad(tid, 'razorpay_secret_enc')),
    };
  }

  /** Safe to show: `rzp_live_••••abcd`. */
  async maskedKeyId(): Promise<string | null> {
    const c = await this.getRazorpayCredentials();
    return c ? `${c.keyId.slice(0, c.keyId.lastIndexOf('_') + 1)}••••${c.keyId.slice(-4)}` : null;
  }
}
