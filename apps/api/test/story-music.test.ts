import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dualInsetBox, dualComposeSchema, storyMusicInputSchema, storyMusicPart } from '@yapilapi/shared';
import { mediaJobHandlers } from '../src/lib/media-processing.ts';
import { editorJobHandlers } from '../src/lib/media-edit.ts';
import { as, signUp, testApp, type TestUser, jobRunner, type JobRunner } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';

let t: BuiltApp;
let runJobs: JobRunner;
beforeAll(async () => {
  t = await testApp();
  runJobs = await jobRunner(t.ctx.db);
});
afterAll(async () => {
  await t.close();
});

const adult = () => signUp(t.app, { birthDate: '1990-01-01' });

/** A public reel with a 40 second video: its sound is one anyone can use. */
async function reelSound(owner: TestUser, extra: Record<string, unknown> = {}, durationMs = 40_000) {
  const { rows } = await t.ctx.db.query(
    `INSERT INTO media (owner_id, kind, url, mime, status, duration_ms) VALUES ($1,'video','http://localhost:4000/media/test.mp4','video/mp4','ready',$2) RETURNING id, url`,
    [owner.id, durationMs],
  );
  const r = await as(t.app, owner).post('/v1/posts', {
    format: 'reel',
    body: 'A reel',
    media: [{ id: rows[0].id, url: rows[0].url, kind: 'video' }],
    ...extra,
  });
  expect(r.status).toBe(201);
  return r.body.post as { id: string; sound: { id: string } };
}

