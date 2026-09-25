import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface ByteRange {
  /** Inclusive offsets, like an HTTP Range. */
  start: number;
  end: number;
}

export interface PresignedUpload {
  url: string;
  method: 'PUT';
  /** Headers the client MUST send exactly as given (they are part of the signature). */
  headers: Record<string, string>;
  expiresAt: Date;
}

/**
 * Object storage abstraction. Keys are opaque, server-generated and validated by `assertSafeKey`; adapters never
 * see user-supplied file names. Two implementations: LocalStorageAdapter (filesystem) and S3StorageAdapter.
 */
export interface StorageAdapter {
  readonly kind: 'local' | 's3';
  put(
    key: string,
    body: Buffer | Readable,
    opts: { contentType: string; size?: number },
  ): Promise<void>;
  stat(key: string): Promise<{ size: number } | null>;
  read(key: string, range?: ByteRange): Promise<Readable>;
  /** Read a small prefix/slice fully into memory (magic-byte sniffing). */
  readBytes(key: string, range: ByteRange): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /** Direct-to-storage upload (S3 only). Absent on adapters that cannot offer it. */
  presignPut?(
    key: string,
    opts: { contentType: string; size: number; sha256Hex: string; expiresInSec: number },
  ): Promise<PresignedUpload>;
  /** Short-lived signed download URL (S3 only): the API authorizes, then redirects. */
  presignGet?(
    key: string,
    opts: { expiresInSec: number; contentType: string; disposition: string },
  ): Promise<string>;
}

const KEY_RE = /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*(?:\.[a-z0-9-]{1,32})*$/;
export function assertSafeKey(key: string): void {
  if (key.length > 200 || !KEY_RE.test(key) || key.includes('..'))
    throw new Error('unsafe storage key');
}
export const isSafeKey = (key: string): boolean => {
  try {
    assertSafeKey(key);
    return true;
  } catch {
    return false;
  }
};

/** 128-bit random, unguessable object name (hex). */
export const randomKeyPart = (): string => randomBytes(16).toString('hex');
export const newObjectKey = (prefix: 'm' | 'v' | 'c', ext: string): string => {
  const id = randomKeyPart();
  return `${prefix}/${id.slice(0, 2)}/${id}.${ext}`;
};
export const chunkKey = (mediaId: string, n: number): string => `u/${mediaId}/${n}`;

export class LocalStorageAdapter implements StorageAdapter {
  readonly kind = 'local' as const;
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private resolve(key: string): string {
    assertSafeKey(key);
    const p = path.resolve(this.root, key);
    if (!p.startsWith(this.root + path.sep)) throw new Error('unsafe storage key');
    return p;
  }

  /** Filesystem path for a key (used by the processor to hand files to ffmpeg without copying). */
  localPath(key: string): string {
    return this.resolve(key);
  }

  async put(
    key: string,
    body: Buffer | Readable,
    _opts?: { contentType: string; size?: number },
  ): Promise<void> {
    const dest = this.resolve(key);
    await mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.${randomBytes(6).toString('hex')}.part`;
    try {
      if (Buffer.isBuffer(body)) {
        const fh = await open(tmp, 'w', 0o640);
        try {
          await fh.writeFile(body);
        } finally {
          await fh.close();
        }
      } else {
        await pipeline(body, createWriteStream(tmp, { mode: 0o640 }));
      }
      await rename(tmp, dest); // atomic: readers never see a half-written object
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }

  async stat(key: string): Promise<{ size: number } | null> {
    try {
      const s = await stat(this.resolve(key));
      return s.isFile() ? { size: s.size } : null;
    } catch {
      return null;
    }
  }

  async read(key: string, range?: ByteRange): Promise<Readable> {
    return createReadStream(this.resolve(key), range ? { start: range.start, end: range.end } : {});
  }

  async readBytes(key: string, range: ByteRange): Promise<Buffer> {
    const fh = await open(this.resolve(key), 'r');
    try {
      const len = range.end - range.start + 1;
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, range.start);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  /** Remove a whole "directory" (used for chunk staging); tolerant of it not existing. */
  async deletePrefix(prefix: string): Promise<void> {
    await rm(this.resolve(prefix), { recursive: true, force: true });
  }

  async list(prefix: string): Promise<string[]> {
    try {
      return await readdir(this.resolve(prefix));
    } catch {
      return [];
    }
  }
}

export const hasLocalPath = (
  a: StorageAdapter,
): a is StorageAdapter & { localPath(key: string): string } =>
  typeof (a as { localPath?: unknown }).localPath === 'function';
