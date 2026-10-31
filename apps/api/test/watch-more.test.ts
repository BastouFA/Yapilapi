import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { BuiltApp } from '../src/app.ts';
import { tidyLonelyLines, WATCH_TIDY_LINE_JOB } from '../src/lib/watch.ts';
import { setYouTubeLookup } from '../src/lib/youtube.ts';
import { as, jobRunner, signUp, testApp, type TestUser } from './helpers.ts';

// Watch together, better: one line per session, uploads from a device, YouTube links, suggestions.

let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  setYouTubeLookup(null);
  await t.close();
});

const db = () => t.ctx.db;
const adult = () => signUp(t.app, { birthDate: '1990-04-02' });
const teen = () => signUp(t.app, { birthDate: `${new Date().getUTCFullYear() - 15}-03-01` });
const deps = () => ({ db: db(), realtime: t.ctx.realtime });

async function chat(owner: TestUser, others: TestUser[]): Promise<string> {
  for (const o of others) {
    const [x, y] = [owner.id, o.id].sort();
    await db().query(`INSERT INTO friendships (user_a, user_b) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [x, y]);
  }
  const r = await as(t.app, owner).post('/v1/conversations', { memberIds: others.map((o) => o.id) });
  expect(r.status).toBe(201);
  return r.body.conversation.id;
}

async function reel(owner: TestUser, extra: Record<string, unknown> = {}): Promise<string> {
  const { rows } = await db().query(
    `INSERT INTO media (owner_id, kind, url, mime, status, duration_ms, poster_url) VALUES ($1,'video','http://localhost:4000/media/test.mp4','video/mp4','ready',12000,'http://localhost:4000/media/p.jpg') RETURNING id, url`,
    [owner.id],
  );
  const r = await as(t.app, owner).post('/v1/posts', {
    format: 'reel',
    body: 'Dance practice',
    media: [{ id: rows[0].id, url: rows[0].url, kind: 'video' }],
    ...extra,
  });
  if (r.status !== 201) throw new Error(`reel failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.post.id;
}

/** A photo or video someone uploaded for watch together (as POST /v1/media?for=watch makes it, before processing). */
async function upload(owner: TestUser, kind: 'image' | 'video' = 'video', forWatch = true): Promise<string> {
  const { rows } = await db().query(
    `INSERT INTO media (owner_id, kind, url, mime, status, for_watch) VALUES ($1,$2,'http://localhost:4000/media/up.bin',$3,'ready',$4) RETURNING id`,
    [owner.id, kind, kind === 'video' ? 'video/mp4' : 'image/webp', forWatch],
  );
  return rows[0].id;
}

function connect(u: TestUser) {
  const events: { type: string; data: any }[] = [];
  const remove = t.ctx.realtime.add(u.id, { readyState: 1, send: (raw: string) => void events.push(JSON.parse(raw)) });
  return { events, remove, of: (type: string) => events.filter((e) => e.type === type) };
}

const start = (u: TestUser, conversationId: string, body: Record<string, unknown> = {}) => as(t.app, u).post('/v1/watch', { conversationId, ...body });
const lines = async (conversationId: string) =>
  (
    await db().query(`SELECT id, meta FROM messages WHERE conversation_id = $1 AND kind = 'system' AND meta->>'type' = 'watch' ORDER BY created_at`, [
      conversationId,
    ])
  ).rows;

describe('watch together: one line per session', () => {
  it('opens your own session again instead of writing another line, and takes a line nobody joined out of the chat later', async () => {
    const [a, b] = [await adult(), await adult()];
    const convo = await chat(a, [b]);
    const bDevice = connect(b);
    const first = await start(a, convo);
    expect(first.status).toBe(201);
    const id = first.body.session.id;
    // Alone: leaving ends it. The line stays, saying it was started (no join link: it ended).
    await as(t.app, a).post(`/v1/watch/${id}/leave`);
    expect((await lines(convo)).map((l) => l.meta)).toEqual([{ type: 'watch', sessionId: id, ended: true, seconds: null }]);

    // Starting again (three times, as the owner did) keeps one line, one session and one invite.
    for (let i = 0; i < 3; i++) {
      const again = await start(a, convo);
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ created: false, reopened: true });
      expect(again.body.session).toMatchObject({ id, status: 'active', joined: true });
      if (i < 2) await as(t.app, a).post(`/v1/watch/${id}/leave`);
    }
    expect((await lines(convo)).map((l) => l.meta)).toEqual([{ type: 'watch', sessionId: id }]);
    expect((await db().query(`SELECT 1 FROM notifications WHERE type = 'watch_invite' AND entity_id = $1`, [id])).rowCount).toBe(1);
    expect(bDevice.of('message.created').filter((e) => e.data.system?.type === 'watch')).toHaveLength(1);
    // B hears it's back (the line loses "ended", the banner shows).
    expect(bDevice.of('message.system').at(-1)!.data.system).toEqual({ type: 'watch', sessionId: id });
    expect(bDevice.of('watch.started').map((e) => e.data.sessionId)).toEqual([id, id, id, id]);

    // Ended alone once more: after the reopening window the line leaves the chat (the job), not before.
    await as(t.app, a).post(`/v1/watch/${id}/leave`);
    const [line] = await lines(convo);
    expect(await tidyLonelyLines(deps(), { sessionId: id })).toBe(0);
    await db().query(`UPDATE watch_sessions SET ended_at = now() - interval '11 minutes' WHERE id = $1`, [id]);
    expect((await db().query(`SELECT 1 FROM jobs WHERE kind = $1 AND payload->>'sessionId' = $2`, [WATCH_TIDY_LINE_JOB, id])).rowCount).toBeGreaterThan(0);
    await t.ctx.jobs[WATCH_TIDY_LINE_JOB]!({ sessionId: id }, { lastAttempt: false } as never);
    expect(await lines(convo)).toEqual([]);
    expect(bDevice.of('message.deleted').map((e) => e.data)).toEqual([{ id: line.id, conversationId: convo }]);
    // Too late to open again: a new session, a new line.
    const later = await start(a, convo);
    expect(later.status).toBe(201);
    expect(later.body.session.id).not.toBe(id);
    bDevice.remove();
  });

  it('says how long people watched together once it ends, and starting from a post puts that post on screen', async () => {
    const [a, b] = [await adult(), await adult()];
    const convo = await chat(a, [b]);
    const id = (await start(a, convo)).body.session.id;
    await as(t.app, b).post(`/v1/watch/${id}/join`);
    await db().query(`UPDATE watch_sessions SET together_at = now() - interval '12 minutes' WHERE id = $1`, [id]);
    const aDevice = connect(a);
    await as(t.app, b).post(`/v1/watch/${id}/leave`);
    await as(t.app, a).post(`/v1/watch/${id}/leave`);
    const [line] = await lines(convo);
    expect(line.meta).toMatchObject({ type: 'watch', sessionId: id, ended: true });
    expect(line.meta.seconds).toBeGreaterThanOrEqual(12 * 60);
    expect(aDevice.of('message.system').map((e) => e.data.system.seconds)).toEqual([line.meta.seconds]);
    // Someone joined, so it never opens again and its line stays.
    expect((await start(a, convo)).status).toBe(201);
    expect(await lines(convo)).toHaveLength(2);
    aDevice.remove();

    // A's own lonely session, started again from a reel: the reel goes on screen and plays.
    const [c, d] = [await adult(), await adult()];
    const pair = await chat(c, [d]);
    const old = await reel(c);
    const s1 = (await start(c, pair, { postIds: [old] })).body.session.id;
    await as(t.app, c).post(`/v1/watch/${s1}/leave`);
    const fresh = await reel(d);
    const again = await start(c, pair, { postIds: [fresh] });
    expect(again.body.reopened).toBe(true);
    expect(again.body.session.queue.map((q: any) => q.post.id)).toEqual([fresh]);
    expect(again.body.session.playback).toMatchObject({ itemId: again.body.session.queue[0].id, playing: true });
    // D starts a new one after it ended: C's line, which nobody joined, goes at once.
    await as(t.app, c).post(`/v1/watch/${s1}/leave`);
    await db().query(`UPDATE watch_sessions SET ended_at = now() - interval '20 minutes' WHERE id = $1`, [s1]);
    expect((await start(d, pair)).status).toBe(201);
    expect((await lines(pair)).map((l) => l.meta.sessionId)).not.toContain(s1);
  });
});

