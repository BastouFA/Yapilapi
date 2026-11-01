import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '../../../packages/api-client/src/index.ts';
import type { BuiltApp } from '../src/app.ts';
import { chunkKey } from '../src/lib/storage.ts';
import { as, signUp, testApp, type TestUser } from './helpers.ts';

/** Two servers sharing one storage and database, as during a deploy: the old one and its replacement. */
let oldServer: BuiltApp;
let newServer: BuiltApp;
let clip: Buffer;
const CHUNK = 5 * 1024 * 1024;

beforeAll(async () => {
  oldServer = await testApp();
  newServer = await testApp();
  const fixture = await readFile(path.join(import.meta.dirname, '../../web/e2e/fixtures/clip.mp4'));
  // A real video, padded past one part: what's after its end doesn't stop it being read.
  clip = Buffer.concat([fixture, Buffer.alloc(CHUNK + 1000 - fixture.length)]);
});
afterAll(async () => {
  await oldServer.close();
  await newServer.close();
});

const put = (app: BuiltApp, u: TestUser, id: string, i: number, body: Buffer) =>
  app.app.inject({
    method: 'PUT',
    url: `/v1/uploads/${id}/chunks/${i}`,
    headers: { authorization: `Bearer ${u.token}`, 'content-type': 'application/octet-stream' },
    payload: body,
  });

describe('an upload through a server restart', () => {
  it('carries on: a part on the old server and a part on the new one make one video', async () => {
    const u = await signUp(oldServer.app);
    const s = await as(oldServer.app, u).post('/v1/uploads', { filename: 'reel.mp4', mime: 'video/mp4', size: clip.length });
    expect(s.body.totalChunks).toBe(2);
    expect((await put(oldServer, u, s.body.uploadId, 0, clip.subarray(0, CHUNK))).statusCode).toBe(200);
    // The deploy happens here.
    expect((await put(newServer, u, s.body.uploadId, 1, clip.subarray(CHUNK))).statusCode).toBe(200);
    const status = await as(newServer.app, u).get(`/v1/uploads/${s.body.uploadId}`);
    expect(status.body).toMatchObject({ status: 'open', missing: [], chunkSize: CHUNK, totalChunks: 2 });
    const done = await as(newServer.app, u).post(`/v1/uploads/${s.body.uploadId}/complete`, {});
    expect(done.status).toBe(201);
    expect(done.body.media.kind).toBe('video');
    // The parts are gone from storage once it's whole.
    await expect(newServer.ctx.storage.read(chunkKey(s.body.uploadId, 0))).rejects.toBeTruthy();
  });

  it('says plainly when parts were lost, so the app starts again', async () => {
    const u = await signUp(oldServer.app);
    const s = await as(oldServer.app, u).post('/v1/uploads', { filename: 'reel.mp4', mime: 'video/mp4', size: clip.length });
    await put(oldServer, u, s.body.uploadId, 0, clip.subarray(0, CHUNK));
    await put(oldServer, u, s.body.uploadId, 1, clip.subarray(CHUNK));
    await oldServer.ctx.storage.remove!(chunkKey(s.body.uploadId, 0));
    const done = await as(oldServer.app, u).post(`/v1/uploads/${s.body.uploadId}/complete`, {});
    expect(done.status).toBe(409);
    expect(done.body.error.code).toBe('upload_parts_lost');
  });

  it('the app waits out a server that is away, and tries the same file again from where it stopped', async () => {
    const u = await signUp(oldServer.app);
    let away = 2;
    const puts: string[] = [];
    const fetcher = (async (url: string, init: RequestInit = {}) => {
      const target = String(url).replace('http://api.test', '');
      const isPut = init.method === 'PUT';
      if (isPut) puts.push(target);
      // The restart: the second part gets no answer twice.
      if (isPut && target.endsWith('/chunks/1') && away-- > 0) throw new TypeError('network');
      const body = init.body instanceof Blob ? Buffer.from(await init.body.arrayBuffer()) : (init.body as string | undefined);
      const res = await oldServer.app.inject({
        method: (init.method ?? 'GET') as 'GET',
        url: target,
        headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${u.token}` },
        payload: body,
      });
      return new Response(res.statusCode === 204 ? null : res.body, {
        status: res.statusCode,
        headers: { 'content-type': String(res.headers['content-type'] ?? 'application/json') },
      });
    }) as typeof fetch;
    const client = createClient({ baseUrl: 'http://api.test', fetch: fetcher });
    const file = new File([clip], 'reel.mp4', { type: 'video/mp4', lastModified: 1 });
    const seen: number[] = [];
    const { media } = await client.uploads.resumable(file, (p) => seen.push(p));
    expect(media.kind).toBe('video');
    expect(puts.filter((x) => x.endsWith('/chunks/0'))).toHaveLength(1);
    expect(puts.filter((x) => x.endsWith('/chunks/1'))).toHaveLength(3);
    expect(seen).toEqual([0.5, 1]);
  }, 30_000);

  it("/media doesn't serve parts of an upload", async () => {
    const key = chunkKey('11111111-1111-1111-1111-111111111111', 0);
    expect((await oldServer.app.inject({ method: 'GET', url: `/media/${key}` })).statusCode).toBe(404);
  });
});
