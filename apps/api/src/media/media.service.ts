import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { MediaStatus, Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { RequestContext } from '../common/request-context';
import { ListQuery, listPage } from '../common/pagination';
import { AppConfig } from '../config/app-config';
import { PrismaService } from '../prisma/prisma.service';
import { ObjectStorageService } from '../storage/object-storage.service';
import { IMAGE_TYPES, UPLOAD_KINDS, UploadKind, objectKey } from '../uploads/uploads.service';

export class PresignFileDto {
  @IsString() @MinLength(1) @MaxLength(200) filename!: string;
  @IsIn(Object.keys(IMAGE_TYPES)) contentType!: string;
  @IsInt() @Min(1) size!: number;
  @IsOptional() @IsIn(UPLOAD_KINDS as unknown as string[]) kind?: UploadKind = 'product';
}
export class PresignBatchDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => PresignFileDto) files!: PresignFileDto[];
}
export class CompleteDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @IsUUID(undefined, { each: true }) ids!: string[];
}
export class ListMediaQuery extends ListQuery {
  @IsOptional() @IsEnum(MediaStatus) status?: MediaStatus;
  @IsOptional() @IsIn(UPLOAD_KINDS as unknown as string[]) kind?: UploadKind;
}

/** Hook for the fair-use check (media bytes); the limits module replaces it. */
export abstract class MediaQuotaGuard {
  abstract assertRoom(tenantId: string, incomingBytes: number): Promise<void>;
}
@Injectable()
export class NoMediaQuota extends MediaQuotaGuard {
  async assertRoom(): Promise<void> { /* no limit */ }
}

@Injectable()
export class MediaService {
  constructor(private readonly prisma: PrismaService, private readonly storage: ObjectStorageService, private readonly cfg: AppConfig, private readonly quota: MediaQuotaGuard) {}
  private get db() { return this.prisma.db; }
  private tid() { return RequestContext.tenantId()!; }

  present = (m: any) => ({
    ...m,
    url: m.key ? this.storage.publicUrl(m.key) : null,
    thumbUrl: m.thumbKey ? this.storage.publicUrl(m.thumbKey) : null,
  });

  /** Step 1: one presigned PUT per file. Rows start PENDING with the declared size reserved against the quota. */
  async presign(dto: PresignBatchDto) {
    if (!this.storage.configured) throw new BadRequestException('Uploads are not configured on this server');
    const tenantId = this.tid();
    for (const f of dto.files) {
      if (f.size > this.cfg.uploadMaxBytes) throw new BadRequestException(`"${f.filename}" is ${(f.size / 1048576).toFixed(1)} MB; the maximum is ${(this.cfg.uploadMaxBytes / 1048576).toFixed(0)} MB per image`);
    }
    await this.quota.assertRoom(tenantId, dto.files.reduce((n, f) => n + f.size, 0));
    const out = [];
    for (const f of dto.files) {
      const originalKey = objectKey(tenantId, 'originals', IMAGE_TYPES[f.contentType]);
      const row = await this.db.media.create({
        data: { tenantId, kind: f.kind ?? 'product', filename: f.filename.slice(0, 200), contentType: f.contentType, originalKey, declaredBytes: f.size },
      });
      const uploadUrl = await this.storage.presignPut(originalKey, f.contentType, f.size, this.cfg.uploadUrlTtlSec);
      out.push({ id: row.id, filename: row.filename, uploadUrl, method: 'PUT' as const, headers: { 'Content-Type': f.contentType, 'Content-Length': String(f.size) }, expiresIn: this.cfg.uploadUrlTtlSec });
    }
    return { files: out };
  }

  /** Step 2: after the PUTs, confirm the objects exist with the promised size; they become UPLOADED for the worker. */
  async complete(dto: CompleteDto) {
    const rows = await this.db.media.findMany({ where: { id: { in: dto.ids } } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const results: Array<{ id: string; status: MediaStatus | 'NOT_FOUND'; reason?: string }> = [];
    for (const id of dto.ids) {
      const m = byId.get(id);
      if (!m) { results.push({ id, status: 'NOT_FOUND', reason: 'Unknown upload' }); continue; }
      if (m.status !== 'PENDING') { results.push({ id, status: m.status }); continue; }
      const head = await this.storage.head(m.originalKey);
      if (!head) { results.push({ id, status: 'PENDING', reason: 'The file has not arrived in storage yet. Upload it, then confirm again.' }); continue; }
      if (head.size !== m.declaredBytes || head.size > this.cfg.uploadMaxBytes) {
        await this.storage.delete([m.originalKey]);
        await this.db.media.update({ where: { id }, data: { status: 'FAILED', error: `Uploaded ${head.size} bytes but ${m.declaredBytes} were announced` } });
        results.push({ id, status: 'FAILED', reason: 'The uploaded file does not match what was announced; please upload it again' });
        continue;
      }
      await this.db.media.update({ where: { id }, data: { status: 'UPLOADED', bytes: head.size, error: null } });
      results.push({ id, status: 'UPLOADED' });
    }
    return { results };
  }

  list(q: ListMediaQuery) {
    const where: Prisma.MediaWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.q ? { filename: { contains: q.q, mode: 'insensitive' } } : {}),
    };
    return listPage(q, async (skip, take) => [
      (await this.db.media.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take })).map(this.present),
      await this.db.media.count({ where }),
    ]);
  }

  async get(id: string) {
    const m = await this.db.media.findUnique({ where: { id } });
    if (!m) throw new NotFoundException('Image not found');
    return this.present(m);
  }

  async remove(id: string) {
    const m = await this.db.media.findUnique({ where: { id } });
    if (!m) throw new NotFoundException('Image not found');
    await this.storage.delete([m.originalKey, m.key, m.thumbKey]);
    await this.db.media.delete({ where: { id } });
  }

  /** Stored bytes for this tenant (what the quota counts). */
  async usageBytes(): Promise<number> {
    const r = await this.db.media.aggregate({ _sum: { bytes: true } });
    return r._sum.bytes ?? 0;
  }

  /** CSV import: image_filename -> public URL of a READY image with that filename (latest wins). */
  async resolveFilenames(filenames: string[]): Promise<Map<string, string>> {
    const rows = await this.db.media.findMany({ where: { status: 'READY', filename: { in: filenames, mode: 'insensitive' } }, orderBy: { readyAt: 'asc' } });
    const out = new Map<string, string>();
    for (const r of rows) if (r.key) out.set(r.filename.toLowerCase(), this.storage.publicUrl(r.key));
    return out;
  }
}