async function makeFriends(a: TestUser, b: TestUser) {
  const [x, y] = [a.id, b.id].sort();
  await t.ctx.db.query(`INSERT INTO friendships (user_a, user_b) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [x, y]);
}

const story = (u: TestUser, b: Record<string, unknown>) => as(t.app, u).post('/v1/moments', { body: 'Morning', visibility: 'friends', ...b });
const openStory = async (u: TestUser, id: string) => {
  const r = await as(t.app, u).get(`/v1/moments/${id}`);
  return r.status === 200 ? r.body.group.moments[0] : null;
};

describe('story music: schemas', () => {
  it('validates the part and the sticker', () => {
    expect(storyMusicInputSchema.parse({ soundId: randomUUID(), startMs: 0 })).toMatchObject({ durationMs: 15_000, style: 'compact' });
    expect(storyMusicInputSchema.safeParse({ soundId: randomUUID(), startMs: -1 }).success).toBe(false);
    expect(storyMusicInputSchema.safeParse({ soundId: randomUUID(), startMs: 0, durationMs: 15_001 }).success).toBe(false);
    expect(storyMusicInputSchema.safeParse({ soundId: randomUUID(), startMs: 0, durationMs: 4_999 }).success).toBe(false);
    expect(storyMusicInputSchema.safeParse({ soundId: randomUUID(), startMs: 0, style: 'lyrics' }).success).toBe(false);
    expect(storyMusicInputSchema.safeParse({ soundId: randomUUID(), startMs: 0, x: 1.2 }).success).toBe(false);
    expect(storyMusicPart(30_000, 15_000, 40_000)).toEqual({ startMs: 30_000, durationMs: 10_000 });
    expect(storyMusicPart(40_000, 15_000, 40_000)).toBeNull();
    expect(storyMusicPart(5_000, 15_000, null)).toEqual({ startMs: 5_000, durationMs: 15_000 });
  });
});

describe('story music', () => {
  it('needs a sound that exists and that the author may use, like reels', async () => {
    const author = await adult();
    const creator = await adult();
    // A sound that doesn't exist.
    const missing = await story(author, { music: { soundId: randomUUID(), startMs: 0 } });
    expect(missing.status).toBe(404);
    // A sound from a reel the author can see but not use (friends only): 403, like for reels.
    await makeFriends(author, creator);
    const friendsReel = await reelSound(creator, { visibility: 'friends' });
    const notUsable = await story(author, { music: { soundId: friendsReel.sound.id, startMs: 0 } });
    expect(notUsable.status).toBe(403);
    expect(notUsable.body.error.message).toBe("This sound can't be used in new stories.");
    // A sound whose creator turned remixes off can't be used either.
    const closed = await reelSound(creator);
    await as(t.app, creator).put(`/v1/posts/${closed.id}/remix-settings`, { allowRemix: false });
    expect((await story(author, { music: { soundId: closed.sound.id, startMs: 0 } })).status).toBe(403);
    // A sound from a reel the author can't see at all looks like it doesn't exist.
    const stranger = await adult();
    const hidden = await reelSound(stranger, { visibility: 'friends' });
    expect((await story(author, { music: { soundId: hidden.sound.id, startMs: 0 } })).status).toBe(404);
    // Nothing was stored.
    const { rows } = await t.ctx.db.query(`SELECT count(*)::int AS n FROM moments WHERE author_id = $1`, [author.id]);
    expect(rows[0].n).toBe(0);
  });

  it('checks the start and the length of the part', async () => {
    const author = await adult();
    const creator = await adult();
    const reel = await reelSound(creator);
    const past = await story(author, { music: { soundId: reel.sound.id, startMs: 40_000 } });
    expect(past.status).toBe(400);
    expect(past.body.error.details.fields['music.startMs']).toMatch(/40 seconds long/);
    const tooLong = await story(author, { music: { soundId: reel.sound.id, startMs: 0, durationMs: 20_000 } });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.details.fields['music.durationMs']).toBeTruthy();
    expect((await story(author, { music: { soundId: reel.sound.id, startMs: 0, durationMs: 2_000 } })).status).toBe(400);
    expect((await story(author, { music: { soundId: reel.sound.id, startMs: -5 } })).status).toBe(400);
    expect((await story(author, { music: { soundId: reel.sound.id, startMs: 0, style: 'lyrics' } })).status).toBe(400);

    // Near the end, the part is what's left of the sound.
    const ok = await story(author, { music: { soundId: reel.sound.id, startMs: 32_000, style: 'card', x: 0.3, y: 0.2 } });
    expect(ok.status).toBe(201);
    const mine = await openStory(author, ok.body.moment.id);
    expect(mine.music).toMatchObject({
      sound: { id: reel.sound.id, artist: expect.any(String), audioUrl: expect.stringContaining('/media/') },
      startMs: 32_000,
      durationMs: 8_000,
      style: 'card',
      x: 0.3,
      y: 0.2,
    });
    // Music alone is a story too.
    expect((await as(t.app, author).post('/v1/moments', { music: { soundId: reel.sound.id, startMs: 0 } })).status).toBe(201);
  });

  it('shows the music only to people who can see the story, and only while they can see the sound', async () => {
    const author = await adult();
    const friend = await adult();
    const stranger = await adult();
    const creator = await adult();
    await makeFriends(author, friend);
    const reel = await reelSound(creator);
    const s = await story(author, { music: { soundId: reel.sound.id, startMs: 5_000 } });
    expect(s.status).toBe(201);
    const id = s.body.moment.id as string;

    expect((await openStory(friend, id)).music).toMatchObject({ sound: { id: reel.sound.id }, startMs: 5_000, durationMs: 15_000, style: 'compact' });
    const strip = await as(t.app, friend).get('/v1/moments');
    const inStrip = strip.body.items.flatMap((g: any) => g.moments).find((m: any) => m.id === id);
    expect(inStrip.music.sound.id).toBe(reel.sound.id);
    // A friends-only story is out of reach for others, music and all.
    expect(await openStory(stranger, id)).toBeNull();
    const theirs = await as(t.app, stranger).get('/v1/moments');
    expect(theirs.body.items.flatMap((g: any) => g.moments).some((m: any) => m.id === id)).toBe(false);

    // A public story opens for anyone; the music comes with it.
    const pub = await story(author, { visibility: 'public', music: { soundId: reel.sound.id, startMs: 0 } });
    expect((await openStory(stranger, pub.body.moment.id)).music.sound.id).toBe(reel.sound.id);
    // Someone the sound's creator blocked still sees the story, without the music.
    await t.ctx.db.query(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1,$2)`, [creator.id, stranger.id]);
    const blocked = await openStory(stranger, pub.body.moment.id);
    expect(blocked).not.toBeNull();
    expect(blocked.music).toBeNull();
  });

  it('plays instead of a video story’s own sound, and is not allowed on audio stories', async () => {
    const author = await adult();
    const creator = await adult();
    const reel = await reelSound(creator);
    const { rows } = await t.ctx.db.query(
      `INSERT INTO media (owner_id, kind, url, mime, status) VALUES ($1,'video','http://localhost:4000/media/mine.mp4','video/mp4','ready'), ($1,'audio','http://localhost:4000/media/mine.m4a','audio/mp4','ready') RETURNING id, kind`,
      [author.id],
    );
    const video = rows.find((r) => r.kind === 'video')!;
    const audio = rows.find((r) => r.kind === 'audio')!;
    const v = await story(author, { mediaId: video.id, music: { soundId: reel.sound.id, startMs: 0 } });
    expect(v.status).toBe(201);
    expect((await openStory(author, v.body.moment.id)).music.sound.id).toBe(reel.sound.id);
    const a = await story(author, { mediaId: audio.id, music: { soundId: reel.sound.id, startMs: 0 } });
    expect(a.status).toBe(400);
  });

  it('counts stories that use a sound, for each viewer, only while they can see them', async () => {
    const author = await adult();
    const friend = await adult();
    const stranger = await adult();
    const creator = await adult();
    await makeFriends(author, friend);
    const reel = await reelSound(creator);
    const other = await reelSound(creator, { soundTitle: 'Quiet one' });
    const s = await story(author, { music: { soundId: reel.sound.id, startMs: 0 } });
    const count = async (u: TestUser | null, soundId = reel.sound.id) => (await as(t.app, u).get(`/v1/sounds/${soundId}`)).body.sound.stories as number;
    expect(await count(friend)).toBe(1);
    expect(await count(author)).toBe(1);
    expect(await count(stranger)).toBe(0);
    expect(await count(null)).toBe(0);
    expect(await count(friend, other.sound.id)).toBe(0);

    // A public story counts for everyone.
    await story(author, { visibility: 'public', music: { soundId: reel.sound.id, startMs: 0 } });
    expect(await count(stranger)).toBe(1);
    expect(await count(null)).toBe(1);
    expect(await count(friend)).toBe(2);

    // Stories count toward what's most used in the picker.
    const picker = await as(t.app, friend).get(`/v1/sounds?q=${creator.username}&limit=30`);
    expect(picker.body.items).toHaveLength(2);
    const ids = picker.body.items.map((x: any) => x.id);
    expect(ids.indexOf(reel.sound.id)).toBeLessThan(ids.indexOf(other.sound.id));

    // Deleted and expired stories stop counting.
    await as(t.app, author).del(`/v1/moments/${s.body.moment.id}`);
    expect(await count(friend)).toBe(1);
    await t.ctx.db.query(`UPDATE moments SET expires_at = now() - interval '1 minute' WHERE author_id = $1`, [author.id]);
    expect(await count(friend)).toBe(0);
  });
});

