import { BadRequestException, Injectable, InternalServerErrorException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RequestContext } from '../common/request-context';
import { AppConfig } from '../config/app-config';
import { ObjectStorageService } from '../storage/object-storage.service';

/**
 * Single-file presigned upload (kept for simple cases, e.g. a logo). Bulk image uploads with processing live in
 * src/media. Uploads never pass through the API process: the browser PUTs the bytes straight to object storage
 * (S3 / R2 / MinIO) with a short-lived presigned URL. No multipart parser, no multer, no request-body buffering.
 * The object key is prefixed with the tenant id, so one store can never write over another's files, and
 * Content-Type / Content-Length are part of the signature.
 */
export const UPLOAD_KINDS = ['product', 'category', 'logo', 'banner', 'page'] as const;
export type UploadKind = (typeof UPLOAD_KINDS)[number];

export const IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

export interface PresignRequest { kind: UploadKind; contentType: string; size: number }
export interface PresignResult {
  key: string;
  uploadUrl: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresIn: number;
  publicUrl: string;
}

/** tenants/<tenantId>/<kind>/<yyyy>/<mm>/<uuid>.<ext> */
export function objectKey(tenantId: string, kind: string, ext: string, now = new Date()) {
  return `tenants/${tenantId}/${kind}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}.${ext}`;
}

@Injectable()
export class UploadsService {
  constructor(private readonly cfg: AppConfig, private readonly storage: ObjectStorageService) {}

  get configured(): boolean { return this.storage.configured; }
  publicUrl(key: string): string { return this.storage.publicUrl(key); }

  async presign(req: PresignRequest): Promise<PresignResult> {
    const tenantId = RequestContext.tenantId();
    if (!tenantId) throw new InternalServerErrorException('No tenant context');
    const ext = IMAGE_TYPES[req.contentType];
    if (!ext) throw new BadRequestException(`Unsupported content type; allowed: ${Object.keys(IMAGE_TYPES).join(', ')}`);
    if (!Number.isInteger(req.size) || req.size < 1 || req.size > this.cfg.uploadMaxBytes) {
      throw new BadRequestException(`size must be between 1 and ${this.cfg.uploadMaxBytes} bytes`);
    }
    if (!UPLOAD_KINDS.includes(req.kind)) throw new BadRequestException('Unknown upload kind');
    const key = objectKey(tenantId, req.kind, ext);
    const headers = { 'Content-Type': req.contentType, 'Content-Length': String(req.size) };
    const uploadUrl = await this.storage.presignPut(key, req.contentType, req.size, this.cfg.uploadUrlTtlSec);
    return { key, uploadUrl, method: 'PUT', headers, expiresIn: this.cfg.uploadUrlTtlSec, publicUrl: this.storage.publicUrl(key) };
  }
}
