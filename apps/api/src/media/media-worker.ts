import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import sharp from 'sharp';
import { AppConfig } from '../config/app-config';
import { PrismaService } from '../prisma/prisma.service';
import { ObjectStorageService } from '../storage/object-storage.service';
import { objectKey } from '../uploads/uploads.service';

export const MAX_EDGE = 1600;
export const THUMB_EDGE = 400;
const MAX_ATTEMPTS = 3;

/**
 * Post-upload job: original -> WebP (longest edge <= 1600px, EXIF stripped, auto-rotated first) + 400px thumbnail.
 * Runs inside the API process on an interval (MEDIA_WORKER=1, default on outside tests) and right after uploads
 * are confirmed. Claiming is the ONLY cross-tenant step: one UPDATE … SKIP LOCKED on the owner connection
 * (prisma.base, allowlisted by the gate). Everything about an item then runs inside runAsTenant(tenantId) on the
 * scoped client, so RLS applies to every read and write of tenant data.
 */
@Injectable()
export class MediaWorker implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(MediaWorker.name);
  private timer?: NodeJS.Timeout;
  private current: Promise<number> | null = null;
  private again = false;

  constructor(private readonly prisma: PrismaService, private readonly storage: ObjectStorageService, private readonly cfg: AppConfig) {}

  onModuleInit() {
    if (this.cfg.mediaWorkerEnabled && this.storage.configured) {
      this.timer = setInterval(() => void this.runOnce().catch((e) => this.log.error(`worker tick failed: ${(e as Error).name}`)), this.cfg.mediaWorkerIntervalMs);
      this.timer.unref();
    }
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Run soon (after uploads are confirmed). No-op when the in-process worker is off (a separate worker polls). */
  poke() {
    if (!this.cfg.mediaWorkerEnabled || !this.storage.configured) return;
    setImmediate(() => void this.runOnce().catch((e) => this.log.error(`worker run failed: ${(e as Error).name}`)));
  }

  /** Process everything queued (in batches of `limit`). Concurrent callers wait for the run in flight, then run again. */
  async runOnce(limit = 10): Promise<number> {
    if (this.current) {
      this.again = true;
      await this.current.catch(() => undefined);
      return this.runOnce(limit);
    }
    this.current = this.drain(limit).finally(() => { this.current = null; });
    return this.current;
  }

  private async drain(limit: number): Promise<number> {
    let handled = 0;
    for (;;) {
      this.again = false;
      const claimed = await this.prisma.base.$queryRaw<Array<{ id: string; tenant_id: string }>>`
        UPDATE "media" SET "status" = 'PROCESSING', "attempts" = "attempts" + 1, "updated_at" = now()
        WHERE "id" IN (SELECT "id" FROM "media" WHERE "status" = 'UPLOADED' ORDER BY "created_at" LIMIT ${limit} FOR UPDATE SKIP LOCKED)
        RETURNING "id", "tenant_id"`;
      for (const c of claimed) {
        await this.prisma.runAsTenant(c.tenant_id, () => this.processOne(c.id));
        handled++;
      }
      if (claimed.length < limit && !this.again) return handled;
    }
  }

  private async processOne(id: string) {
    const db = this.prisma.db;
    const m = await db.media.findUnique({ where: { id } });
    if (!m) return;
    try {
      const original = await this.storage.get(m.originalKey);
      const main = await sharp(original, { failOn: 'error', limitInputPixels: 80_000_000 })
        .rotate() // apply EXIF orientation, then the metadata is dropped (no withMetadata) = EXIF stripped
        .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82, effort: 4 })
        .toBuffer({ resolveWithObject: true });
      const thumb = await sharp(main.data).resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
      const key = objectKey(m.tenantId, m.kind, 'webp');
      const thumbKey = key.replace(/\.webp$/, '_thumb.webp');
      await this.storage.put(key, main.data, 'image/webp');
      await this.storage.put(thumbKey, thumb, 'image/webp');
      await db.media.update({
        where: { id },
        data: { key, thumbKey, width: main.info.width, height: main.info.height, bytes: main.data.length + thumb.length, status: 'READY', error: null, readyAt: new Date() },
      });
      await this.storage.delete([m.originalKey]);
    } catch (e) {
      const reason = plainReason(e);
      const giveUp = m.attempts >= MAX_ATTEMPTS; // attempts was already incremented by the claim
      if (giveUp) await this.storage.delete([m.originalKey]);
      await db.media.update({ where: { id }, data: { status: giveUp ? 'FAILED' : 'UPLOADED', error: reason, ...(giveUp ? { bytes: 0 } : {}) } });
      this.log.warn(`media ${id} attempt ${m.attempts} failed: ${reason}`);
    }
  }
}

function plainReason(e: unknown): string {
  const msg = String((e as Error)?.message ?? '');
  if (/unsupported image format|Input buffer contains unsupported|Input file is missing|VipsJpeg|corrupt|premature end/i.test(msg)) return 'This file is not a valid image (or is damaged)';
  if (/pixel limit|limitInputPixels/i.test(msg)) return 'The image is too large (more than 80 megapixels)';
  if (/NoSuchKey|NotFound/i.test(String((e as any)?.name ?? ''))) return 'The uploaded file disappeared from storage';
  return 'Could not process the image';
}
