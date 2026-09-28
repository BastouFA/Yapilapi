import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { WATCH_MAX_MEMBERS } from '@yapilapi/shared';
import type { BuiltApp } from '../src/app.ts';
import { sweepWatch } from '../src/lib/watch.ts';
import { sweepWeeklyWraps } from '../src/lib/wrap.ts';
import { as, signUp, testApp, type TestUser } from './helpers.ts';

let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.close();
});

const db = () => t.ctx.db;
const adult = () => signUp(t.app, { birthDate: '1990-04-02' });
const teen = () => signUp(t.app, { birthDate: `${new Date().getUTCFullYear() - 15}-03-01` });

async function befriend(a: TestUser, b: TestUser, at?: Date) {
  const [x, y] = [a.id, b.id].sort();
  await db().query(`INSERT INTO friendships (user_a, user_b, created_at) VALUES ($1,$2,coalesce($3, now())) ON CONFLICT DO NOTHING`, [x, y, at ?? null]);
}

/** A chat between `owner` and `others` (all made friends first, so nothing else stands in the way). */
async function chat(owner: TestUser, others: TestUser[], title?: string): Promise<string> {
  for (const o of others) await befriend(owner, o);
  const r = await as(t.app, owner).post('/v1/conversations', { memberIds: others.map((o) => o.id), ...(title ? { title } : {}) });
  expect(r.status).toBe(201);
  return r.body.conversation.id;
}

async function video(owner: TestUser) {
  const { rows } = await db().query(
    `INSERT INTO media (owner_id, kind, url, mime, status, duration_ms) VALUES ($1,'video','http://localhost:4000/media/test.mp4','video/mp4','ready',12000) RETURNING id, url`,
    [owner.id],
  );
  return rows[0] as { id: string; url: string };
}

