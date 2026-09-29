import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuiltApp } from '../src/app.ts';
import { as, signUp, testApp, type TestUser } from './helpers.ts';

/** Bugs found in the media, reels and stories sweep (2026-09-29). */
let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.close();
});
const db = () => t.ctx.db;

async function photo(): Promise<Buffer> {
  return sharp({ create: { width: 40, height: 30, channels: 3, background: '#3a7' } })
    .jpeg()
    .toBuffer();
}

async function resumable(u: TestUser, data: Buffer) {
  const s = await as(t.app, u).post('/v1/uploads', { filename: 'IMG_1.JPG', mime: 'image/jpeg', size: data.length });
  expect(s.status).toBe(201);
  const chunk = await t.app.inject({
    method: 'PUT',
    url: `/v1/uploads/${s.body.uploadId}/chunks/0`,
    headers: { authorization: `Bearer ${u.token}`, 'content-type': 'application/octet-stream' },
    payload: data,
  });
  expect(chunk.statusCode).toBe(200);
  return s.body.uploadId as string;
}

describe('resumable uploads', () => {
  it('two completions sent at once make one media item', async () => {
    const u = await signUp(t.app);
    const id = await resumable(u, await photo());
    const [a, b] = await Promise.all([as(t.app, u).post(`/v1/uploads/${id}/complete`, {}), as(t.app, u).post(`/v1/uploads/${id}/complete`, {})]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.media.id).toBe(b.body.media.id);
    const { rows } = await db().query(`SELECT count(*)::int AS n FROM media WHERE owner_id = $1`, [u.id]);
    expect(rows[0].n).toBe(1);
  });

  it('an upload that failed is refused plainly when completed again', async () => {
    const u = await signUp(t.app);
    const id = await resumable(u, Buffer.from('this is not a photo at all'));
    const first = await as(t.app, u).post(`/v1/uploads/${id}/complete`, {});
    expect(first.status).toBe(415);
    const again = await as(t.app, u).post(`/v1/uploads/${id}/complete`, {});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('upload_finished');
  });
});
