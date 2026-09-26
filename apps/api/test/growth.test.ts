import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';
import { processJobs } from '../src/lib/jobs.ts';
import { probe, run } from '../src/lib/media-processing.ts';
import { END_CARD_SECONDS, renderShareVideo, shareVideoJobHandlers } from '../src/lib/share-video.ts';

let t: BuiltApp;
let salt: string;
const UPLOADS = '/tmp/ypl-test-uploads';

beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.close();
});

const adult = () => signUp(t.app, { birthDate: '1990-01-01' });
const verify = (u: TestUser) => t.ctx.db.query(`UPDATE users SET email_verified_at = now() WHERE id = $1`, [u.id]);
const hashOf = (kind: string, value: string) => createHash('sha256').update(`${salt}:${kind}:${value}`).digest('hex');

/** analytics are written without waiting; give them a moment. */
async function events(userId: string, name: string) {
  for (let i = 0; i < 20; i++) {
    const { rows } = await t.ctx.db.query(`SELECT properties FROM analytics_events WHERE user_id = $1 AND name = $2`, [userId, name]);
    if (rows.length) return rows.map((r) => r.properties);
    await new Promise((r) => setTimeout(r, 50));
  }
  return [];
}

describe('contact matching', () => {
  it('matches hashed verified emails of people who allow it, and nothing else', async () => {
    const me = await adult();
    const res = await as(t.app, me).get('/v1/contacts/salt');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ kinds: ['email'], maxHashes: 2000 });
    salt = res.body.salt;
    expect(salt).toMatch(/^[0-9a-f]{64}$/);
    // Fixed per deployment.
    expect((await as(t.app, me).get('/v1/contacts/salt')).body.salt).toBe(salt);

    const friend = await adult();
    await verify(friend);
    const unverified = await adult();
    const optedOut = await adult();
    await verify(optedOut);
    expect((await as(t.app, optedOut).put('/v1/me/sharing', { findableByContacts: false })).body.settings.findableByContacts).toBe(false);
    const teen = await signUp(t.app, { birthDate: new Date(Date.now() - 15 * 365.25 * 86400_000).toISOString().slice(0, 10) });
    await verify(teen);
    const blocker = await adult();
    await verify(blocker);
    await as(t.app, blocker).post(`/v1/users/${me.id}/block`);
    await verify(me);
    await as(t.app, me).post(`/v1/users/${friend.id}/follow`);

    const people = [friend, unverified, optedOut, teen, blocker, me];
    const hashes = [...people.map((p) => hashOf('email', p.email)), hashOf('email', 'nobody@example.test'), hashOf('phone', '+15555550100')];
    const match = await as(t.app, me).post('/v1/contacts/match', { hashes, source: 'web' });
    expect(match.status).toBe(200);
    expect(match.body.items).toHaveLength(1);
    expect(match.body.items[0]).toMatchObject({
      user: { id: friend.id, username: friend.username },
      following: true,
      followsYou: false,
      hashes: [hashOf('email', friend.email)],
    });

    // Upper-case hex is fine; the email itself is normalized on the device before hashing.
    const upper = await as(t.app, me).post('/v1/contacts/match', { hashes: [hashOf('email', friend.email).toUpperCase()] });
    expect(upper.body.items.map((i: any) => i.user.id)).toEqual([friend.id]);

    // The hashes are never kept: only counts reach analytics.
    const tracked = await events(me.id, 'contacts_matched');
    expect(tracked[0]).toMatchObject({ submitted: hashes.length, matched: 1, source: 'web' });
    const leaked = await t.ctx.db.query(`SELECT count(*) AS n FROM analytics_events WHERE properties::text LIKE '%' || $1 || '%'`, [hashes[0]]);
    expect(Number(leaked.rows[0].n)).toBe(0);
  });

  it('caps a request at 2,000 hashes and rejects anything that is not a hash', async () => {
    const me = await adult();
    const many = Array.from({ length: 2001 }, (_, i) => createHash('sha256').update(String(i)).digest('hex'));
    expect((await as(t.app, me).post('/v1/contacts/match', { hashes: many })).status).toBe(400);
    expect((await as(t.app, me).post('/v1/contacts/match', { hashes: many.slice(0, 2000) })).status).toBe(200);
    expect((await as(t.app, me).post('/v1/contacts/match', { hashes: ['someone@example.test'] })).status).toBe(400);
    expect((await as(t.app, null).post('/v1/contacts/match', { hashes: many.slice(0, 1) })).status).toBe(401);
  });

  it('keeps the setting on by default for adults and off, unchangeable, for under-18s', async () => {
    const grown = await adult();
    expect((await as(t.app, grown).get('/v1/me/sharing')).body.settings).toEqual({ findableByContacts: true, allowDownload: true, locked: false });
    const teen = await signUp(t.app, { birthDate: new Date(Date.now() - 16 * 365.25 * 86400_000).toISOString().slice(0, 10) });
    expect((await as(t.app, teen).get('/v1/me/sharing')).body.settings).toEqual({ findableByContacts: false, allowDownload: false, locked: true });
    expect((await as(t.app, teen).put('/v1/me/sharing', { findableByContacts: true })).status).toBe(403);
    expect((await as(t.app, teen).put('/v1/me/sharing', { allowDownload: true })).status).toBe(403);
  });
});

