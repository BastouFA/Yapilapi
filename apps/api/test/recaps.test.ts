import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RECAP_DAILY_LIMIT } from '@yapilapi/shared';
import { processJobs } from '../src/lib/jobs.ts';
import { mediaJobHandlers, probe, run } from '../src/lib/media-processing.ts';
import { planRecap, preselect, recapJobHandlers, titleWithSharp, wrapTitle } from '../src/lib/recaps.ts';
import { as, signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';

const UPLOADS = '/tmp/ypl-test-uploads';
let t: BuiltApp;
const colours = [
  { r: 200, g: 60, b: 40 },
  { r: 40, g: 160, b: 90 },
  { r: 50, g: 80, b: 200 },
];

beforeAll(async () => {
  t = await testApp();
  await t.ctx.db.query(`INSERT INTO feature_flags (key, enabled) VALUES ('MEMORY', true) ON CONFLICT (key) DO UPDATE SET enabled = true`);
});
afterAll(async () => {
  await t.close();
});

const handlers = () => ({
  ...mediaJobHandlers({ db: t.ctx.db, storage: t.ctx.storage }),
  ...recapJobHandlers({ db: t.ctx.db, storage: t.ctx.storage, realtime: t.ctx.realtime }),
});
async function drain() {
  for (let i = 0; i < 20; i++) if (!(await processJobs(t.ctx.db, handlers()))) return;
}

let photoN = 0;
/** A tiny photo in one colour, uploaded like any other. */
async function uploadPhoto(user: TestUser): Promise<{ id: string; url: string }> {
  const c = colours[photoN++ % colours.length]!;
  const data = await sharp({ create: { width: 64, height: 48, channels: 3, background: c } })
    .jpeg({ quality: 90 })
    .toBuffer();
  const boundary = `----ypl${Date.now()}${photoN}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="p${photoN}.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await t.app.inject({
    method: 'POST',
    url: '/v1/media',
    payload,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${user.token}` },
  });
  expect(res.statusCode).toBe(201);
  return { id: res.json().media.id, url: res.json().media.url };
}

async function photoPost(user: TestUser, visibility = 'public') {
  const m = await uploadPhoto(user);
  const res = await as(t.app, user).post('/v1/posts', { body: 'A day out', visibility, media: [{ id: m.id, url: m.url, kind: 'image' }] });
  expect(res.status).toBe(201);
  return { postId: res.body.post.id as string, mediaId: m.id };
}

async function memoryWith(owner: TestUser, postIds: string[]) {
  const id = (await as(t.app, owner).post('/v1/memories', { title: 'Lagos weekend' })).body.memory.id as string;
  for (const p of postIds) expect((await as(t.app, owner).post(`/v1/memories/${id}/items`, { itemType: 'post', itemId: p })).status).toBe(201);
  return id;
}

async function befriend(a: TestUser, b: TestUser) {
  await as(t.app, a).post(`/v1/users/${b.id}/friend-request`);
  const req = (await as(t.app, b).get('/v1/me/friend-requests')).body.items[0];
  await as(t.app, b).post(`/v1/friend-requests/${req.id}/accept`);
}

/** A public reel with a tone, whose audio becomes a sound anyone can use. */
async function soundFromReel(creator: TestUser): Promise<string> {
  const key = `tests/${Date.now()}-recap-sound.mp4`;
  await mkdir(path.dirname(path.join(UPLOADS, key)), { recursive: true });
  await run([
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=180x320:rate=15:duration=2',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=330:duration=2',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    path.join(UPLOADS, key),
  ]);
  const { rows } = await t.ctx.db.query(
    `INSERT INTO media (owner_id, kind, url, mime, status, duration_ms, storage_key) VALUES ($1,'video',$2,'video/mp4','ready',2000,$3) RETURNING id, url`,
    [creator.id, `http://localhost/media/${key}`, key],
  );
  const res = await as(t.app, creator).post('/v1/posts', {
    format: 'reel',
    body: 'Hum',
    visibility: 'public',
    media: [{ id: rows[0].id, url: rows[0].url, kind: 'video' }],
  });
  expect(res.status).toBe(201);
  return (await t.ctx.db.query(`SELECT sound_id FROM posts WHERE id = $1`, [res.body.post.id])).rows[0].sound_id;
}

