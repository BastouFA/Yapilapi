import { describe, expect, it } from 'vitest';
import { S3StorageAdapter } from './s3.js';

/**
 * The S3 adapter cannot be tested against a live bucket here. These tests cover REQUEST CONSTRUCTION only: which
 * commands the adapter sends (bucket/key/headers/ranges) through an injected transport, and the presigned URLs
 * (signing is a local computation). Behaviour against a real S3/MinIO is UNVERIFIED: see docs/architecture/media.md.
 */
const opts = {
  endpoint: 'http://minio.test:9000',
  region: 'us-east-1',
  bucket: 'yl-media',
  accessKeyId: 'AKIATESTTESTTEST',
  secretAccessKey: 'secret-secret-secret',
  forcePathStyle: true,
};

function recording() {
  const sent: Array<{ name: string; input: any }> = [];
  const client = {
    send: async (cmd: any) => {
      sent.push({ name: cmd.constructor.name, input: cmd.input });
      if (cmd.constructor.name === 'HeadObjectCommand' && cmd.input.Key === 'm/gone')
        throw Object.assign(new Error('nf'), {
          name: 'NotFound',
          $metadata: { httpStatusCode: 404 },
        });
      return {
        ContentLength: 42,
        Body: (await import('node:stream')).Readable.from([Buffer.from('abc')]),
      };
    },
  };
  return { sent, adapter: new S3StorageAdapter({ ...opts, client: client as never }) };
}

describe('S3StorageAdapter request construction', () => {
  it('builds PUT/HEAD/GET/DELETE commands for the configured bucket', async () => {
    const { sent, adapter } = recording();
    await adapter.put('m/ab/abcd.jpg', Buffer.from('hello'), { contentType: 'image/jpeg' });
    expect(sent[0]).toMatchObject({
      name: 'PutObjectCommand',
      input: {
        Bucket: 'yl-media',
        Key: 'm/ab/abcd.jpg',
        ContentType: 'image/jpeg',
        ContentLength: 5,
        CacheControl: 'private, max-age=0',
      },
    });
    expect(await adapter.stat('m/ab/abcd.jpg')).toEqual({ size: 42 });
    expect(await adapter.stat('m/gone')).toBeNull();
    await adapter.readBytes('m/ab/abcd.jpg', { start: 0, end: 99 });
    expect(sent.at(-1)).toMatchObject({
      name: 'GetObjectCommand',
      input: { Bucket: 'yl-media', Key: 'm/ab/abcd.jpg', Range: 'bytes=0-99' },
    });
    await adapter.delete('m/ab/abcd.jpg');
    expect(sent.at(-1)).toMatchObject({
      name: 'DeleteObjectCommand',
      input: { Bucket: 'yl-media', Key: 'm/ab/abcd.jpg' },
    });
  });

  it('refuses unsafe keys before any request is made', async () => {
    const { sent, adapter } = recording();
    await expect(
      adapter.put('../etc/passwd', Buffer.from('x'), { contentType: 'x/y' }),
    ).rejects.toThrow();
    await expect(adapter.delete('a//b')).rejects.toThrow();
    expect(sent).toHaveLength(0);
  });

  it('presigns a direct upload that binds content type, length and SHA-256', async () => {
    const adapter = new S3StorageAdapter(opts);
    const sha = 'a'.repeat(64);
    const p = await adapter.presignPut('m/ab/abcd.mp4', {
      contentType: 'video/mp4',
      size: 123_456,
      sha256Hex: sha,
      expiresInSec: 900,
    });
    const u = new URL(p.url);
    expect(u.origin).toBe('http://minio.test:9000');
    expect(u.pathname).toBe('/yl-media/m/ab/abcd.mp4'); // path-style
    expect(u.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(u.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(u.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    const signed = u.searchParams.get('X-Amz-SignedHeaders')!.split(';');
    expect(signed).toEqual(
      expect.arrayContaining(['content-type', 'content-length', 'x-amz-checksum-sha256', 'host']),
    );
    expect(p.method).toBe('PUT');
    expect(p.headers['content-type']).toBe('video/mp4');
    expect(p.headers['content-length']).toBe('123456');
    expect(p.headers['x-amz-checksum-sha256']).toBe(Buffer.from(sha, 'hex').toString('base64'));
    expect(p.expiresAt.getTime()).toBeGreaterThan(Date.now());
    // Credentials never appear in the URL, only the access key id inside the credential scope.
    expect(p.url).not.toContain('secret-secret-secret');
  });

  it('presigns short-lived downloads with a forced content type and disposition', async () => {
    const adapter = new S3StorageAdapter(opts);
    const url = await adapter.presignGet('m/ab/abcd.jpg', {
      expiresInSec: 300,
      contentType: 'image/jpeg',
      disposition: 'inline; filename="x.jpg"',
    });
    const u = new URL(url);
    expect(u.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(u.searchParams.get('response-content-type')).toBe('image/jpeg');
    expect(u.searchParams.get('response-content-disposition')).toContain('inline');
  });
});