describe('watch together: from your device and YouTube', () => {
  it('adds your own uploads, holds them until they are ready, and deletes them when it ends', async () => {
    const [a, b, kid] = [await adult(), await adult(), await teen()];
    const convo = await chat(a, [b]);
    const id = (await start(a, convo)).body.session.id;
    const mine = await upload(a);
    const photo = await upload(a, 'image');

    // Someone else's upload, or a file not uploaded for watch together, can't be added.
    expect((await as(t.app, b).post(`/v1/watch/${id}/join`)).status).toBe(200);
    expect((await as(t.app, b).post(`/v1/watch/${id}/queue`, { mediaIds: [mine] })).body.error.code).toBe('watch_upload_invalid');
    expect((await as(t.app, a).post(`/v1/watch/${id}/queue`, { mediaIds: [await upload(a, 'video', false)] })).body.error.code).toBe('watch_upload_invalid');

    const r = await as(t.app, a).post(`/v1/watch/${id}/queue`, { mediaIds: [mine, photo] });
    expect(r.status).toBe(200);
    expect(r.body.added).toHaveLength(2);
    const [first, second] = r.body.session.queue;
    expect(first).toMatchObject({ kind: 'upload', ready: false, status: 'playing', media: { id: mine, kind: 'video' } });
    expect(second).toMatchObject({ kind: 'upload', ready: false, media: { id: photo, kind: 'image' } });
    // Processed: ready. B sees it too.
    await db().query(`UPDATE media SET poster_url = 'http://localhost:4000/media/p.jpg' WHERE id = $1`, [mine]);
    await db().query(`UPDATE media SET variants = '{"medium":"http://localhost:4000/media/m.webp"}' WHERE id = $1`, [photo]);
    const seen = (await as(t.app, b).get(`/v1/watch/${id}`)).body.session.queue;
    expect(seen.map((q: any) => [q.media.id, q.ready])).toEqual([
      [mine, true],
      [photo, true],
    ]);
    // Blocked by the automated check before its turn: passed over.
    await db().query(`UPDATE media SET moderation = 'blocked' WHERE id = $1`, [photo]);
    expect((await as(t.app, b).get(`/v1/watch/${id}`)).body.session.queue.map((q: any) => q.media.id)).toEqual([mine]);
    const next = await as(t.app, a).post(`/v1/watch/${id}/control`, { action: 'next' });
    expect(next.body.skipped).toEqual(['unavailable']);

    // Sensitive media doesn't go to a chat with someone under 18.
    const teenChat = await chat(a, [kid]);
    const tid = (await start(a, teenChat)).body.session.id;
    const flagged = await upload(a);
    await db().query(`UPDATE media SET moderation = 'sensitive' WHERE id = $1`, [flagged]);
    expect((await as(t.app, a).post(`/v1/watch/${tid}/queue`, { mediaIds: [flagged] })).body.skipped).toEqual([{ mediaId: flagged, reason: 'not_visible' }]);

    // When it ends, the files go (marked deleted; the clean-up erases them later).
    await as(t.app, a).post(`/v1/watch/${id}/end`);
    const left = await db().query(`SELECT id FROM media WHERE id = ANY($1::uuid[]) AND deleted_at IS NOT NULL ORDER BY id`, [[mine, photo]]);
    expect(left.rows.map((x) => x.id).sort()).toEqual([mine, photo].sort());
  });

  it('uploads with ?for=watch through the usual path, photos and videos only', async () => {
    const a = await adult();
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#3a7' } })
      .png()
      .toBuffer();
    const boundary = `----ypl${Math.random().toString(16).slice(2)}`;
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="p.png"\r\nContent-Type: image/png\r\n\r\n`),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const run = await jobRunner(db());
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/media?for=watch',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${a.token}` },
      payload,
    });
    expect(res.statusCode).toBe(201);
    const id = res.json().media.id;
    expect((await db().query(`SELECT for_watch FROM media WHERE id = $1`, [id])).rows[0].for_watch).toBe(true);
    await run(t.ctx.jobs);
  });

  it('adds YouTube links after checking them, and refuses other sites and videos that can’t be embedded', async () => {
    const [a, b] = [await adult(), await adult()];
    const convo = await chat(a, [b]);
    const asked: string[] = [];
    setYouTubeLookup(async (videoId) => {
      asked.push(videoId);
      if (videoId === 'noEmbed0000') return { ok: false, reason: 'not_embeddable' };
      if (videoId === 'gone0000000') return { ok: false, reason: 'unavailable' };
      return { ok: true, title: 'Jollof cook-off', thumbnailUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg' };
    });
    const r = await start(a, convo, { links: ['https://youtu.be/dQw4w9WgXcQ?si=x'] });
    expect(r.status).toBe(201);
    expect(r.body.session.queue).toEqual([
      expect.objectContaining({
        kind: 'youtube',
        status: 'playing',
        youtube: { videoId: 'dQw4w9WgXcQ', title: 'Jollof cook-off', thumbnailUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg' },
      }),
    ]);
    expect(r.body.session.playback.playing).toBe(true);
    const id = r.body.session.id;
    const add = (links: string[]) => as(t.app, a).post(`/v1/watch/${id}/queue`, { links });
    expect((await add(['https://www.youtube.com/watch?v=dQw4w9WgXcQ'])).body.skipped).toEqual([{ videoId: 'dQw4w9WgXcQ', reason: 'already_queued' }]);
    for (const bad of ['https://vimeo.com/1234', 'https://www.youtube.com.evil.test/watch?v=dQw4w9WgXcQ', 'not a link'])
      expect((await add([bad])).body.error.code).toBe('watch_bad_link');
    expect((await add(['https://www.youtube.com/shorts/noEmbed0000'])).body.error.code).toBe('watch_not_embeddable');
    expect((await add(['https://youtube.com/watch?v=gone0000000'])).body.error.code).toBe('watch_link_unavailable');
    // YouTube couldn't be asked: added without a title.
    setYouTubeLookup(async () => null);
    const quiet = await add(['https://m.youtube.com/watch?v=aaaaaaaaaaa']);
    expect(quiet.body.session.queue.at(-1).youtube).toEqual({ videoId: 'aaaaaaaaaaa', title: null, thumbnailUrl: null });
    expect(asked).not.toContain('vimeo');
    // A bad thumbnail host never reaches the database.
    await expect(
      db().query(
        `INSERT INTO watch_queue_items (session_id, position, kind, youtube_id, thumbnail_url) VALUES ($1, 99, 'youtube', 'bbbbbbbbbbb', 'https://evil.test/x.jpg')`,
        [id],
      ),
    ).rejects.toThrow();
  });
});