const recapBody = (sourceId: string, mediaIds: string[], extra: Record<string, unknown> = {}) => ({
  source: 'memory',
  sourceId,
  title: 'Lagos weekend',
  mediaIds,
  style: 'quick',
  aspect: '9:16',
  lengthSeconds: 3,
  ...extra,
});

describe('planning', () => {
  it('fits the chosen length, crossfades included, and never passes 60 seconds', () => {
    const three = [0, 1, 2].map(() => ({ kind: 'image' as const, durationMs: null }));
    const quick = planRecap(three, 'quick', '9:16', 3);
    expect(quick).toMatchObject({ width: 720, height: 1280, totalFrames: 90, transitionFrames: 0 });
    expect(quick.segments.map((s) => s.kind)).toEqual(['title', 'image', 'image', 'image']);

    const calm = planRecap(three, 'calm', '1:1', 3);
    expect(calm).toMatchObject({ width: 720, height: 720 });
    expect(Math.abs(calm.totalSeconds - 3)).toBeLessThan(0.1);

    // Thirty photos and clips in Film: capped at 60 s, clips at 4 s, the last ones dropped rather than flashed.
    const many = Array.from({ length: 30 }, (_, i) => (i % 3 ? { kind: 'image' as const, durationMs: null } : { kind: 'video' as const, durationMs: 9000 }));
    const film = planRecap(many, 'film', '9:16');
    expect(film.totalSeconds).toBeLessThanOrEqual(60.05);
    expect(film.totalSeconds).toBeGreaterThan(55);
    for (const s of film.segments.slice(1)) expect(s.frames / 30).toBeGreaterThanOrEqual(1 + 0.5 - 0.05);
    const clip = film.segments.find((s) => s.kind === 'video')!;
    expect(clip.frames / 30).toBeLessThanOrEqual(4);
    expect(clip.clipStart).toBeGreaterThan(0);
  });

  it('suggests the best-liked, one per post first, in the order they happened', () => {
    const at = (d: number) => new Date(Date.UTC(2024, 0, d)).toISOString();
    const items = [
      { mediaId: 'a', kind: 'image' as const, likes: 1, takenAt: at(1), from: 'post' as const, fromId: 'p1', mine: true, thumbUrl: null, durationMs: null },
      { mediaId: 'b', kind: 'image' as const, likes: 9, takenAt: at(2), from: 'post' as const, fromId: 'p2', mine: true, thumbUrl: null, durationMs: null },
      { mediaId: 'c', kind: 'image' as const, likes: 9, takenAt: at(2), from: 'post' as const, fromId: 'p2', mine: true, thumbUrl: null, durationMs: null },
      { mediaId: 'd', kind: 'image' as const, likes: 5, takenAt: at(3), from: 'post' as const, fromId: 'p3', mine: true, thumbUrl: null, durationMs: null },
    ];
    expect(preselect(items, 2)).toEqual(['b', 'd']);
    expect(preselect(items)).toEqual(['a', 'b', 'c', 'd']);
    // Varied: with room for four, no more than two videos while there are photos.
    const videos = ['v1', 'v2', 'v3'].map((id, i) => ({ ...items[0]!, mediaId: id, kind: 'video' as const, likes: 50 - i, fromId: `pv${i}` }));
    expect(preselect([...items, ...videos], 4)).toEqual(['b', 'd', 'v1', 'v2']);
    expect(wrapTitle('A very long weekend in Lagos with everyone', 12)).toEqual(['A very long', 'weekend in', 'Lagos with…']);
  });

  it('draws the title card with sharp when ffmpeg has no drawtext', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ypl-recap-title-'));
    try {
      const bg = path.join(dir, 'bg.jpg');
      await sharp({ create: { width: 360, height: 640, channels: 3, background: '#101010' } })
        .jpeg()
        .toFile(bg);
      const out = path.join(dir, 'title.jpg');
      await titleWithSharp(bg, out, 360, 640, 'Lagos <weekend> & "friends"', '2023');
      const { data, info } = await sharp(out).greyscale().raw().toBuffer({ resolveWithObject: true });
      expect(info).toMatchObject({ width: 360, height: 640 });
      // White letters across the middle band, nothing but background at the top.
      const bright = (y0: number, y1: number) => {
        let n = 0;
        for (let y = y0; y < y1; y++) for (let x = 0; x < info.width; x++) if (data[y * info.width + x]! > 200) n++;
        return n;
      };
      expect(bright(250, 390)).toBeGreaterThan(200);
      expect(bright(0, 100)).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('recaps', () => {
  it("only takes media the maker can see: never someone else's private post", async () => {
    const alice = await signUp(t.app);
    const bob = await signUp(t.app);
    await befriend(alice, bob);
    const mine = await photoPost(alice);
    const bobsPublic = await photoPost(bob);
    const bobsFriends = await photoPost(bob, 'friends');
    const stranger = await signUp(t.app);
    const hidden = await photoPost(stranger, 'private');
    const memoryId = await memoryWith(alice, [mine.postId, bobsPublic.postId, bobsFriends.postId]);

    const cands = await as(t.app, alice).get(`/v1/recaps/candidates?source=memory&sourceId=${memoryId}`);
    expect(cands.status).toBe(200);
    expect(cands.body.items.map((c: any) => c.mediaId).sort()).toEqual([mine.mediaId, bobsPublic.mediaId, bobsFriends.mediaId].sort());
    expect(cands.body.preselected).toHaveLength(3);
    expect(cands.body.items.find((c: any) => c.mediaId === mine.mediaId).mine).toBe(true);

    // Someone else's private photo, even by id: refused, and nothing is queued.
    const sneaky = await as(t.app, alice).post('/v1/recaps', recapBody(memoryId, [mine.mediaId, hidden.mediaId]));
    expect(sneaky.status).toBe(404);
    expect(sneaky.body.error.details.mediaIds).toEqual([hidden.mediaId]);
    // Not someone else's memory either.
    expect((await as(t.app, stranger).get(`/v1/recaps/candidates?source=memory&sourceId=${memoryId}`)).status).toBe(404);
    expect((await as(t.app, stranger).post('/v1/recaps', recapBody(memoryId, [mine.mediaId]))).status).toBe(404);

    // Bob makes his friends-only post private after she chose it: it's left out when the video is made.
    const made = await as(t.app, alice).post('/v1/recaps', recapBody(memoryId, [mine.mediaId, bobsPublic.mediaId, bobsFriends.mediaId]));
    expect(made.status).toBe(202);
    expect(made.body.recap).toMatchObject({ status: 'queued', itemCount: 3, video: null });
    expect((await as(t.app, bob).patch(`/v1/posts/${bobsFriends.postId}`, { visibility: 'private' })).status).toBe(200);
    await drain();
    const done = (await as(t.app, alice).get(`/v1/recaps/${made.body.recap.id}`)).body.recap;
    expect(done.status).toBe('ready');
    expect(done.usedCount).toBe(2);
    const used = (await t.ctx.db.query(`SELECT used_media_ids FROM recaps WHERE id = $1`, [done.id])).rows[0].used_media_ids;
    expect(used).not.toContain(bobsFriends.mediaId);
    // Bob's public photo is in it: it can be sent in a chat, not posted.
    expect(done).toMatchObject({ canPost: false, canSend: true });

    // Everything hidden since: it fails, in plain words.
    const gone = await as(t.app, alice).post('/v1/recaps', recapBody(memoryId, [bobsPublic.mediaId]));
    await as(t.app, bob).del(`/v1/posts/${bobsPublic.postId}`);
    await drain();
    const failed = (await as(t.app, alice).get(`/v1/recaps/${gone.body.recap.id}`)).body.recap;
    expect(failed).toMatchObject({ status: 'failed', video: null });
    expect(failed.error).toMatch(/available/);
    expect((await t.ctx.db.query(`SELECT type FROM notifications WHERE user_id = $1 AND entity_id = $2`, [alice.id, failed.id])).rows).toEqual([
      { type: 'recap_failed' },
    ]);
  });

  it('takes stories from your own chapters and your posts from this day in earlier years', async () => {
    const alice = await signUp(t.app);
    const bob = await signUp(t.app);
    const photo = await uploadPhoto(alice);
    const story = await as(t.app, alice).post('/v1/moments', { body: 'Beach', mediaId: photo.id, expiresIn: '24h', visibility: 'followers' });
    expect(story.status).toBe(201);
    const chapter = (await as(t.app, alice).post('/v1/chapters', { title: 'Summer', momentIds: [story.body.moment.id] })).body.chapter;
    const cands = await as(t.app, alice).get(`/v1/recaps/candidates?source=chapter&sourceId=${chapter.id}`);
    expect(cands.body).toMatchObject({ title: 'Summer', preselected: [photo.id] });
    expect(cands.body.items[0]).toMatchObject({ from: 'story', mine: true, kind: 'image' });
    // Only the owner's own chapters.
    expect((await as(t.app, bob).get(`/v1/recaps/candidates?source=chapter&sourceId=${chapter.id}`)).status).toBe(404);
    // A time capsule that hasn't opened can't be looked into.
    await t.ctx.db.query(`UPDATE chapters SET opens_at = now() + interval '30 days' WHERE id = $1`, [chapter.id]);
    expect((await as(t.app, alice).get(`/v1/recaps/candidates?source=chapter&sourceId=${chapter.id}`)).status).toBe(404);

    // On this day: her post from a year ago today, not today's, and never Bob's.
    const old = await photoPost(alice);
    await photoPost(alice);
    const bobsOld = await photoPost(bob);
    await t.ctx.db.query(`UPDATE posts SET created_at = now() - interval '1 year' WHERE id = ANY($1)`, [[old.postId, bobsOld.postId]]);
    const today = await as(t.app, alice).get('/v1/recaps/candidates?source=on_this_day');
    expect(today.body.title).toBe('On this day');
    expect(today.body.items.map((c: any) => c.mediaId)).toEqual([old.mediaId]);
    expect((await as(t.app, alice).post('/v1/recaps', { source: 'on_this_day', title: 'A year ago', mediaIds: [old.mediaId] })).status).toBe(202);
    expect((await as(t.app, alice).post('/v1/recaps', { source: 'on_this_day', title: 'A year ago', mediaIds: [bobsOld.mediaId] })).status).toBe(404);
  });

  it('keeps to its limits: 30 items, a title, usable sounds, 10 a day and 3 at a time', async () => {
    const alice = await signUp(t.app);
    const p = await photoPost(alice);
    const memoryId = await memoryWith(alice, [p.postId]);
    const ids31 = Array.from({ length: 31 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect((await as(t.app, alice).post('/v1/recaps', recapBody(memoryId, ids31))).status).toBe(400);
    expect((await as(t.app, alice).post('/v1/recaps', recapBody(memoryId, [p.mediaId, p.mediaId]))).status).toBe(400);
    expect((await as(t.app, alice).post('/v1/recaps', recapBody(memoryId, [p.mediaId], { title: 'x'.repeat(61) }))).status).toBe(400);
    expect((await as(t.app, alice).post('/v1/recaps', recapBody(memoryId, [p.mediaId], { lengthSeconds: 61 }))).status).toBe(400);
    expect((await as(t.app, alice).post('/v1/recaps', { ...recapBody(memoryId, [p.mediaId]), sourceId: undefined })).status).toBe(400);

    // A sound from a friends-only reel can't be used, as for reels.
    const creator = await signUp(t.app);
    const soundId = await soundFromReel(creator);
    await t.ctx.db.query(`UPDATE posts SET visibility = 'followers' WHERE sound_id = $1`, [soundId]);
    await as(t.app, alice).post(`/v1/users/${creator.id}/follow`);
    expect((await as(t.app, alice).post('/v1/recaps', recapBody(memoryId, [p.mediaId], { soundId }))).status).toBe(403);

    // Three waiting at once, then a pause.
    for (let i = 0; i < 3; i++) expect((await as(t.app, alice).post('/v1/recaps', recapBody(memoryId, [p.mediaId]))).status).toBe(202);
    const busy = await as(t.app, alice).post('/v1/recaps', recapBody(memoryId, [p.mediaId]));
    expect(busy.status).toBe(429);
    expect(busy.body.error.code).toBe('recap_busy');

    // Ten a day, deleted ones included; failed ones don't count.
    await t.ctx.db.query(`UPDATE recaps SET status = 'ready' WHERE owner_id = $1`, [alice.id]);
    await t.ctx.db.query(
      `INSERT INTO recaps (owner_id, source_type, source_id, title, style, aspect, items, status, deleted_at)
       SELECT $1, 'memory', $2, 'Old', 'calm', '9:16', '[]', 'ready', now() FROM generate_series(1, $3::int)`,
      [alice.id, memoryId, RECAP_DAILY_LIMIT - 3],
    );
    await t.ctx.db.query(
      `INSERT INTO recaps (owner_id, source_type, source_id, title, style, aspect, items, status) VALUES ($1, 'memory', $2, 'Broke', 'calm', '9:16', '[]', 'failed')`,
      [alice.id, memoryId],
    );
    expect((await as(t.app, alice).get('/v1/recaps')).body.remainingToday).toBe(0);
    const limited = await as(t.app, alice).post('/v1/recaps', recapBody(memoryId, [p.mediaId]));
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('recap_limit');
    // A day later they can make more.
    await t.ctx.db.query(`UPDATE recaps SET created_at = now() - interval '25 hours' WHERE owner_id = $1`, [alice.id]);
    expect((await as(t.app, alice).get(`/v1/recaps/candidates?source=memory&sourceId=${memoryId}`)).body.remainingToday).toBe(RECAP_DAILY_LIMIT);

    // Off with the Memory flag.
    await t.ctx.db.query(`UPDATE feature_flags SET enabled = false WHERE key = 'MEMORY'`);
    expect((await as(t.app, alice).get('/v1/recaps')).status).toBe(404);
    await t.ctx.db.query(`UPDATE feature_flags SET enabled = true WHERE key = 'MEMORY'`);
  });

  it('renders an MP4 of the right shape and length with the sound, private to its maker', async () => {
    const alice = await signUp(t.app);
    const posts = [await photoPost(alice), await photoPost(alice), await photoPost(alice)];
    const memoryId = await memoryWith(
      alice,
      posts.map((p) => p.postId),
    );
    const creator = await signUp(t.app);
    const soundId = await soundFromReel(creator);
    const res = await as(t.app, alice).post(
      '/v1/recaps',
      recapBody(
        memoryId,
        posts.map((p) => p.mediaId),
        { style: 'quick', aspect: '9:16', soundId, title: 'A weekend: "quotes", 100% & more' },
      ),
    );
    expect(res.status).toBe(202);
    const id = res.body.recap.id as string;
    // Rendering, not ready yet: nothing to play.
    expect((await as(t.app, alice).get(`/v1/recaps/${id}`)).body.recap.video).toBeNull();
    await drain();

    const recap = (await as(t.app, alice).get(`/v1/recaps/${id}`)).body.recap;
    expect(recap).toMatchObject({ status: 'ready', usedCount: 3, canPost: true, canSend: true, sound: { id: soundId } });
    expect(recap.video.url).toMatch(/_web\.mp4$/);
    expect(recap.video.posterUrl).toMatch(/_recap\.jpg$/);
    expect(recap.video.hlsUrl).toMatch(/index\.m3u8$/);
    expect(recap.fileName).toMatch(/^a-weekend-quotes-100-more-[0-9a-f]{8}\.mp4$/);
    const media = (await t.ctx.db.query(`SELECT storage_key, status, owner_id, kind FROM media WHERE id = $1`, [recap.video.mediaId])).rows[0];
    expect(media).toMatchObject({ status: 'ready', owner_id: alice.id, kind: 'video' });
    const info = await probe(path.join(UPLOADS, media.storage_key));
    expect(info).toMatchObject({ width: 720, height: 1280, hasAudio: true });
    expect(Math.abs(info.durationMs! - 3000)).toBeLessThan(150);
    const notes = await t.ctx.db.query(`SELECT type, data FROM notifications WHERE user_id = $1 AND entity_id = $2`, [alice.id, id]);
    expect(notes.rows).toEqual([{ type: 'recap_ready', data: { title: 'A weekend: "quotes", 100% & more' } }]);

    // Only its maker sees it.
    const bob = await signUp(t.app);
    expect((await as(t.app, bob).get(`/v1/recaps/${id}`)).status).toBe(404);
    expect((await as(t.app, bob).get('/v1/recaps')).body.items).toEqual([]);
    expect((await as(t.app, bob).del(`/v1/recaps/${id}`)).status).toBe(404);
    expect((await as(t.app, alice).get('/v1/recaps')).body.items.map((r: any) => r.id)).toContain(id);

    // Square works too.
    const square = await as(t.app, alice).post('/v1/recaps', recapBody(memoryId, [posts[0]!.mediaId], { style: 'film', aspect: '1:1' }));
    await drain();
    const sq = (await t.ctx.db.query(`SELECT m.storage_key FROM recaps r JOIN media m ON m.id = r.media_id WHERE r.id = $1`, [square.body.recap.id])).rows[0];
    expect(await probe(path.join(UPLOADS, sq.storage_key))).toMatchObject({ width: 720, height: 720, hasAudio: false });

    // Deleting removes the file.
    const file = path.join(UPLOADS, media.storage_key);
    expect(existsSync(file)).toBe(true);
    expect((await as(t.app, alice).del(`/v1/recaps/${id}`)).body).toEqual({ ok: true, fileRemoved: true });
    expect(existsSync(file)).toBe(false);
    expect(existsSync(file.replace(/\.mp4$/, '_web.mp4'))).toBe(false);
    expect((await as(t.app, alice).get(`/v1/recaps/${id}`)).status).toBe(404);
    expect((await t.ctx.db.query(`SELECT 1 FROM media WHERE id = $1`, [recap.video.mediaId])).rowCount).toBe(0);
  });

  it('posts as a reel through the normal publishing checks, and only when everything in it is yours', async () => {
    const alice = await signUp(t.app);
    const bob = await signUp(t.app);
    await befriend(alice, bob);
    const mine = await photoPost(alice);
    const bobsFriends = await photoPost(bob, 'friends');
    const memoryId = await memoryWith(alice, [mine.postId, bobsFriends.postId]);
    const creator = await signUp(t.app);
    const soundId = await soundFromReel(creator);
    const own = (await as(t.app, alice).post('/v1/recaps', recapBody(memoryId, [mine.mediaId], { soundId }))).body.recap.id;
    const mixed = (await as(t.app, alice).post('/v1/recaps', recapBody(memoryId, [mine.mediaId, bobsFriends.mediaId]))).body.recap.id;
    await drain();
    const ownRecap = (await as(t.app, alice).get(`/v1/recaps/${own}`)).body.recap;
    const mixedRecap = (await as(t.app, alice).get(`/v1/recaps/${mixed}`)).body.recap;
    expect(ownRecap).toMatchObject({ status: 'ready', canPost: true });
    expect(mixedRecap).toMatchObject({ status: 'ready', canPost: false, canSend: false });

    const reel = (r: any, extra: Record<string, unknown> = {}) => ({
      format: 'reel',
      body: 'Our weekend',
      visibility: 'public',
      media: [{ id: r.video.mediaId, url: r.video.url, kind: 'video' }],
      ...extra,
    });
    // The usual checks apply: harmful text is refused, and a recap is only ever a reel, with its own sound.
    const harmful = await as(t.app, alice).post('/v1/posts', reel(ownRecap, { body: 'go kill yourself' }));
    expect(harmful.status).toBe(422);
    expect(harmful.body.error.code).toBe('content_blocked');
    expect((await as(t.app, alice).post('/v1/posts', { ...reel(ownRecap), format: 'post' })).status).toBe(400);
    const otherSound = await soundFromReel(creator);
    expect((await as(t.app, alice).post('/v1/posts', reel(ownRecap, { soundId: otherSound }))).status).toBe(400);
    // The sound's reel stops allowing remixes: the recap can't go out with it.
    await t.ctx.db.query(`UPDATE posts SET allow_remix = false WHERE sound_id = $1 AND format = 'reel' AND author_id = $2`, [soundId, creator.id]);
    expect((await as(t.app, alice).post('/v1/posts', reel(ownRecap))).status).toBe(403);
    await t.ctx.db.query(`UPDATE posts SET allow_remix = true WHERE sound_id = $1 AND author_id = $2`, [soundId, creator.id]);

    const posted = await as(t.app, alice).post('/v1/posts', reel(ownRecap));
    expect(posted.status).toBe(201);
    expect(posted.body.post.format).toBe('reel');
    expect((await t.ctx.db.query(`SELECT sound_id FROM posts WHERE id = $1`, [posted.body.post.id])).rows[0].sound_id).toBe(soundId);
    // Bob sees her reel, like any post.
    expect((await as(t.app, bob).get(`/v1/posts/${posted.body.post.id}`)).status).toBe(200);

    // With Bob's friends-only photo in it: not as a post, a draft, a story or in a chat.
    const refused = await as(t.app, alice).post('/v1/posts', reel(mixedRecap));
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('recap_not_postable');
    expect((await as(t.app, alice).post('/v1/posts', reel(mixedRecap, { draft: true }))).status).toBe(403);
    expect((await as(t.app, alice).post('/v1/moments', { mediaId: mixedRecap.video.mediaId, visibility: 'friends' })).status).toBe(403);
    const conv = (await as(t.app, alice).post('/v1/conversations', { memberIds: [bob.id] })).body.conversation.id;
    const sent = await as(t.app, alice).post(`/v1/conversations/${conv}/messages`, { attachments: [{ mediaId: mixedRecap.video.mediaId }] });
    expect(sent.status).toBe(403);
    expect(sent.body.error.code).toBe('recap_not_sendable');
    // Her own recap goes in a chat through the normal message path.
    expect((await as(t.app, alice).post(`/v1/conversations/${conv}/messages`, { attachments: [{ mediaId: ownRecap.video.mediaId }] })).status).toBe(201);

    // Deleting a recap that went out as a reel keeps the reel's video.
    expect((await as(t.app, alice).del(`/v1/recaps/${own}`)).body).toEqual({ ok: true, fileRemoved: false });
    expect((await as(t.app, bob).get(`/v1/posts/${posted.body.post.id}`)).status).toBe(200);
  });
});
