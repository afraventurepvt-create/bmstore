import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AppConfig } from '../config/app-config';

const VERSION = 'v1';

/**
 * AES-256-GCM with a random 96-bit IV per message. Output: `v1.<iv>.<tag>.<ciphertext>` (base64url).
 * `aad` binds the ciphertext to its owner (we use `<tenantId>:<column>`), so a ciphertext copied into
 * another tenant's row, or another column, fails authentication instead of decrypting.
 * Key comes from ENCRYPTION_KEY (32 bytes). The `v1` prefix leaves room for key rotation.
 */
@Injectable()
export class CryptoService {
  private readonly key: Buffer;
  constructor(cfg: AppConfig) {
    this.key = cfg.encryptionKey;
  }

  encrypt(plaintext: string, aad: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
    return [VERSION, iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
  }

  decrypt(token: string, aad: string): string {
    const [v, iv, tag, ct] = token.split('.');
    // Deliberately generic errors: never echo the token or plaintext.
    if (v !== VERSION || !iv || !tag || ct === undefined) throw new Error('Invalid ciphertext');
    try {
      const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
      d.setAAD(Buffer.from(aad));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
    } catch {
      throw new Error('Decryption failed');
    }
  }
}
