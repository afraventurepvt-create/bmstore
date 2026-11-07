import { BadRequestException, Injectable, InternalServerErrorException, ServiceUnavailableException } from '@nestjs/common';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';
import { RequestContext } from '../common/request-context';
import { AppConfig } from '../config/app-config';

/**
 * Uploads never pass through the API process: the browser PUTs the bytes straight to object storage (S3 or any
 * S3-compatible store such as R2/MinIO) with a short-lived presigned URL this service issues. No multipart parser,
 * no multer, no request-body buffering. The object key is prefixed with the tenant id, so one store can never write
 * over another's files, and Content-Type / Content-Length are part of the signature, so the client can only upload
 * exactly what it asked permission for.
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

@Injectable()
export class UploadsService {
  private client?: S3Client;

  constructor(private readonly cfg: AppConfig) {}

  get configured(): boolean {
    return Boolean(this.cfg.s3Bucket && this.cfg.s3AccessKeyId && this.cfg.s3SecretAccessKey);
  }

  private s3(): S3Client {
    if (!this.configured) throw new ServiceUnavailableException('Uploads are not configured');
    this.client ??= new S3Client({
      region: this.cfg.s3Region,
      endpoint: this.cfg.s3Endpoint || undefined,
      forcePathStyle: this.cfg.s3ForcePathStyle,
      credentials: { accessKeyId: this.cfg.s3AccessKeyId!, secretAccessKey: this.cfg.s3SecretAccessKey! },
    });
    return this.client;
  }

  /** Where an object at `key` is served from (CDN / public bucket URL). */
  publicUrl(key: string): string {
    const base = this.cfg.s3PublicBaseUrl
      ?? (this.cfg.s3Endpoint
        ? `${this.cfg.s3Endpoint.replace(/\/$/, '')}/${this.cfg.s3Bucket}`
        : `https://${this.cfg.s3Bucket}.s3.${this.cfg.s3Region}.amazonaws.com`);
    return `${base.replace(/\/$/, '')}/${key}`;
  }

  async presign(req: PresignRequest): Promise<PresignResult> {
    const tenantId = RequestContext.tenantId();
    if (!tenantId) throw new InternalServerErrorException('No tenant context');
    const s3 = this.s3();
    const ext = IMAGE_TYPES[req.contentType];
    if (!ext) throw new BadRequestException(`Unsupported content type; allowed: ${Object.keys(IMAGE_TYPES).join(', ')}`);
    if (!Number.isInteger(req.size) || req.size < 1 || req.size > this.cfg.uploadMaxBytes) {
      throw new BadRequestException(`size must be between 1 and ${this.cfg.uploadMaxBytes} bytes`);
    }
    if (!UPLOAD_KINDS.includes(req.kind)) throw new BadRequestException('Unknown upload kind');

    const now = new Date();
    const key = `tenants/${tenantId}/${req.kind}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}.${ext}`;
    const headers = { 'Content-Type': req.contentType, 'Content-Length': String(req.size) };
    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: this.cfg.s3Bucket!, Key: key, ContentType: req.contentType, ContentLength: req.size }),
      { expiresIn: this.cfg.uploadUrlTtlSec, signableHeaders: new Set(['content-type', 'content-length']) },
    );
    return { key, uploadUrl, method: 'PUT', headers, expiresIn: this.cfg.uploadUrlTtlSec, publicUrl: this.publicUrl(key) };
  }
}