async function reel(owner: TestUser, extra: Record<string, unknown> = {}): Promise<string> {
  const v = await video(owner);
  const r = await as(t.app, owner).post('/v1/posts', { format: 'reel', body: 'Dance practice', media: [{ id: v.id, url: v.url, kind: 'video' }], ...extra });
  if (r.status !== 201) throw new Error(`reel failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.post.id;
}

/** A fake connected device: records every realtime event the user gets. */
function connect(u: TestUser) {
  const events: { type: string; data: any }[] = [];
  const remove = t.ctx.realtime.add(u.id, { readyState: 1, send: (raw: string) => void events.push(JSON.parse(raw)) });
  return { events, remove, of: (type: string) => events.filter((e) => e.type === type), clear: () => void events.splice(0) };
}

const start = (u: TestUser, conversationId: string, postIds: string[] = []) => as(t.app, u).post('/v1/watch', { conversationId, postIds });

describe('watch together: who can start, see and act', () => {
  it('is only for people in the chat, in one-to-one chats and groups of up to 8', async () => {
    const [a, b, outsider] = [await adult(), await adult(), await adult()];
    const convo = await chat(a, [b]);
    const clip = await reel(a);

    expect((await start(outsider, convo, [clip])).status).toBe(404);
    const made = await start(a, convo, [clip]);
    expect(made.status).toBe(201);
    expect(made.body.created).toBe(true);
    const id = made.body.session.id;
    expect(made.body.session).toMatchObject({ hostId: a.id, joined: true, status: 'active' });
    expect(made.body.session.queue).toHaveLength(1);
    expect(made.body.session.playback).toMatchObject({ itemId: made.body.session.queue[0].id, playing: true, seq: 1 });

    // A line in the chat, and one session per chat: starting again joins it.
    const line = await db().query(`SELECT meta FROM messages WHERE conversation_id = $1 AND kind = 'system'`, [convo]);
    expect(line.rows.map((r) => r.meta)).toEqual([{ type: 'watch', sessionId: id }]);
    const again = await start(b, convo);
    expect(again.status).toBe(200);
    expect(again.body.session.id).toBe(id);
    expect(again.body.created).toBe(false);
    expect((await db().query(`SELECT 1 FROM messages WHERE conversation_id = $1 AND kind = 'system'`, [convo])).rowCount).toBe(1);

    // People outside the chat learn nothing.
    for (const [m, url] of [
      ['get', `/v1/watch/${id}`],
      ['post', `/v1/watch/${id}/join`],
      ['post', `/v1/watch/${id}/control`],
      ['post', `/v1/watch/${id}/reactions`],
      ['get', `/v1/conversations/${convo}/watch`],
    ] as const)
      expect((await (as(t.app, outsider) as any)[m](url, m === 'post' ? { action: 'pause', kind: 'heart' } : undefined)).status).toBe(404);

    // Too many people.
    const crowd = await Promise.all(Array.from({ length: WATCH_MAX_MEMBERS }, adult));
    const big = await chat(a, crowd, 'Everyone');
    const r = await start(a, big);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('watch_too_many');
    const eight = await chat(a, crowd.slice(0, WATCH_MAX_MEMBERS - 1), 'Eight of us');
    expect((await start(a, eight)).status).toBe(201);
  });

  it('asks people in the chat to join before they act, and refuses blocked one-to-one chats', async () => {
    const [a, b, c] = [await adult(), await adult(), await adult()];
    const group = await chat(a, [b, c], 'Film club');
    const id = (await start(a, group, [await reel(a)])).body.session.id;

    // In the chat but not watching: can see it, not steer it.
    expect((await as(t.app, c).get(`/v1/watch/${id}`)).body.session.joined).toBe(false);
    expect((await as(t.app, c).get(`/v1/conversations/${group}/watch`)).body.session).toMatchObject({ id, joined: false });
    for (const url of ['control', 'reactions', 'queue', 'heartbeat']) {
      const res = await as(t.app, c).post(`/v1/watch/${id}/${url}`, { action: 'pause', kind: 'heart', postIds: [await reel(a)] });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('watch_not_watching');
    }
    expect((await as(t.app, c).post(`/v1/watch/${id}/join`)).body.session.joined).toBe(true);
    expect((await as(t.app, c).post(`/v1/watch/${id}/control`, { action: 'pause' })).status).toBe(200);
    // Only the host ends it for everyone.
    expect((await as(t.app, c).post(`/v1/watch/${id}/end`)).status).toBe(403);
    expect((await as(t.app, a).post(`/v1/watch/${id}/end`)).status).toBe(200);
    expect((await as(t.app, c).post(`/v1/watch/${id}/join`)).status).toBe(410);
    expect((await as(t.app, c).get(`/v1/conversations/${group}/watch`)).body.session).toBeNull();

    // A one-to-one chat with someone who blocked you.
    const [x, y] = [await adult(), await adult()];
    const direct = await chat(x, [y]);
    await as(t.app, y).post(`/v1/users/${x.id}/block`);
    expect((await start(x, direct)).status).toBe(403);
  });
});

describe('watch together: the queue only holds what everyone can see', () => {
  it('skips posts someone in the chat can’t see, with the reason and nothing else', async () => {
    const [a, b, creator, stranger] = [await adult(), await adult(), await adult(), await adult()];
    const convo = await chat(a, [b]);
    const id = (await start(a, convo)).body.session.id;
    expect((await as(t.app, a).get(`/v1/watch/${id}`)).body.session.playback).toMatchObject({ itemId: null, playing: false });

    await as(t.app, a).post(`/v1/users/${creator.id}/follow`);
    const open = await reel(creator);
    const followersOnly = await reel(creator, { visibility: 'followers' });
    const text = (await as(t.app, a).post('/v1/posts', { body: 'Just words' })).body.post.id;
    const blockedB = await reel(stranger);
    await as(t.app, stranger).post(`/v1/users/${b.id}/block`);
    const gone = await reel(a);
    await as(t.app, a).del(`/v1/posts/${gone}`);

    const r = await as(t.app, a).post(`/v1/watch/${id}/queue`, { postIds: [open, followersOnly, text, blockedB, gone, open] });
    expect(r.status).toBe(200);
    expect(r.body.added).toHaveLength(1);
    expect(r.body.skipped).toEqual([
      { postId: followersOnly, reason: 'not_visible' },
      { postId: text, reason: 'not_video' },
      { postId: blockedB, reason: 'not_visible' },
      { postId: gone, reason: 'unavailable' },
    ]);
    // The first thing added goes on screen, paused.
    expect(r.body.session.queue.map((i: any) => i.post.id)).toEqual([open]);
    expect(r.body.session.playback).toMatchObject({ itemId: r.body.added[0], playing: false });
    expect((await as(t.app, a).post(`/v1/watch/${id}/queue`, { postIds: [open] })).body.skipped).toEqual([{ postId: open, reason: 'already_queued' }]);

    // B joins; what they see of the queue is what they can see.
    const seen = (await as(t.app, b).post(`/v1/watch/${id}/join`)).body.session;
    expect(seen.queue.map((i: any) => i.post.id)).toEqual([open]);

    // Jumping to an item that stopped being visible to everyone skips it and leaves the screen as it is.
    const soon = await reel(creator);
    const itemId = (await as(t.app, b).post(`/v1/watch/${id}/queue`, { postIds: [soon] })).body.added[0];
    await db().query(`UPDATE posts SET visibility = 'followers' WHERE id = $1`, [soon]);
    const before = (await as(t.app, a).get(`/v1/watch/${id}`)).body.session.playback;
    const jump = await as(t.app, a).post(`/v1/watch/${id}/control`, { action: 'jump', itemId });
    expect(jump.status).toBe(200);
    expect(jump.body.skipped).toEqual(['not_visible']);
    expect(jump.body.playback).toMatchObject({ itemId: before.itemId, seq: before.seq });
    expect((await as(t.app, a).post(`/v1/watch/${id}/control`, { action: 'jump', itemId })).status).toBe(404);
  });

  it('keeps posts held for review away from people under 18, and passes over items that stopped being visible to everyone', async () => {
    const [a, kid, creator] = [await adult(), await teen(), await adult()];
    const convo = await chat(a, [kid]);
    const held = await reel(creator);
    await db().query(`UPDATE posts SET moderation_status = 'review' WHERE id = $1`, [held]);
    const first = await reel(creator);
    const later = await reel(creator);
    const r = await start(a, convo, [held, first, later]);
    expect(r.body.skipped).toEqual([{ postId: held, reason: 'not_visible' }]);
    const id = r.body.session.id;
    await as(t.app, kid).post(`/v1/watch/${id}/join`);

    // The next item became friends-only after it was added: skipped when its turn comes.
    await db().query(`UPDATE posts SET visibility = 'friends' WHERE id = $1`, [later]);
    const kidDevice = connect(kid);
    const next = await as(t.app, kid).post(`/v1/watch/${id}/control`, { action: 'next' });
    expect(next.status).toBe(200);
    expect(next.body.skipped).toEqual(['not_visible']);
    expect(next.body.playback).toMatchObject({ itemId: null, playing: false });
    expect(kidDevice.of('watch.playback')[0]!.data.skipped).toEqual(['not_visible']);
    kidDevice.remove();
    const queue = (await as(t.app, a).get(`/v1/watch/${id}`)).body.session.queue;
    expect(queue).toEqual([]);
  });
});

describe('watch together: sync goes only to the people watching', () => {
  it('sends playback and reactions to people watching, the start and end to the chat, and nothing to anyone else', async () => {
    const [a, b, c, outsider] = [await adult(), await adult(), await adult(), await adult()];
    const group = await chat(a, [b, c], 'Movie night');
    const devices = { a: connect(a), b: connect(b), c: connect(c), outsider: connect(outsider) };
    const clip = await reel(a);
    const id = (await start(a, group, [clip])).body.session.id;

    // Everyone in the chat hears it started (and gets the line in the chat); the outsider doesn't.
    for (const u of ['a', 'b', 'c'] as const) expect(devices[u].of('watch.started')).toHaveLength(1);
    expect(devices.b.of('message.created')[0]!.data).toMatchObject({ kind: 'system', system: { type: 'watch', sessionId: id } });
    expect(devices.outsider.events).toEqual([]);
    expect(
      (await db().query(`SELECT user_id FROM notifications WHERE type = 'watch_invite' AND entity_id = $1 ORDER BY user_id`, [id])).rows.map((r) => r.user_id),
    ).toEqual([b.id, c.id].sort());

    await as(t.app, b).post(`/v1/watch/${id}/join`);
    for (const d of Object.values(devices)) d.clear();

    const before = Date.now();
    const played = await as(t.app, b).post(`/v1/watch/${id}/control`, { action: 'seek', positionMs: 4000, atServerMs: Date.now() });
    expect(played.status).toBe(200);
    expect(played.body.playback.seq).toBe(2);
    expect(played.body.playback.by).toBe(b.id);
    expect(played.body.playback.positionMs).toBeGreaterThanOrEqual(4000);
    expect(played.body.serverTime).toBeGreaterThanOrEqual(before);
    for (const u of ['a', 'b'] as const) expect(devices[u].of('watch.playback').map((e) => e.data.playback.seq)).toEqual([2]);
    expect(devices.c.of('watch.playback')).toEqual([]);
    expect(devices.outsider.events).toEqual([]);

    await as(t.app, a).post(`/v1/watch/${id}/reactions`, { kind: 'star' });
    expect((await as(t.app, a).post(`/v1/watch/${id}/reactions`, { kind: 'party-popper' })).status).toBe(400);
    for (const u of ['a', 'b'] as const) expect(devices[u].of('watch.reaction').map((e) => e.data)).toEqual([{ sessionId: id, userId: a.id, kind: 'star' }]);
    expect(devices.c.of('watch.reaction')).toEqual([]);

    // After leaving, nothing more comes.
    await as(t.app, b).post(`/v1/watch/${id}/leave`);
    devices.a.clear();
    devices.b.clear();
    await as(t.app, a).post(`/v1/watch/${id}/control`, { action: 'pause' });
    expect(devices.b.of('watch.playback')).toEqual([]);
    expect(devices.a.of('watch.playback')).toHaveLength(1);

    // The last person leaving ends it for the chat.
    await as(t.app, a).post(`/v1/watch/${id}/leave`);
    for (const u of ['a', 'b', 'c'] as const) expect(devices[u].of('watch.ended').map((e) => e.data)).toEqual([{ sessionId: id, conversationId: group }]);
    expect(devices.outsider.events).toEqual([]);
    for (const d of Object.values(devices)) d.remove();
  });

  it('follows the host’s clock, drops late updates and moves on once when several players finish together', async () => {
    const [a, b] = [await adult(), await adult()];
    const convo = await chat(a, [b]);
    const [one, two] = [await reel(a), await reel(a)];
    const id = (await start(a, convo, [one, two])).body.session.id;
    await as(t.app, b).post(`/v1/watch/${id}/join`);
    const s = (await as(t.app, a).get(`/v1/watch/${id}`)).body.session;
    const bDevice = connect(b);

    // The host's heartbeat with the current state moves the shared position; a stale seq or someone else's doesn't.
    expect(
      (await as(t.app, a).post(`/v1/watch/${id}/heartbeat`, { positionMs: 7000, itemId: s.playback.itemId, seq: s.playback.seq, atServerMs: Date.now() }))
        .status,
    ).toBe(200);
    const tick = bDevice.of('watch.playback');
    expect(tick).toHaveLength(1);
    expect(tick[0]!.data.playback.seq).toBe(s.playback.seq);
    expect(tick[0]!.data.playback.positionMs).toBeGreaterThanOrEqual(7000);
    await as(t.app, a).post(`/v1/watch/${id}/heartbeat`, { positionMs: 1, itemId: s.playback.itemId, seq: s.playback.seq - 1 });
    await as(t.app, b).post(`/v1/watch/${id}/heartbeat`, { positionMs: 1, itemId: s.playback.itemId, seq: s.playback.seq });
    expect(bDevice.of('watch.playback')).toHaveLength(1);
    expect((await as(t.app, a).get(`/v1/watch/${id}`)).body.session.playback.positionMs).toBeGreaterThanOrEqual(7000);

    // Both players reach the end: one move to the next item.
    const [x, y] = await Promise.all([
      as(t.app, a).post(`/v1/watch/${id}/control`, { action: 'next', fromItemId: s.playback.itemId }),
      as(t.app, b).post(`/v1/watch/${id}/control`, { action: 'next', fromItemId: s.playback.itemId }),
    ]);
    expect([x.status, y.status]).toEqual([200, 200]);
    const after = (await as(t.app, a).get(`/v1/watch/${id}`)).body.session;
    expect(after.playback.seq).toBe(s.playback.seq + 1);
    expect(after.queue.map((i: any) => i.post.id)).toEqual([two]);
    expect(after.playback).toMatchObject({ itemId: after.queue[0].id, playing: true, positionMs: 0 });
    bDevice.remove();
  });

  it('passes the host on when the host leaves or goes quiet', async () => {
    const [a, b, c] = [await adult(), await adult(), await adult()];
    const group = await chat(a, [b, c], 'Trio');
    const id = (await start(a, group, [await reel(a)])).body.session.id;
    await as(t.app, b).post(`/v1/watch/${id}/join`);
    await as(t.app, c).post(`/v1/watch/${id}/join`);
    const bDevice = connect(b);

    await as(t.app, a).post(`/v1/watch/${id}/leave`);
    expect(bDevice.of('watch.updated').map((e) => e.data.reason)).toEqual(['host']);
    expect((await as(t.app, b).get(`/v1/watch/${id}`)).body.session.hostId).toBe(b.id);

    // B's player stops checking in: C takes over after the sweep.
    await db().query(`UPDATE watch_participants SET last_seen_at = now() - interval '5 minutes' WHERE session_id = $1 AND user_id = $2`, [id, b.id]);
    expect(await sweepWatch({ db: db(), realtime: t.ctx.realtime })).toBeGreaterThanOrEqual(1);
    const s = (await as(t.app, c).get(`/v1/watch/${id}`)).body.session;
    expect(s.hostId).toBe(c.id);
    expect(s.watching.map((u: any) => u.id)).toEqual([c.id]);
    // B comes back: watching again, not host.
    const back = await as(t.app, b).post(`/v1/watch/${id}/heartbeat`);
    expect(back.status).toBe(409);
    expect((await as(t.app, b).post(`/v1/watch/${id}/join`)).body.session).toMatchObject({ hostId: c.id, joined: true });

    // Someone who leaves the chat stops watching.
    await db().query(`UPDATE conversation_members SET left_at = now() WHERE conversation_id = $1 AND user_id = $2`, [group, b.id]);
    await sweepWatch({ db: db(), realtime: t.ctx.realtime });
    expect((await as(t.app, c).get(`/v1/watch/${id}`)).body.session.watching.map((u: any) => u.id)).toEqual([c.id]);
    expect((await as(t.app, b).get(`/v1/watch/${id}`)).status).toBe(404);
    bDevice.remove();
  });
});

// ─── Weekly wrap ────────────────────────────────────────────────────────

/** A Sunday at least a week ago (YYYY-MM-DD), so everything in its week is in the past. */
function pastSunday(): string {
  const d = new Date(Date.now() - 8 * 86_400_000);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** Sunday at `hh:mm` in Lagos (UTC+1, no daylight saving). */
const lagosSunday = (sunday: string, hh: number, mm = 0) => new Date(`${sunday}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+01:00`);

async function setTz(u: TestUser, tz: string) {
  const r = await as(t.app, u).put('/v1/me/weekly-wrap', { timezone: tz });
  expect(r.status).toBe(200);
}

describe('weekly wrap', () => {
  it('is made on Sunday evening in your time zone, from your own week only, and sent once', async () => {
    const [me, friend, other] = [await adult(), await adult(), await adult()];
    await setTz(me, 'Africa/Lagos');
    const sunday = pastSunday();
    const wednesday = `${addDays(sunday, -4)}T12:00:00Z`;
    const top = await reel(me);
    const plain = (await as(t.app, me).post('/v1/posts', { body: 'Market day' })).body.post.id;
    const nextWeek = (await as(t.app, me).post('/v1/posts', { body: 'Too late' })).body.post.id;
    const theirs = await reel(friend);
    await db().query(`UPDATE posts SET created_at = $2 WHERE id = ANY($1::uuid[])`, [[top, plain, theirs], wednesday]);
    await db().query(`UPDATE posts SET created_at = $2 WHERE id = $1`, [nextWeek, `${addDays(sunday, 1)}T09:00:00Z`]);
    await db().query(`UPDATE posts SET like_count = 5 WHERE id = $1`, [top]);
    await befriend(me, friend, new Date(wednesday));
    await befriend(me, other, new Date(`${addDays(sunday, -20)}T12:00:00Z`));

    const deps = { db: db(), realtime: t.ctx.realtime };
    // 17:00 in Lagos: not yet. 18:30: made, once.
    expect(await sweepWeeklyWraps(deps, { now: lagosSunday(sunday, 17), userIds: [me.id] })).toBe(0);
    expect(await sweepWeeklyWraps(deps, { now: lagosSunday(sunday, 18, 30), userIds: [me.id] })).toBe(1);
    expect(await sweepWeeklyWraps(deps, { now: lagosSunday(sunday, 21), userIds: [me.id] })).toBe(0);

    const notes = await db().query(`SELECT entity_id, data FROM notifications WHERE user_id = $1 AND type = 'weekly_wrap'`, [me.id]);
    expect(notes.rows).toHaveLength(1);
    const id = notes.rows[0].entity_id;
    expect(notes.rows[0].data).toEqual({ weekStart: addDays(sunday, -6) });

    const w = (await as(t.app, me).get(`/v1/wraps/${id}`)).body.wrap;
    expect(w).toMatchObject({ weekStart: addDays(sunday, -6), weekEnd: sunday, timezone: 'Africa/Lagos' });
    expect(w.counts).toMatchObject({ posts: 1, reels: 1, newFriends: 1 });
    expect(w.best.map((p: any) => p.id)).toEqual([top, plain]);
    expect(w.best.every((p: any) => p.author.id === me.id)).toBe(true);
    expect(w.moment.id).toBe(top);
    expect(w.newFriends.map((u: any) => u.id)).toEqual([friend.id]);

    // Private: nobody else reads it or its card.
    expect((await as(t.app, friend).get(`/v1/wraps/${id}`)).status).toBe(404);
    expect((await as(t.app, friend).get(`/v1/wraps/${id}/card.png`)).status).toBe(404);
    const card = await t.app.inject({ method: 'GET', url: `/v1/wraps/${id}/card.png`, headers: { authorization: `Bearer ${me.token}` } });
    expect(card.statusCode).toBe(200);
    expect(card.headers['content-type']).toBe('image/png');
    expect(card.headers['cache-control']).toContain('private');
    expect(card.rawPayload.subarray(1, 4).toString()).toBe('PNG');

    // With a poster stored for the moment's video, the card shows it (your own picture only).
    const key = `2026/01/${crypto.randomUUID()}`;
    const poster = await sharp({ create: { width: 720, height: 1280, channels: 3, background: '#3a7bd5' } })
      .jpeg()
      .toBuffer();
    await t.ctx.storage.putKey(`${key}_poster.jpg`, poster, 'image/jpeg');
    await db().query(`UPDATE media SET storage_key = $2 WHERE id = (SELECT media_id FROM post_media WHERE post_id = $1)`, [top, `${key}.mp4`]);
    const withPicture = await t.app.inject({ method: 'GET', url: `/v1/wraps/${id}/card.png`, headers: { authorization: `Bearer ${me.token}` } });
    expect(withPicture.statusCode).toBe(200);
    expect(withPicture.rawPayload.length).not.toBe(card.rawPayload.length);
    const meta = await sharp(withPicture.rawPayload).metadata();
    expect([meta.width, meta.height]).toEqual([1080, 1350]);
    if (process.env.WRAP_CARD_OUT) {
      const fs = await import('node:fs');
      fs.writeFileSync(process.env.WRAP_CARD_OUT, card.rawPayload);
      fs.writeFileSync(process.env.WRAP_CARD_OUT.replace(/\.png$/, '-picture.png'), withPicture.rawPayload);
    }

    // A friend blocked since then drops out of it.
    await as(t.app, me).post(`/v1/users/${friend.id}/block`);
    expect((await as(t.app, me).get(`/v1/wraps/${id}`)).body.wrap.newFriends).toEqual([]);
    // Draws the card image with sharp: slow when the whole suite runs at once.
  }, 90_000);

  it('sends nothing for a quiet week, or when turned off, and holds the notification when asked', async () => {
    const [quiet, off, silent] = [await adult(), await adult(), await adult()];
    const sunday = pastSunday();
    const inWeek = `${addDays(sunday, -2)}T10:00:00Z`;
    for (const u of [off, silent]) {
      const p = (await as(t.app, u).post('/v1/posts', { body: 'Hello' })).body.post.id;
      await db().query(`UPDATE posts SET created_at = $2 WHERE id = $1`, [p, inWeek]);
    }
    expect((await as(t.app, off).put('/v1/me/weekly-wrap', { enabled: false })).body.settings).toMatchObject({ enabled: false, notify: true });
    expect((await as(t.app, silent).put('/v1/me/weekly-wrap', { notify: false })).body.settings).toMatchObject({ enabled: true, notify: false });
    expect((await as(t.app, silent).put('/v1/me/weekly-wrap', { timezone: 'Not/AZone' })).status).toBe(400);

    const ids = [quiet.id, off.id, silent.id];
    expect(await sweepWeeklyWraps({ db: db(), realtime: t.ctx.realtime }, { now: new Date(`${sunday}T19:00:00Z`), userIds: ids })).toBe(1);
    const wraps = await db().query(`SELECT user_id, empty FROM weekly_wraps WHERE user_id = ANY($1::uuid[])`, [ids]);
    expect(Object.fromEntries(wraps.rows.map((r) => [r.user_id, r.empty]))).toEqual({ [quiet.id]: true, [silent.id]: false });
    expect((await db().query(`SELECT 1 FROM notifications WHERE user_id = ANY($1::uuid[]) AND type = 'weekly_wrap'`, [ids])).rowCount).toBe(0);
    expect((await as(t.app, quiet).get('/v1/wraps')).body.items).toEqual([]);
    expect((await as(t.app, silent).get('/v1/wraps')).body.items).toHaveLength(1);
  });

  it('shows a gentle card on Pulse that can be put away or deleted, and "On this day" when Memories is on', async () => {
    const u = await adult();
    const sunday = pastSunday();
    const p = (await as(t.app, u).post('/v1/posts', { body: 'Back then' })).body.post.id;
    await db().query(`UPDATE posts SET created_at = $2 WHERE id = $1`, [p, `${addDays(sunday, -3)}T10:00:00Z`]);
    await sweepWeeklyWraps({ db: db(), realtime: t.ctx.realtime }, { now: new Date(`${sunday}T20:00:00Z`), userIds: [u.id] });

    const cards = await as(t.app, u).get('/v1/me/pulse-cards?tz=Europe/Paris');
    expect(cards.status).toBe(200);
    expect(cards.body.wrap).toMatchObject({ weekStart: addDays(sunday, -6), counts: { posts: 1 } });
    expect((await as(t.app, u).get('/v1/me/weekly-wrap')).body.settings.timezone).toBe('Europe/Paris');
    const id = cards.body.wrap.id;
    expect((await as(t.app, await adult()).post(`/v1/wraps/${id}/dismiss`)).status).toBe(404);
    await as(t.app, u).post(`/v1/wraps/${id}/dismiss`);
    expect((await as(t.app, u).get('/v1/me/pulse-cards')).body.wrap).toBeNull();
    expect((await as(t.app, u).del(`/v1/wraps/${id}`)).status).toBe(200);
    expect((await as(t.app, u).get(`/v1/wraps/${id}`)).status).toBe(404);
    expect((await db().query(`SELECT 1 FROM notifications WHERE entity_id = $1`, [id])).rowCount).toBe(0);

    // On this day: your posts from this date in earlier years, only with Memories on.
    const old = (await as(t.app, u).post('/v1/posts', { body: 'Two years ago' })).body.post.id;
    await db().query(`UPDATE posts SET created_at = (now() AT TIME ZONE 'Europe/Paris' - interval '2 years') AT TIME ZONE 'Europe/Paris' WHERE id = $1`, [old]);
    await db().query(`INSERT INTO feature_flags (key, enabled) VALUES ('MEMORY', false) ON CONFLICT (key) DO UPDATE SET enabled = false`);
    expect((await as(t.app, u).get('/v1/me/pulse-cards')).body.onThisDay).toBeNull();
    await db().query(`UPDATE feature_flags SET enabled = true WHERE key = 'MEMORY'`);
    const otd = (await as(t.app, u).get('/v1/me/pulse-cards')).body.onThisDay;
    expect(otd).toMatchObject({ count: 1, years: [new Date().getUTCFullYear() - 2] });
    expect(otd.posts.map((x: any) => x.id)).toEqual([old]);
    await db().query(`DELETE FROM feature_flags WHERE key = 'MEMORY'`);
  });

  it('can be made for this week on demand in development and tests (for the accessibility audit), for yourself only', async () => {
    const [u, other] = [await adult(), await adult()];
    await as(t.app, u).post('/v1/posts', { body: 'Made this week' });
    expect((await as(t.app, other).post('/dev/weekly-wrap')).body.items).toEqual([]);
    const r = await as(t.app, u).post('/dev/weekly-wrap');
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0].counts).toMatchObject({ posts: 1 });
    // Once a week: asking again changes nothing.
    expect((await as(t.app, u).post('/dev/weekly-wrap')).body.items).toHaveLength(1);
    expect((await db().query(`SELECT 1 FROM weekly_wraps WHERE user_id = $1`, [other.id])).rowCount).toBe(1);
  });
});