// ── Both sides ───────────────────────────────────────────────────────

const handlers = () => ({
  ...mediaJobHandlers({ db: t.ctx.db, storage: t.ctx.storage }),
  ...editorJobHandlers({ db: t.ctx.db, storage: t.ctx.storage }),
});
async function drain() {
  for (let i = 0; i < 50; i++) if (!(await runJobs(handlers()))) return;
}

async function upload(user: TestUser, data: Buffer) {
  const boundary = `----ypl${Date.now()}${Math.random().toString(36).slice(2)}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="photo.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
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
  return res.json().media.id as string;
}

const solid = (width: number, height: number, background: { r: number; g: number; b: number }) =>
  sharp({ create: { width, height, channels: 3, background } })
    .jpeg({ quality: 100 })
    .toBuffer();

describe('both sides photos', () => {
  it('validates the request', () => {
    expect(dualComposeSchema.parse({ backId: randomUUID(), frontId: randomUUID() }).corner).toBe('top-left');
    expect(dualComposeSchema.safeParse({ backId: randomUUID(), frontId: randomUUID(), corner: 'middle' }).success).toBe(false);
    const box = dualInsetBox(1000, 1500, 600, 800, 'bottom-right');
    expect(box).toMatchObject({ width: 300, height: 400, left: 1000 - 40 - 300, top: 1500 - 40 - 400 });
  });

  it("only takes the caller's own photos", async () => {
    const me = await adult();
    const other = await adult();
    const blue = await solid(40, 40, { r: 20, g: 40, b: 220 });
    const mine = await upload(me, blue);
    const theirs = await upload(other, blue);
    const api = as(t.app, me);
    expect((await api.post('/v1/media/dual', { backId: mine, frontId: theirs })).status).toBe(404);
    expect((await api.post('/v1/media/dual', { backId: theirs, frontId: mine })).status).toBe(404);
    expect((await api.post('/v1/media/dual', { backId: mine, frontId: randomUUID() })).status).toBe(404);
    expect((await api.post('/v1/media/dual', { backId: mine, frontId: mine })).status).toBe(400);
    const { rows } = await t.ctx.db.query(
      `INSERT INTO media (owner_id, kind, url, mime, status, storage_key) VALUES ($1,'video','http://localhost:4000/media/v.mp4','video/mp4','ready','v.mp4') RETURNING id`,
      [me.id],
    );
    const video = await api.post('/v1/media/dual', { backId: mine, frontId: rows[0].id });
    expect(video.status).toBe(400);
    expect(video.body.error.message).toBe('Both sides photos are made from two photos.');
    expect((await as(t.app, null).post('/v1/media/dual', { backId: mine, frontId: theirs })).status).toBe(401);
    const renders = await t.ctx.db.query(`SELECT count(*)::int AS n FROM media_editor_renders WHERE owner_id = $1`, [me.id]);
    expect(renders.rows[0].n).toBe(0);
  });

  it('puts the front photo in the chosen corner of the back photo, as a new processed photo', async () => {
    const me = await adult();
    const back = await upload(me, await solid(400, 600, { r: 20, g: 40, b: 220 }));
    const front = await upload(me, await solid(300, 400, { r: 230, g: 60, b: 30 }));
    await drain();
    const r = await as(t.app, me).post('/v1/media/dual', { backId: back, frontId: front, corner: 'bottom-right' });
    expect(r.status).toBe(202);
    expect(r.body.media).toMatchObject({ kind: 'image', status: 'processing', editOf: back });
    const id = r.body.media.id as string;
    expect(id).not.toBe(back);
    await drain();

    const done = await as(t.app, me).get(`/v1/media/${id}`);
    expect(done.body.media).toMatchObject({ status: 'ready', kind: 'image', width: 400, height: 600, mime: 'image/jpeg' });
    expect(done.body.media.variants.thumb).toBeTruthy();
    // Someone else can't look it up.
    expect((await as(t.app, await adult()).get(`/v1/media/${id}`)).status).toBe(404);

    const { rows } = await t.ctx.db.query(`SELECT storage_key FROM media WHERE id = $1`, [id]);
    const { data, info } = await sharp(await t.ctx.storage.read(rows[0].storage_key))
      .raw()
      .toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => Array.from(data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3));
    const box = dualInsetBox(400, 600, 300, 400, 'bottom-right');
    const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]!) < 24);
    // The back photo everywhere else, the front photo inside the corner box, a white edge around it.
    expect(near(px(20, 20), [20, 40, 220])).toBe(true);
    expect(near(px(box.left + box.width / 2, box.top + box.height / 2), [230, 60, 30])).toBe(true);
    expect(near(px(box.left + Math.round(box.width / 2), box.top + Math.floor(box.border / 2)), [255, 255, 255])).toBe(true);
    // The rounded corner leaves the back photo showing at the box's very corner.
    expect(near(px(box.left + box.width - 1, box.top + box.height - 1), [20, 40, 220])).toBe(true);

    // The originals are untouched, and the result can be posted to a story.
    expect((await as(t.app, me).get(`/v1/media/${back}`)).body.media.width).toBe(400);
    expect((await as(t.app, me).post('/v1/moments', { mediaId: id, visibility: 'friends' })).status).toBe(201);
  });
});