describe('watch together: one device per person', () => {
  it('plays on the device you joined from last, and the other one stepping away changes nothing', async () => {
    const [a, b] = [await adult(), await adult()];
    const convo = await chat(a, [b]);
    const phone = 'phone-0000000001';
    const mac = 'mac-00000000000002';
    const id = (await start(a, convo, { device: phone, postIds: [await reel(a)] })).body.session.id;
    await as(t.app, b).post(`/v1/watch/${id}/join`, { device: 'b-device-0001' });
    const aDevices = connect(a);
    const bDevice = connect(b);

    // The Mac opens the same session: it plays now, the phone hears so and stops.
    const onMac = await as(t.app, a).post(`/v1/watch/${id}/join`, { device: mac });
    expect(onMac.status).toBe(200);
    expect(aDevices.of('watch.device').map((e) => e.data)).toEqual([{ sessionId: id, deviceId: mac }]);
    expect(bDevice.of('watch.device')).toEqual([]);
    // Still one person watching, not two.
    expect(onMac.body.session.watching.map((u: any) => u.id).sort()).toEqual([a.id, b.id].sort());
    // A missed event is caught by the heartbeat.
    expect((await as(t.app, a).post(`/v1/watch/${id}/heartbeat`, { device: phone })).body.here).toBe(false);
    expect((await as(t.app, a).post(`/v1/watch/${id}/heartbeat`, { device: mac })).body.here).toBe(true);
    // The phone's position never moves the shared clock.
    const s = (await as(t.app, a).get(`/v1/watch/${id}`)).body.session;
    await as(t.app, a).post(`/v1/watch/${id}/heartbeat`, { device: phone, positionMs: 99_000, itemId: s.playback.itemId, seq: s.playback.seq });
    expect((await as(t.app, a).get(`/v1/watch/${id}`)).body.session.playback.positionMs).not.toBe(99_000);

    // Closing the phone's screen doesn't take A out; closing the Mac's does.
    await as(t.app, a).post(`/v1/watch/${id}/leave`, { device: phone });
    expect((await as(t.app, b).get(`/v1/watch/${id}`)).body.session.watching.map((u: any) => u.id)).toContain(a.id);
    // "Watch here" on the phone moves it back.
    await as(t.app, a).post(`/v1/watch/${id}/join`, { device: phone });
    expect(aDevices.of('watch.device').map((e) => e.data.deviceId)).toEqual([mac, phone]);
    await as(t.app, a).post(`/v1/watch/${id}/leave`, { device: phone });
    expect((await as(t.app, b).get(`/v1/watch/${id}`)).body.session.watching.map((u: any) => u.id)).toEqual([b.id]);
    // Devices that never say goodbye: presence runs out as before (WATCH_PRESENCE_SECONDS).
    aDevices.remove();
    bDevice.remove();
  });
});

