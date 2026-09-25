/* eslint-disable @typescript-eslint/no-explicit-any -- API responses are untyped JSON in tests */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import type { InjectOptions } from 'fastify';
import type { TestApp, TestUser } from './helpers.js';
import { ORIGIN } from './helpers.js';

/** Tiny but REAL files generated in test code (no binary fixtures checked in). */
export const png = (color = 'red', size = 16) =>
  sharp({ create: { width: size, height: size, channels: 3, background: color } })
    .png()
    .toBuffer();

/** JPEG carrying EXIF with GPS coordinates + camera make: the privacy leak we must strip. */
export const jpegWithGps = () =>
  sharp({ create: { width: 32, height: 24, channels: 3, background: 'blue' } })
    .jpeg()
    .withExif({
      IFD0: { Make: 'SecretCam' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '51/1 30/1 0/1',
        GPSLongitudeRef: 'W',
        GPSLongitude: '0/1 7/1 0/1',
      },
    })
    .toBuffer();

export const hasFfmpeg =
  spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

/** A real 1s 64x48 MP4 when ffmpeg exists; otherwise a minimal ISO-BMFF `ftyp` box (valid magic, no streams). */
export function mp4(): Buffer {
  if (hasFfmpeg) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'yl-fixture-'));
    const f = path.join(dir, 'a.mp4');
    const r = spawnSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=green:s=64x48:d=1:r=10',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-y',
      f,
    ]);
    if (r.status === 0) {
      const b = readFileSync(f);
      rmSync(dir, { recursive: true, force: true });
      return b;
    }
    rmSync(dir, { recursive: true, force: true });
  }
  return ftypOnly('isom');
}

/** ftyp box + padding: passes magic-byte sniffing but is not decodable. */
export function ftypOnly(brand: string): Buffer {
  const b = Buffer.alloc(64);
  b.writeUInt32BE(24, 0);
  b.write('ftyp', 4, 'latin1');
  b.write(brand, 8, 'latin1');
  b.write('isom', 16, 'latin1');
  b.write('mp41', 20, 'latin1');
  return b;
}

/** Real ~1s mono WAV (sine) generated in code. */
export function wav(): Buffer {
  const rate = 8000,
    n = rate;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++)
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

export const pdf = () =>
  Buffer.from(
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n',
  );
/** A Windows PE executable header (MZ) padded out. */
export const exe = () =>
  Buffer.concat([Buffer.from('MZ\x90\x00\x03\x00\x00\x00', 'latin1'), randomBytes(200)]);

// ------------------------------------------------------------------------------------------ HTTP helpers
export function authHeaders(
  u: TestUser,
  extra: Record<string, string> = {},
): Record<string, string> {
  const h: Record<string, string> = { origin: ORIGIN, 'x-yl-csrf': '1', ...extra };
  if (u.client.cookies.size)
    h.cookie = [...u.client.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  return h;
}

export interface Part {
  name: string;
  value?: string;
  filename?: string;
  contentType?: string;
  data?: Buffer;
}
export function multipartBody(parts: Part[]): { payload: Buffer; contentType: string } {
  const boundary = `----yl${randomBytes(8).toString('hex')}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
    if (p.filename !== undefined)
      head += `; filename="${p.filename}"\r\nContent-Type: ${p.contentType ?? 'application/octet-stream'}`;
    chunks.push(
      Buffer.from(`${head}\r\n\r\n`),
      p.data ?? Buffer.from(p.value ?? ''),
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

export async function upload(
  t: TestApp,
  u: TestUser,
  data: Buffer,
  opts: {
    filename?: string;
    contentType?: string;
    fields?: Record<string, string>;
    url?: string;
  } = {},
) {
  const parts: Part[] = Object.entries(opts.fields ?? {}).map(([name, value]) => ({ name, value }));
  parts.push({
    name: 'file',
    filename: opts.filename ?? 'upload.bin',
    contentType: opts.contentType ?? 'application/octet-stream',
    data,
  });
  const { payload, contentType } = multipartBody(parts);
  const res = await t.app.inject({
    method: 'POST',
    url: opts.url ?? '/v1/media',
    payload,
    headers: authHeaders(u, { 'content-type': contentType }),
  });
  return { status: res.statusCode, body: safeJson(res.body), headers: res.headers };
}

export async function raw(
  t: TestApp,
  u: TestUser | null,
  method: InjectOptions['method'],
  url: string,
  opts: { payload?: Buffer | string; headers?: Record<string, string> } = {},
) {
  const headers = u ? authHeaders(u, opts.headers) : { ...opts.headers };
  const res = await t.app.inject({
    method,
    url,
    headers,
    ...(opts.payload !== undefined ? { payload: opts.payload } : {}),
  });
  return {
    status: res.statusCode,
    body: safeJson(res.body),
    rawBody: res.rawPayload,
    headers: res.headers,
  };
}

function safeJson(s: string): any {
  try {
    return s ? JSON.parse(s) : undefined;
  } catch {
    return s;
  }
}

/** Path part of a media URL (`http://localhost:4000/media/m/ab/...` -> `/media/m/ab/...`). */
export const pathOf = (url: string) => new URL(url).pathname;
