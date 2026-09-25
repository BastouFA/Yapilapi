import type { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  assertSafeKey,
  type ByteRange,
  type PresignedUpload,
  type StorageAdapter,
} from './storage.js';

export interface S3Options {
  endpoint?: string | undefined;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Needed for MinIO/Ceph and most S3-compatible stores. */
  forcePathStyle?: boolean | undefined;
  /** Test seam: any object with `send`. Requests are built here; only the transport is swappable. */
  client?: Pick<S3Client, 'send'> | undefined;
}

/**
 * S3-compatible adapter. NOT exercised against a live bucket in this repo's tests (no S3 available in CI/dev):
 * only request construction and presigning (which is a local computation) are unit tested.
 *
 * Direct upload: the API hands the client a presigned PUT whose signature covers Content-Type, Content-Length and the
 * SHA-256 checksum, so the object store itself rejects a body that differs from what was declared at init. The API
 * then verifies size (HEAD), sniffs the first bytes (ranged GET) and only then marks the media uploaded.
 */
export class S3StorageAdapter implements StorageAdapter {
  readonly kind = 's3' as const;
  private readonly client: Pick<S3Client, 'send'>;
  private readonly presignClient: S3Client;

  constructor(private readonly opts: S3Options) {
    const cfg: S3ClientConfig = {
      region: opts.region,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
      forcePathStyle: opts.forcePathStyle ?? true,
      // Integrity is handled explicitly (checksums on presigned uploads); avoid implicit trailing-checksum streaming.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
    };
    this.presignClient = new S3Client(cfg);
    this.client = opts.client ?? this.presignClient;
  }

  async put(
    key: string,
    body: Buffer | Readable,
    o: { contentType: string; size?: number },
  ): Promise<void> {
    assertSafeKey(key);
    const data = Buffer.isBuffer(body) ? body : await streamToBuffer(body);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.opts.bucket,
        Key: key,
        Body: data,
        ContentType: o.contentType,
        ContentLength: data.length,
        // Objects are private: access always goes through the API (authorization) or short-lived signed URLs.
        CacheControl: 'private, max-age=0',
      }),
    );
  }

  async stat(key: string): Promise<{ size: number } | null> {
    assertSafeKey(key);
    try {
      const r = await this.client.send(
        new HeadObjectCommand({ Bucket: this.opts.bucket, Key: key }),
      );
      return { size: Number(r.ContentLength ?? 0) };
    } catch (e) {
      const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return null;
      throw e;
    }
  }

  async read(key: string, range?: ByteRange): Promise<Readable> {
    assertSafeKey(key);
    const r = await this.client.send(
      new GetObjectCommand({
        Bucket: this.opts.bucket,
        Key: key,
        ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
      }),
    );
    return r.Body as Readable;
  }

  async readBytes(key: string, range: ByteRange): Promise<Buffer> {
    return streamToBuffer(await this.read(key, range));
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: key }));
  }

  async presignPut(
    key: string,
    o: { contentType: string; size: number; sha256Hex: string; expiresInSec: number },
  ): Promise<PresignedUpload> {
    assertSafeKey(key);
    const checksum = Buffer.from(o.sha256Hex, 'hex').toString('base64');
    const cmd = new PutObjectCommand({
      Bucket: this.opts.bucket,
      Key: key,
      ContentType: o.contentType,
      ContentLength: o.size,
      ChecksumSHA256: checksum,
    });
    const url = await getSignedUrl(this.presignClient, cmd, {
      expiresIn: o.expiresInSec,
      signableHeaders: new Set(['content-type', 'content-length']),
      unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
    });
    return {
      url,
      method: 'PUT',
      headers: {
        'content-type': o.contentType,
        'content-length': String(o.size),
        'x-amz-checksum-sha256': checksum,
      },
      expiresAt: new Date(Date.now() + o.expiresInSec * 1000),
    };
  }

  async presignGet(
    key: string,
    o: { expiresInSec: number; contentType: string; disposition: string },
  ): Promise<string> {
    assertSafeKey(key);
    return getSignedUrl(
      this.presignClient,
      new GetObjectCommand({
        Bucket: this.opts.bucket,
        Key: key,
        ResponseContentType: o.contentType,
        ResponseContentDisposition: o.disposition,
      }),
      { expiresIn: o.expiresInSec },
    );
  }
}

async function streamToBuffer(s: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}
