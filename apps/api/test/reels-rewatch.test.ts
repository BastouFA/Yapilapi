import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuiltApp } from '../src/app.ts';
import { as, signUp, testApp, type TestUser } from './helpers.ts';

let t: BuiltApp;
let ada: TestUser;
let bo: TestUser;
const reels: string[] = [];

/** A reel with a video, posted a given number of hours ago. */
async function reel(by: TestUser, hoursAgo: number) {
  const { rows } = await t.ctx.db.query(
    `INSERT INTO media (owner_id, kind, url, mime, status) VALUES ($1,'video','http://localhost:4000/media/r.mp4','video/mp4','ready') RETURNING id, url`,
    [by.id],
  );
  const r = await as(t.app, by).post('/v1/posts', {
    format: 'reel',
    body: `[Dev data] reel ${hoursAgo}`,
    visibility: 'public',
    media: [{ id: rows[0].id, url: rows[0].url, kind: 'video' }],
  });
  expect(r.status).toBe(201);
  await t.ctx.db.query(`UPDATE posts SET created_at = now() - make_interval(hours => $2) WHERE id = $1`, [r.body.post.id, hoursAgo]);
  return r.body.post.id as string;
}
/** Every page (test files share a database, so other files' reels are in there too). */
async function everything(u: TestUser) {
  const ids: string[] = [];
  const rewatch: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 200; i++) {
    const res = await as(t.app, u).get(`/v1/reels?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    expect(res.status).toBe(200);
    ids.push(...(res.body.items as { id: string }[]).map((p) => p.id));
    rewatch.push(...(res.body.rewatch as string[]));
    cursor = res.body.nextCursor;
    if (!cursor) break;
  }
  return { ids, rewatch };
}
const mine = (ids: string[]) => ids.filter((id) => reels.includes(id));

beforeAll(async () => {
  t = await testApp();
  ada = await signUp(t.app, { birthDate: '1990-04-02' });
  bo = await signUp(t.app, { birthDate: '1990-04-02' });
  for (const h of [30, 10, 20]) reels.push(await reel(ada, h));
});
afterAll(() => t.close());

describe('Reels never run dry', () => {
  it('watched reels come back after the new ones, marked, newest posted first, and your own are there', async () => {
    const first = await everything(bo);
    // Not watched yet: all there, and none of them marked.
    expect([...new Set(mine(first.ids))].sort()).toEqual([...reels].sort());
    // Bo watches them all.
    for (const id of reels) {
      const seen = await as(t.app, bo).post('/v1/feed/events', {
        events: [
          { postId: id, kind: 'impression', surface: 'reels' },
          { postId: id, kind: 'complete', surface: 'reels' },
        ],
      });
      expect(seen.status).toBeLessThan(300);
    }
    const again = await everything(bo);
    expect(mine(again.rewatch)).toEqual([reels[1], reels[2], reels[0]]);
    // The author sees their own too.
    const own = await everything(ada);
    expect([...new Set(mine(own.ids))].sort()).toEqual([...reels].sort());
  });

  it('For you carries on with every reel once the new posts run out, seen ones included', async () => {
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let i = 0; i < 200; i++) {
      const res = await as(t.app, bo).get(`/v1/feed?mode=for_you&limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(res.status).toBe(200);
      for (const p of res.body.items as { id: string }[]) seen.add(p.id);
      cursor = res.body.nextCursor;
      if (!cursor) break;
    }
    for (const id of reels) expect(seen.has(id)).toBe(true);
  });

  it('the part past the new ones pages through without repeating itself', async () => {
    const { ids, rewatch } = await everything(bo);
    expect(new Set(rewatch).size).toBe(rewatch.length);
    const seen = new Set(ids);
    for (const id of reels) expect(seen.has(id)).toBe(true);
  });
});
