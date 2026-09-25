import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export interface StoredObject {
  key: string;
  url: string;
}

/** Object storage abstraction. Local disk in development; S3-compatible + CDN in production. */
export interface MediaStorage {
  put(data: Buffer, ext: string, mime: string): Promise<StoredObject>;
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
    async put(data, ext) {
      const now = new Date();
      const key = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}.${ext}`;
      const full = path.join(dir, key);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, data);
      return { key, url: `${publicBase}/media/${key}` };
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
