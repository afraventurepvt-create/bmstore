import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AppConfig } from '../config/app-config';

/**
 * The one place that talks to object storage (S3, Cloudflare R2, MinIO: anything S3-compatible, chosen by env).
 * Keys are always tenants/<tenantId>/… ; callers build them, this service never decides tenancy.
 */
@Injectable()
export class ObjectStorageService {
  private client?: S3Client;
  constructor(private readonly cfg: AppConfig) {}

  get configured(): boolean {
    return Boolean(this.cfg.s3Bucket && this.cfg.s3AccessKeyId && this.cfg.s3SecretAccessKey);
  }
  get bucket(): string {
    if (!this.configured) throw new ServiceUnavailableException('Uploads are not configured');
    return this.cfg.s3Bucket!;
  }

  s3(): S3Client {
    if (!this.configured) throw new ServiceUnavailableException('Uploads are not configured');
    this.client ??= new S3Client({
      region: this.cfg.s3Region,
      endpoint: this.cfg.s3Endpoint || undefined,
      forcePathStyle: this.cfg.s3ForcePathStyle,
      credentials: { accessKeyId: this.cfg.s3AccessKeyId!, secretAccessKey: this.cfg.s3SecretAccessKey! },
      // R2 / MinIO do not understand the SDK's newer streaming checksums; classic behaviour everywhere.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
    return this.client;
  }

  /** Where an object at `key` is served from (CDN / public bucket URL). */
  publicUrl(key: string): string {
    const base = this.cfg.s3PublicBaseUrl
      ?? (this.cfg.s3Endpoint ? `${this.cfg.s3Endpoint.replace(/\/$/, '')}/${this.cfg.s3Bucket}` : `https://${this.cfg.s3Bucket}.s3.${this.cfg.s3Region}.amazonaws.com`);
    return `${base.replace(/\/$/, '')}/${key}`;
  }

  /** Presigned PUT: Content-Type and Content-Length are signed, so the client can only upload what was approved. */
  presignPut(key: string, contentType: string, size: number, expiresIn: number): Promise<string> {
    return getSignedUrl(this.s3(), new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType, ContentLength: size }), {
      expiresIn, signableHeaders: new Set(['content-type', 'content-length']),
    });
  }

  async head(key: string): Promise<{ size: number; contentType: string | null } | null> {
    try {
      const r = await this.s3().send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: Number(r.ContentLength ?? 0), contentType: r.ContentType ?? null };
    } catch (e: any) {
      if (e?.$metadata?.httpStatusCode === 404 || e?.name === 'NotFound' || e?.name === 'NoSuchKey') return null;
      throw e;
    }
  }

  async get(key: string): Promise<Buffer> {
    const r = await this.s3().send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.s3().send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType, ContentLength: body.length, CacheControl: 'public, max-age=31536000, immutable' }));
  }

  async delete(keys: Array<string | null | undefined>): Promise<void> {
    for (const k of keys) if (k) await this.s3().send(new DeleteObjectCommand({ Bucket: this.bucket, Key: k })).catch(() => undefined);
  }
}
