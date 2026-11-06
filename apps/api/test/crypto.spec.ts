import { CryptoService } from '../src/crypto/crypto.service';

const mk = (key: Buffer) => new CryptoService({ encryptionKey: key } as any);

describe('CryptoService (AES-256-GCM)', () => {
  const c = mk(Buffer.alloc(32, 1));
  const AAD = 'tenant-1:razorpay_key_enc';

  it('round-trips, including unicode', () => {
    for (const s of ['rzp_live_abcdef123456', '', 'sécret-₹-🔑']) expect(c.decrypt(c.encrypt(s, AAD), AAD)).toBe(s);
  });
  it('uses a fresh IV each time and never contains the plaintext', () => {
    const a = c.encrypt('SECRETVALUE', AAD);
    const b = c.encrypt('SECRETVALUE', AAD);
    expect(a).not.toBe(b);
    expect(a).not.toContain('SECRETVALUE');
    expect(Buffer.from(a.split('.')[3], 'base64url').toString()).not.toContain('SECRETVALUE');
    expect(a.split('.')[0]).toBe('v1');
  });
  it('detects tampering of ciphertext, tag and iv', () => {
    const [v, iv, tag, ct] = c.encrypt('hello world', AAD).split('.');
    const flip = (s: string) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
    for (const t of [[v, iv, tag, flip(ct)], [v, iv, flip(tag), ct], [v, flip(iv), tag, ct]]) {
      expect(() => c.decrypt(t.join('.'), AAD)).toThrow('Decryption failed');
    }
  });
  it('binds ciphertext to its AAD (cannot be moved to another tenant/column)', () => {
    const t = c.encrypt('hello', 'tenantA:razorpay_key_enc');
    expect(() => c.decrypt(t, 'tenantB:razorpay_key_enc')).toThrow('Decryption failed');
    expect(() => c.decrypt(t, 'tenantA:razorpay_secret_enc')).toThrow('Decryption failed');
  });
  it('fails with a different key and on malformed input, without echoing data', () => {
    const t = c.encrypt('hello', AAD);
    expect(() => mk(Buffer.alloc(32, 2)).decrypt(t, AAD)).toThrow('Decryption failed');
    for (const bad of ['', 'v1', 'v2.a.b.c', 'plain-text-secret']) {
      try { c.decrypt(bad, AAD); fail('should throw'); } catch (e: any) { expect(e.message).not.toContain('plain-text-secret'); }
    }
  });
});

describe('AppConfig key parsing', () => {
  const load = (k: string) => {
    jest.resetModules();
    const old = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = k;
    try { const { AppConfig } = require('../src/config/app-config'); return new AppConfig(); } finally { process.env.ENCRYPTION_KEY = old; }
  };
  it('accepts 32-byte base64 or 64-hex, rejects anything else', () => {
    expect(load(Buffer.alloc(32, 3).toString('base64')).encryptionKey).toHaveLength(32);
    expect(load(Buffer.alloc(32, 3).toString('hex')).encryptionKey).toHaveLength(32);
    expect(() => load('tooshort')).toThrow(/32 bytes/);
    expect(() => load(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
  });
});