describe('watch together: what to watch next', () => {
  it('suggests reels everyone in the chat can see that are not in the queue yet', async () => {
    const [a, b, creator] = [await adult(), await adult(), await adult()];
    const convo = await chat(a, [b]);
    const own = await reel(b);
    const open = await reel(creator);
    const followersOnly = await reel(creator, { visibility: 'followers' });
    // Liked a lot (other tests' reels share the database), so both would be among the most liked.
    await db().query(`UPDATE posts SET like_count = 1000000 WHERE id = ANY($1::uuid[])`, [[open, followersOnly]]);
    await as(t.app, a).post(`/v1/users/${creator.id}/follow`);
    const queued = await reel(a);
    const id = (await start(a, convo, { postIds: [queued] })).body.session.id;
    const r = await as(t.app, b).get(`/v1/watch/${id}/suggestions`);
    expect(r.status).toBe(200);
    const ids = r.body.items.map((p: any) => p.id);
    // People in the chat first.
    expect(ids[0]).toBe(own);
    expect(ids).toContain(open);
    expect(ids).not.toContain(followersOnly);
    expect(ids).not.toContain(queued);
    const outsider = await adult();
    expect((await as(t.app, outsider).get(`/v1/watch/${id}/suggestions`)).status).toBe(404);
  });
});
