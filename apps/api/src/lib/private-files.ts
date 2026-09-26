import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { AppContext } from './context.ts';

/**
 * Files that must never be public (digital products people buy). With local
 * storage they live in PRIVATE_UPLOAD_DIR, outside the folder served at
 * /media/. With S3 they go under private/ in the bucket, which the /media/
 * route refuses. Either way they are only read through an authorized route.
 */
export async function putPrivate(ctx: Pick<AppContext, 'config' | 'storage'>, data: Buffer, ext: string, mime: string): Promise<string> {
  const key = `private/${new Date().getUTCFullYear()}/${randomUUID()}.${ext}`;
  if (ctx.storage.driver === 's3') {
    await ctx.storage.putKey(key, data, mime);
    return key;
  }
  const full = path.join(path.resolve(ctx.config.PRIVATE_UPLOAD_DIR), key);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, data);
  return key;
}

export async function openPrivate(ctx: Pick<AppContext, 'config' | 'storage'>, key: string): Promise<{ body: Readable; contentLength?: number } | null> {
  if (!/^private\/[\w/.-]+$/.test(key) || key.includes('..')) return null;
  if (ctx.storage.driver === 's3') {
    const obj = await ctx.storage.get!(key);
    return obj ? { body: obj.body, contentLength: obj.contentLength } : null;
  }
  const full = path.join(path.resolve(ctx.config.PRIVATE_UPLOAD_DIR), key);
  const info = await stat(full).catch(() => null);
  if (!info) return null;
  return { body: createReadStream(full), contentLength: info.size };
}

/** What sellers can upload as a digital product, checked by the file's first bytes. */
export const DIGITAL_TYPES: Record<string, { ext: string; magic: (b: Buffer) => boolean }> = {
  'application/pdf': { ext: 'pdf', magic: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  'application/zip': { ext: 'zip', magic: (b) => b.subarray(0, 4).toString('hex') === '504b0304' },
  'application/epub+zip': { ext: 'epub', magic: (b) => b.subarray(0, 4).toString('hex') === '504b0304' },
  'audio/mpeg': { ext: 'mp3', magic: (b) => b.subarray(0, 3).toString('hex') === '494433' || b.subarray(0, 2).toString('hex').startsWith('fff') },
  'audio/mp4': { ext: 'm4a', magic: (b) => b.subarray(4, 8).toString('latin1') === 'ftyp' },
  'video/mp4': { ext: 'mp4', magic: (b) => b.subarray(4, 8).toString('latin1') === 'ftyp' },
  'image/png': { ext: 'png', magic: (b) => b.subarray(0, 4).toString('hex') === '89504e47' },
  'image/jpeg': { ext: 'jpg', magic: (b) => b.subarray(0, 3).toString('hex') === 'ffd8ff' },
};