async function makeReel(owner: TestUser, opts: { storageKey?: string | null; status?: string; visibility?: string } = {}) {
  const { rows } = await t.ctx.db.query(
    `INSERT INTO media (owner_id, kind, url, mime, status, duration_ms, storage_key) VALUES ($1,'video',$2,'video/mp4',$3,1000,$4) RETURNING id, url`,
    [
      owner.id,
      `http://localhost:4000/media/${opts.storageKey ?? 'test.mp4'}`,
      opts.status ?? 'ready',
      opts.storageKey === undefined ? 'test.mp4' : opts.storageKey,
    ],
  );
  const res = await as(t.app, owner).post('/v1/posts', {
    format: 'reel',
    body: 'A short one',
    visibility: opts.visibility ?? 'public',
    media: [{ id: rows[0].id, url: rows[0].url, kind: 'video' }],
  });
  expect(res.status).toBe(201);
  return res.body.post.id as string;
}

const shareJobs = async (postId: string) =>
  Number((await t.ctx.db.query(`SELECT count(*) AS n FROM jobs WHERE kind = 'share.render' AND payload->>'postId' = $1`, [postId])).rows[0].n);

describe('share a reel as a video', () => {
  it('only for reels whose creator allows downloads, and queues one render per reel', async () => {
    const creator = await adult();
    const fan = await adult();
    const reel = await makeReel(creator);

    // Public account: downloads are on by default.
    expect((await as(t.app, fan).get(`/v1/posts/${reel}`)).body.post.downloadable).toBe(true);
    expect((await as(t.app, fan).get(`/v1/posts/${reel}/share-video`)).body).toMatchObject({ status: 'none', url: null });
    const first = await as(t.app, fan).post(`/v1/posts/${reel}/share-video`);
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ status: 'queued', url: null, fileName: `yapilapi-${creator.username}-${reel.slice(0, 8)}.mp4` });
    expect(await shareJobs(reel)).toBe(1);
    // Asking again (anyone) reuses the same render.
    expect((await as(t.app, fan).post(`/v1/posts/${reel}/share-video`)).status).toBe(202);
    expect((await as(t.app, creator).post(`/v1/posts/${reel}/share-video`)).status).toBe(202);
    expect(await shareJobs(reel)).toBe(1);
    expect((await as(t.app, fan).get(`/v1/posts/${reel}/share-video`)).body.status).toBe('queued');
    expect(await events(fan.id, 'share_video_requested')).toHaveLength(1);

    // The creator turns downloads off: others can't, the creator still can.
    await as(t.app, creator).put('/v1/me/sharing', { allowDownload: false });
    expect((await as(t.app, fan).get(`/v1/posts/${reel}`)).body.post.downloadable).toBe(false);
    expect((await as(t.app, fan).post(`/v1/posts/${reel}/share-video`)).status).toBe(403);
    expect((await as(t.app, fan).get(`/v1/posts/${reel}/share-video`)).status).toBe(403);
    expect((await as(t.app, creator).post(`/v1/posts/${reel}/share-video`)).status).toBe(202);
  });

  it('refuses posts that are not reels, reels you cannot see, and videos still processing', async () => {
    const creator = await adult();
    const stranger = await adult();
    const plain = (await as(t.app, creator).post('/v1/posts', { body: 'Just words' })).body.post.id;
    expect((await as(t.app, stranger).post(`/v1/posts/${plain}/share-video`)).status).toBe(400);

    const followersOnly = await makeReel(creator, { visibility: 'followers' });
    expect((await as(t.app, stranger).post(`/v1/posts/${followersOnly}/share-video`)).status).toBe(404);
    await as(t.app, stranger).post(`/v1/users/${creator.id}/follow`);
    expect((await as(t.app, stranger).post(`/v1/posts/${followersOnly}/share-video`)).status).toBe(202);

    const processing = await makeReel(creator, { status: 'processing' });
    expect((await as(t.app, stranger).post(`/v1/posts/${processing}/share-video`)).status).toBe(409);
    const external = await makeReel(creator, { storageKey: null });
    expect((await as(t.app, stranger).post(`/v1/posts/${external}/share-video`)).status).toBe(422);
    expect((await as(t.app, null).post(`/v1/posts/${followersOnly}/share-video`)).status).toBe(401);
  });

  it('keeps downloads off for private accounts by default and always for under-18s', async () => {
    const quiet = await adult();
    await as(t.app, quiet).patch('/v1/me/profile', { isPrivate: true });
    const follower = await adult();
    await as(t.app, follower).post(`/v1/users/${quiet.id}/follow`);
    const reel = await makeReel(quiet);
    expect((await as(t.app, follower).post(`/v1/posts/${reel}/share-video`)).status).toBe(403);
    // A private account can choose to allow it.
    await as(t.app, quiet).put('/v1/me/sharing', { allowDownload: true });
    expect((await as(t.app, follower).post(`/v1/posts/${reel}/share-video`)).status).toBe(202);

    const teen = await signUp(t.app, { birthDate: new Date(Date.now() - 16 * 365.25 * 86400_000).toISOString().slice(0, 10) });
    const friendOfTeen = await signUp(t.app, { birthDate: new Date(Date.now() - 16 * 365.25 * 86400_000).toISOString().slice(0, 10) });
    await as(t.app, friendOfTeen).post(`/v1/users/${teen.id}/follow`);
    const teenReel = await makeReel(teen);
    expect((await as(t.app, friendOfTeen).get(`/v1/posts/${teenReel}`)).body.post.downloadable).toBe(false);
    expect((await as(t.app, friendOfTeen).post(`/v1/posts/${teenReel}/share-video`)).status).toBe(403);
  });

  it('renders the watermarked video with an end card and serves the cached file', async () => {
    const creator = await adult();
    const fan = await adult();
    // A tiny generated clip with sound, stored like an upload.
    const key = `tests/${Date.now()}-reel.mp4`;
    await mkdir(path.dirname(path.join(UPLOADS, key)), { recursive: true });
    await run([
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=180x320:rate=15:duration=1',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      path.join(UPLOADS, key),
    ]);
    const reel = await makeReel(creator, { storageKey: key });
    expect((await as(t.app, fan).post(`/v1/posts/${reel}/share-video`)).status).toBe(202);

    const handlers = shareVideoJobHandlers({ db: t.ctx.db, storage: t.ctx.storage });
    while (await processJobs(t.ctx.db, handlers));
    const ready = await as(t.app, fan).get(`/v1/posts/${reel}/share-video`);
    expect(ready.body.status).toBe('ready');
    expect(ready.body.url).toMatch(new RegExp(`/media/shares/${reel}/[0-9a-f-]+\\.mp4$`));

    const stored = (await t.ctx.db.query(`SELECT storage_key FROM share_videos WHERE post_id = $1`, [reel])).rows[0].storage_key;
    const info = await probe(path.join(UPLOADS, stored));
    expect(info).toMatchObject({ width: 180, height: 320, hasAudio: true });
    expect(info.durationMs!).toBeGreaterThanOrEqual(1000 + END_CARD_SECONDS * 1000 - 150);
    expect(info.durationMs!).toBeLessThan(1000 + END_CARD_SECONDS * 1000 + 400);

    // Cached: asking again returns the file at once, without another render.
    const again = await as(t.app, creator).post(`/v1/posts/${reel}/share-video`);
    expect(again.status).toBe(200);
    expect(again.body.url).toBe(ready.body.url);
    expect(await shareJobs(reel)).toBe(1);

    // A new @name means a new render (the old handle is drawn on the video).
    await t.ctx.db.query(`UPDATE profiles SET username = $2 WHERE user_id = $1`, [creator.id, `${creator.username.slice(0, 24)}_new`]);
    expect((await as(t.app, fan).get(`/v1/posts/${reel}/share-video`)).body.status).toBe('none');
    expect((await as(t.app, fan).post(`/v1/posts/${reel}/share-video`)).status).toBe(202);
    expect(await shareJobs(reel)).toBe(2);
  });

  it('renders silent videos too', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ypl-share-test-'));
    try {
      const input = path.join(dir, 'in.mp4');
      await run(['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', input]);
      const out = path.join(dir, 'out.mp4');
      await renderShareVideo(input, out, 'someone.with_a_long_name');
      const info = await probe(out);
      expect(info).toMatchObject({ width: 320, height: 180, hasAudio: false });
      expect((await stat(out)).size).toBeGreaterThan(1000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('onboarding', () => {
  it('suggests active creators, tracks onboarding_completed with its steps once', async () => {
    const creator = await adult();
    await as(t.app, creator).post('/v1/posts', { body: 'Hello #growthtesttopic' });
    const lurker = await adult();
    const me = await adult();
    await as(t.app, me).put('/v1/me/interests', { topics: ['growthtesttopic'] });

    const creators = (await as(t.app, me).get('/v1/me/suggestions?kind=creators&limit=30')).body.items.map((i: any) => i.user.id);
    expect(creators).toContain(creator.id);
    expect(creators).not.toContain(lurker.id);
    expect(creators[0]).toBe(creator.id);

    // For you uses the new interests straight away.
    const feed = await as(t.app, me).get('/v1/feed?mode=for_you');
    const post = feed.body.items.find((p: any) => p.author.id === creator.id);
    expect(post?.reason).toBe("You're interested in growthtesttopic");

    await as(t.app, me).post(`/v1/users/${creator.id}/follow`);
    const steps = [
      { step: 'interests', skipped: false, count: 1 },
      { step: 'follow', skipped: false, count: 1 },
      { step: 'friends', skipped: true, count: 0 },
    ];
    expect((await as(t.app, me).post('/v1/me/onboarding/complete', { platform: 'web', steps })).status).toBe(200);
    expect((await as(t.app, me).post('/v1/me/onboarding/complete', { platform: 'web', steps })).status).toBe(200);
    const done = await events(me.id, 'onboarding_completed');
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ platform: 'web', steps, completedSteps: ['interests', 'follow'], following: 1 });
    expect((await as(t.app, me).get('/v1/auth/me')).body.user.onboarded).toBe(true);
    // The old call without a body still works.
    const other = await adult();
    expect((await as(t.app, other).post('/v1/me/onboarding/complete')).status).toBe(200);
  });
});
