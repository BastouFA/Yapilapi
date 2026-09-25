import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { CreateBucketCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export interface StoredObject {
  key: string;
  url: string;
}

/** Object storage abstraction. Local disk in development; S3-compatible + CDN in production. */
export interface MediaStorage {
  driver: 'local' | 's3';
  put(data: Buffer, ext: string, mime: string): Promise<StoredObject>;
  /** Store at an exact key (derived files such as variants and HLS segments). */
  putKey(key: string, data: Buffer, mime: string): Promise<StoredObject>;
  read(key: string): Promise<Buffer>;
  /** Stream an object (S3 driver; local files are served statically). */
  get?(key: string, range?: string): Promise<{ body: Readable; contentType?: string; contentLength?: number; contentRange?: string; status: number } | null>;
}

function newKey(ext: string) {
  const now = new Date();
  return `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}.${ext}`;
}

/**
 * S3-compatible storage (AWS S3, Cloudflare R2, MinIO, SeaweedFS). The bucket
 * stays private; the API streams objects at /media/<key>, and a CDN in front of
 * that path caches them (keys are content-unique, so responses are immutable).
 */
export function s3Storage(opts: {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  publicBase: string;
}): MediaStorage & { ensureBucket(): Promise<void> } {
  const s3 = new S3Client({
    region: opts.region,
    endpoint: opts.endpoint || undefined,
    forcePathStyle: opts.forcePathStyle,
    credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
  });
  return {
    driver: 's3',
    async ensureBucket() {
      try {
        await s3.send(new HeadBucketCommand({ Bucket: opts.bucket }));
      } catch {
        await s3.send(new CreateBucketCommand({ Bucket: opts.bucket }));
      }
    },
    async put(data, ext, mime) {
      return this.putKey(newKey(ext), data, mime);
    },
    async putKey(key, data, mime) {
      await s3.send(
        new PutObjectCommand({ Bucket: opts.bucket, Key: key, Body: data, ContentType: mime, CacheControl: 'public, max-age=31536000, immutable' }),
      );
      return { key, url: `${opts.publicBase}/media/${key}` };
    },
    async read(key) {
      const r = await s3.send(new GetObjectCommand({ Bucket: opts.bucket, Key: key }));
      return Buffer.from(await r.Body!.transformToByteArray());
    },
    async get(key, range) {
      try {
        const r = await s3.send(new GetObjectCommand({ Bucket: opts.bucket, Key: key, Range: range }));
        return {
          body: r.Body as Readable,
          contentType: r.ContentType,
          contentLength: r.ContentLength,
          contentRange: r.ContentRange,
          status: r.ContentRange ? 206 : 200,
        };
      } catch (e) {
        if ((e as { name?: string }).name === 'NoSuchKey' || (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
        throw e;
      }
    },
  };
}

export const ALLOWED_MIME: Record<string, { ext: string; kind: 'image' | 'video' | 'audio' }> = {
  'image/jpeg': { ext: 'jpg', kind: 'image' },
  'image/png': { ext: 'png', kind: 'image' },
  'image/webp': { ext: 'webp', kind: 'image' },
  'image/gif': { ext: 'gif', kind: 'image' },
  'video/mp4': { ext: 'mp4', kind: 'video' },
  'video/webm': { ext: 'webm', kind: 'video' },
  'audio/mpeg': { ext: 'mp3', kind: 'audio' },
  'audio/mp4': { ext: 'm4a', kind: 'audio' },
  'audio/webm': { ext: 'weba', kind: 'audio' },
};

export function localDiskStorage(dir: string, publicBase: string): MediaStorage {
  return {
    driver: 'local',
    async put(data, ext, mime) {
      return this.putKey(newKey(ext), data, mime);
    },
    async putKey(key, data) {
      const full = path.join(dir, key);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, data);
      return { key, url: `${publicBase}/media/${key}` };
    },
    async read(key) {
      return readFile(path.join(dir, key));
    },
  };
}

/** Check magic bytes so a renamed file can't pass as an image. */
export function sniffMatches(buf: Buffer, mime: string): boolean {
  const hex = buf.subarray(0, 12).toString('hex');
  switch (mime) {
    case 'image/jpeg':
      return hex.startsWith('ffd8ff');
    case 'image/png':
      return hex.startsWith('89504e47');
    case 'image/gif':
      return hex.startsWith('47494638');
    case 'image/webp':
      return hex.startsWith('52494646') && buf.subarray(8, 12).toString() === 'WEBP';
    case 'video/mp4':
    case 'audio/mp4':
      return buf.subarray(4, 8).toString() === 'ftyp';
    case 'video/webm':
    case 'audio/webm':
      return hex.startsWith('1a45dfa3');
    case 'audio/mpeg':
      return hex.startsWith('494433') || hex.startsWith('fff');
    default:
      return false;
  }
}
