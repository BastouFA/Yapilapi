import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuiltApp } from '../src/app.ts';
import { mediaJobHandlers } from '../src/lib/media-processing.ts';
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

async function reelBy(owner: TestUser) {
  const { rows } = await db().query(
    `INSERT INTO media (owner_id, kind, url, mime, status, duration_ms) VALUES ($1,'video','http://localhost:4000/media/test.mp4','video/mp4','ready',8000) RETURNING id, url`,
    [owner.id],
  );
  const r = await as(t.app, owner).post('/v1/posts', { format: 'reel', body: 'Ridge run', media: [{ id: rows[0].id, url: rows[0].url, kind: 'video' }] });
  expect(r.status).toBe(201);
  return r.body.post.id as string;
}

/** Every reel id the reels feed gives someone, over a few pages. */
async function reelsFeed(u: TestUser) {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 6; i++) {
    const r = await as(t.app, u).get(`/v1/reels?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    expect(r.status).toBe(200);
    ids.push(...r.body.items.map((p: { id: string }) => p.id));
    cursor = r.body.nextCursor;
    if (!cursor) break;
  }
  return ids;
}

describe('reels feed', () => {
  it('leaves out reels you are not interested in and creators you muted, like the other feeds', async () => {
    const creator = await signUp(t.app);
    const other = await signUp(t.app);
    const viewer = await signUp(t.app);
    await as(t.app, viewer).post(`/v1/users/${creator.id}/follow`);
    await as(t.app, viewer).post(`/v1/users/${other.id}/follow`);
    const skipped = await reelBy(creator);
    const kept = await reelBy(creator);
    const muted = await reelBy(other);
    let ids = await reelsFeed(viewer);
    expect(ids).toEqual(expect.arrayContaining([skipped, kept, muted]));

    expect((await as(t.app, viewer).post('/v1/feed/feedback', { signal: 'not_interested', postId: skipped })).status).toBe(200);
    expect((await as(t.app, viewer).post('/v1/feed/feedback', { signal: 'mute_creator', authorId: other.id })).status).toBe(200);
    ids = await reelsFeed(viewer);
    expect(ids).toContain(kept);
    expect(ids).not.toContain(skipped);
    expect(ids).not.toContain(muted);
  });
});

describe('story strip', () => {
  it('keeps the newest stories when more than 300 are open, oldest first within a person', async () => {
    const author = await signUp(t.app);
    const viewer = await signUp(t.app);
    await as(t.app, viewer).post(`/v1/users/${author.id}/follow`);
    // 305 permanent stories from last month, then a new one.
    await db().query(
      `INSERT INTO moments (author_id, body, visibility, created_at)
       SELECT $1, 'old ' || g, 'public', now() - interval '30 days' + g * interval '1 minute' FROM generate_series(1, 305) g`,
      [author.id],
    );
    const fresh = await as(t.app, author).post('/v1/moments', { body: 'Today', visibility: 'public', expiresIn: '24h' });
    expect(fresh.status).toBe(201);
    const strip = await as(t.app, viewer).get('/v1/moments');
    const group = strip.body.items.find((g: { author: { id: string } }) => g.author.id === author.id);
    const bodies = group.moments.map((m: { body: string }) => m.body);
    expect(bodies.at(-1)).toBe('Today');
    expect(bodies).not.toContain('old 1');
    expect(bodies[0]).toBe('old 7');
  });
});

describe("videos that can't be processed", () => {
  it('are marked failed when processing gives up, and Studio says so', async () => {
    const u = await signUp(t.app);
    const junk = await t.ctx.storage.put(Buffer.from('not a video at all, just some bytes'), 'mp4', 'video/mp4');
    const { rows } = await db().query(
      `INSERT INTO media (owner_id, kind, url, mime, status, storage_key) VALUES ($1,'video',$2,'video/mp4','ready',$3) RETURNING id`,
      [u.id, junk.url, junk.key],
    );
    const id = rows[0].id as string;
    const handler = mediaJobHandlers({ db: db(), storage: t.ctx.storage })['media.process'];
    // A try that will be retried leaves it waiting; the last one marks it failed.
    await expect(handler({ mediaId: id }, { lastAttempt: false })).rejects.toThrow();
    expect((await as(t.app, u).get(`/v1/media/${id}`)).body.media.status).toBe('ready');
    await expect(handler({ mediaId: id }, { lastAttempt: true })).rejects.toThrow();
    const m = (await as(t.app, u).get(`/v1/media/${id}`)).body.media;
    expect(m).toMatchObject({ status: 'failed', processed: false });
    expect(m.error).toBeTruthy();
    const listed = (await as(t.app, u).get('/v1/me/videos')).body.items.find((v: { id: string }) => v.id === id);
    expect(listed).toMatchObject({ processed: false, failed: true });
  });

  it("Studio's list leaves out view-once and deleted videos", async () => {
    const u = await signUp(t.app);
    const add = async (privateFlag: boolean, deleted: boolean) =>
      (
        await db().query(
          `INSERT INTO media (owner_id, kind, url, mime, status, private, deleted_at)
           VALUES ($1,'video','http://localhost:4000/media/v.mp4','video/mp4','ready',$2, CASE WHEN $3 THEN now() END) RETURNING id`,
          [u.id, privateFlag, deleted],
        )
      ).rows[0].id as string;
    const kept = await add(false, false);
    const viewOnce = await add(true, false);
    const deleted = await add(false, true);
    const ids = (await as(t.app, u).get('/v1/me/videos')).body.items.map((v: { id: string }) => v.id);
    expect(ids).toContain(kept);
    expect(ids).not.toContain(viewOnce);
    expect(ids).not.toContain(deleted);
  });
});
