import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ffmpegPath from '../src/lib/ffmpeg-path.ts';
import { processJobs } from '../src/lib/jobs.ts';
import { privatePath } from '../src/lib/private-files.ts';
import { sweepViewOnce, viewOnceJobHandlers } from '../src/lib/view-once.ts';
import { planYap } from '../src/lib/yaps.ts';
import type { BuiltApp } from '../src/app.ts';
import { as, signUp, testApp, type TestUser } from './helpers.ts';

let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.close();
});

const ADULT = '1990-04-02';
const TEEN = '2011-03-01';
const db = () => t.ctx.db;
const adult = () => signUp(t.app, { birthDate: ADULT });

async function befriend(a: TestUser, b: TestUser) {
  const [x, y] = [a.id, b.id].sort();
  await db().query(`INSERT INTO friendships (user_a, user_b) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [x, y]);
}

/** A fake connected device: records every realtime event the user gets. */
function connect(u: TestUser) {
  const events: { type: string; data: any }[] = [];
  const remove = t.ctx.realtime.add(u.id, { readyState: 1, send: (raw: string) => void events.push(JSON.parse(raw)) });
  return { events, remove, yaps: () => events.filter((e) => e.type === 'yap') };
}

/** A voice clip of a given length, as if uploaded (the upload measures the length). */
async function clip(owner: TestUser, durationMs: number | null, kind = 'audio'): Promise<string> {
  const { rows } = await db().query(
    `INSERT INTO media (owner_id, kind, url, mime, status, duration_ms) VALUES ($1,$2,'http://localhost:4000/media/yap.m4a','audio/mp4','ready',$3) RETURNING id`,
    [owner.id, kind, durationMs],
  );
  return rows[0].id;
}

async function group(owner: TestUser, others: TestUser[]): Promise<string> {
  const r = await as(t.app, owner).post('/v1/conversations', { memberIds: others.map((o) => o.id), title: 'Crew' });
  expect(r.status).toBe(201);
  return r.body.conversation.id;
}

const sendYap = (from: TestUser, conversationId: string, mediaId: string) =>
  as(t.app, from).post(`/v1/conversations/${conversationId}/messages`, { kind: 'yap', attachments: [{ mediaId }], clientId: `y-${Math.random()}` });

function multipart(name: string, mime: string, data: Buffer) {
  const boundary = '----yp' + Math.random().toString(16).slice(2);
  return {
    boundary,
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

async function upload(u: TestUser, name: string, mime: string, data: Buffer, viewOnce = false) {
  const { boundary, payload } = multipart(name, mime, data);
  const res = await t.app.inject({
    method: 'POST',
    url: `/v1/media${viewOnce ? '?viewOnce=true' : ''}`,
    headers: { authorization: `Bearer ${u.token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
  return { status: res.statusCode, body: res.json() };
}

function tone(seconds: number): Buffer {
  const dir = mkdtempSync(path.join(tmpdir(), 'ypl-yap-'));
  try {
    const out = path.join(dir, 'clip.m4a');
    execFileSync(ffmpegPath as unknown as string, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:duration=${seconds}`,
      '-c:a',
      'aac',
      '-b:a',
      '32k',
      out,
    ]);
    return readFileSync(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('Yaps', () => {
  it('records like a voice message, plays out loud for friends by default and arrives silently for others', async () => {
    const sender = await adult();
    const friend = await adult();
    const stranger = await adult();
    await befriend(sender, friend);
    const convo = await group(sender, [friend, stranger]);
    const f = connect(friend);
    const s = connect(stranger);

    // A real recording: uploaded (converted to M4A and measured), then sent as a yap.
    const up = await upload(sender, 'yap.m4a', 'audio/mp4', tone(2));
    expect(up.status).toBe(201);
    const sent = await sendYap(sender, convo, up.body.media.id);
    expect(sent.status).toBe(201);
    expect(sent.body.message).toMatchObject({ kind: 'yap', attachments: [{ kind: 'audio' }] });

    expect(f.yaps()).toHaveLength(1);
    expect(f.yaps()[0]!.data).toMatchObject({ conversationId: convo, autoplay: true, message: { id: sent.body.message.id, kind: 'yap' } });
    expect(s.yaps()[0]!.data.autoplay).toBe(false);
    // Both still get it as a message, and it stays in the chat.
    expect(s.events.some((e) => e.type === 'message.created' && e.data.id === sent.body.message.id)).toBe(true);
    const history = await as(t.app, stranger).get(`/v1/conversations/${convo}/messages`);
    expect(history.body.items.find((m: any) => m.id === sent.body.message.id)).toMatchObject({ kind: 'yap' });

    // The chat reports the settings: friends-only default in a group, not paused.
    const c = await as(t.app, stranger).get(`/v1/conversations/${convo}`);
    expect(c.body.conversation.yaps).toEqual({ available: true, playOutLoud: null, defaultOutLoud: true, paused: false });

    // Each person decides per chat: the stranger turns them on, the friend turns them off.
    expect((await as(t.app, stranger).put(`/v1/conversations/${convo}/yaps`, { playOutLoud: true })).body.yaps.playOutLoud).toBe(true);
    expect((await as(t.app, friend).put(`/v1/conversations/${convo}/yaps`, { playOutLoud: false })).status).toBe(200);
    await sendYap(sender, convo, up.body.media.id);
    expect(s.yaps()[1]!.data.autoplay).toBe(true);
    expect(f.yaps()[1]!.data.autoplay).toBe(false);
    f.remove();
    s.remove();
  });

  it('is silent for blocked people, when paused or in focus mode, and not delivered to someone who blocked the sender', async () => {
    const sender = await adult();
    const [a, b, c, d] = await Promise.all([adult(), adult(), adult(), adult()]);
    for (const x of [a, b, c, d]) await befriend(sender, x);
    const convo = await group(sender, [a, b, c, d]);
    const clipId = await clip(sender, 3000);
    const devices = [a, b, c, d].map(connect);

    await db().query(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1,$2)`, [a.id, sender.id]); // a blocked the sender
    await db().query(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1,$2)`, [sender.id, b.id]); // the sender blocked b
    expect((await as(t.app, c).put('/v1/me/yaps', { paused: true })).body).toEqual({ paused: true });
    expect((await as(t.app, c).get('/v1/me/yaps')).body).toEqual({ paused: true });
    expect((await as(t.app, d).put('/v1/me/preferences/attention', { focusMode: true })).status).toBe(200);

    expect((await sendYap(sender, convo, clipId)).status).toBe(201);
    const [da, db_, dc, dd] = devices;
    expect(da!.yaps()).toHaveLength(0);
    expect(db_!.yaps()[0]!.data.autoplay).toBe(false);
    expect(dc!.yaps()[0]!.data.autoplay).toBe(false);
    expect(dd!.yaps()[0]!.data.autoplay).toBe(false);

    const plan = await planYap(db(), sender.id, convo, [a.id, b.id, c.id, d.id]);
    const reason = (u: TestUser) => plan.find((p) => p.userId === u.id)!.reason;
    expect([reason(a), reason(b), reason(c), reason(d)]).toEqual(['blocked', 'blocked', 'paused', 'focus']);

    // Unpausing brings autoplay back.
    await as(t.app, c).put('/v1/me/yaps', { paused: false });
    await sendYap(sender, convo, clipId);
    expect(dc!.yaps()[1]!.data.autoplay).toBe(true);
    devices.forEach((x) => x.remove());
  });

  it('respects quiet hours from family controls and minor protections', async () => {
    const parent = await adult();
    const teen = await signUp(t.app, { birthDate: TEEN });
    const stranger = await adult();
    await db().query(`INSERT INTO family_links (guardian_id, teen_id, status, accepted_at) VALUES ($1,$2,'active',now())`, [parent.id, teen.id]);
    // Quiet hours that cover right now.
    await db().query(
      `INSERT INTO teen_controls (teen_id, quiet_start, quiet_end, timezone)
       VALUES ($1, (now() AT TIME ZONE 'UTC' - interval '1 hour')::time, (now() AT TIME ZONE 'UTC' + interval '1 hour')::time, 'UTC')`,
      [teen.id],
    );
    const dm = (await as(t.app, parent).post('/v1/conversations', { memberIds: [teen.id] })).body.conversation.id;
    const d = connect(teen);
    expect((await sendYap(parent, dm, await clip(parent, 4000))).status).toBe(201);
    expect(d.yaps()[0]!.data.autoplay).toBe(false);
    expect((await planYap(db(), parent.id, dm, [teen.id]))[0]!.reason).toBe('quiet');

    // Outside quiet hours the guardian's yaps play (a family link counts like a friend).
    await db().query(`UPDATE teen_controls SET quiet_start = NULL, quiet_end = NULL WHERE teen_id = $1`, [teen.id]);
    await sendYap(parent, dm, await clip(parent, 4000));
    expect(d.yaps()[1]!.data.autoplay).toBe(true);
    d.remove();

    // An adult who isn't a friend can't reach a teen at all in a one-to-one chat...
    expect((await as(t.app, stranger).post('/v1/conversations', { memberIds: [teen.id] })).status).toBe(403);
    // ...and in a shared group their yaps never play out loud for the teen, even with the setting on.
    const room = await group(parent, [stranger]);
    await db().query(`INSERT INTO conversation_members (conversation_id, user_id, yaps_out_loud) VALUES ($1,$2,true)`, [room, teen.id]);
    expect((await planYap(db(), stranger.id, room, [teen.id]))[0]).toMatchObject({ autoplay: false, reason: 'minor', deliver: true });
  });

  it('notifies people who are not connected', async () => {
    const sender = await adult();
    const online = await adult();
    const offline = await adult();
    const convo = await group(sender, [online, offline]);
    const d = connect(online);
    await sendYap(sender, convo, await clip(sender, 2000));
    const notes = async (u: TestUser) =>
      (await db().query(`SELECT actor_id, entity_id FROM notifications WHERE user_id = $1 AND type = 'yap_received'`, [u.id])).rows;
    expect(await notes(offline)).toEqual([{ actor_id: sender.id, entity_id: convo }]);
    expect(await notes(online)).toEqual([]);
    d.remove();
  });

  it('allows 30 yaps a minute per sender and clips up to 60 seconds, in chats of up to 12 people', async () => {
    const sender = await adult();
    const other = await adult();
    const dm = (await as(t.app, sender).post('/v1/conversations', { memberIds: [other.id] })).body.conversation.id;

    expect((await sendYap(sender, dm, await clip(sender, 61_000))).body.error.code).toBe('yap_too_long');
    expect((await sendYap(sender, dm, await clip(sender, null))).body.error.code).toBe('yap_length_unknown');
    expect((await sendYap(sender, dm, await clip(sender, 3000, 'image'))).body.error.code).toBe('yap_not_voice');
    const ok = await clip(sender, 60_300);
    expect((await sendYap(sender, dm, ok)).status).toBe(201);

    for (let i = 1; i < 30; i++) expect((await sendYap(sender, dm, ok)).status).toBe(201);
    const over = await sendYap(sender, dm, ok);
    expect(over.status).toBe(429);
    expect(over.body.error.code).toBe('yap_rate_limited');
    // Ordinary messages aren't affected.
    expect((await as(t.app, sender).post(`/v1/conversations/${dm}/messages`, { body: 'still here' })).status).toBe(201);
    // A minute later they can yap again.
    await db().query(`UPDATE messages SET created_at = created_at - interval '2 minutes' WHERE sender_id = $1 AND kind = 'yap'`, [sender.id]);
    expect((await sendYap(sender, dm, ok)).status).toBe(201);

    const people = await Promise.all(Array.from({ length: 12 }, () => adult()));
    const big = await group(sender, people);
    const r = await sendYap(sender, big, ok);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('yaps_unavailable');
    expect((await as(t.app, sender).get(`/v1/conversations/${big}`)).body.conversation.yaps.available).toBe(false);
  });
});

describe('View once', () => {
  const photo = () =>
    sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 40, b: 90 } } })
      .jpeg()
      .toBuffer();
  const handlers = () => viewOnceJobHandlers({ db: db(), config: t.ctx.config, storage: t.ctx.storage, realtime: t.ctx.realtime });
  const runJobs = async () => {
    for (let i = 0; i < 20; i++) if (!(await processJobs(db(), handlers()))) return;
  };
  const keyOf = async (mediaId: string) => (await db().query(`SELECT storage_key, deleted_at FROM media WHERE id = $1`, [mediaId])).rows[0];

  async function sendViewOnce(sender: TestUser, others: TestUser[]) {
    const convo =
      others.length === 1
        ? (await as(t.app, sender).post('/v1/conversations', { memberIds: [others[0]!.id] })).body.conversation.id
        : await group(sender, others);
    const up = await upload(sender, 'secret.jpg', 'image/jpeg', await photo(), true);
    expect(up.status).toBe(201);
    const sent = await as(t.app, sender).post(`/v1/conversations/${convo}/messages`, { viewOnce: true, attachments: [{ mediaId: up.body.media.id }] });
    expect(sent.status).toBe(201);
    return { convo, mediaId: up.body.media.id as string, messageId: sent.body.message.id as string, sent: sent.body.message };
  }

  it('stores the file privately and serves it once, only to the person it was opened for', async () => {
    const sender = await adult();
    const b = await adult();
    const c = await adult();
    const outsider = await adult();
    const { convo, mediaId, messageId, sent } = await sendViewOnce(sender, [b, c]);

    // No public address anywhere: the upload, the stored file and the message.
    const stored = await keyOf(mediaId);
    expect(stored.storage_key).toMatch(/^private\//);
    expect(existsSync(privatePath(t.ctx, stored.storage_key))).toBe(true);
    expect(sent.attachments[0]).toMatchObject({ kind: 'image', url: '' });
    expect(sent.viewOnce).toMatchObject({ state: 'ready', kind: 'image', openedBy: [] });
    expect((await t.app.inject({ method: 'GET', url: `/media/${stored.storage_key}` })).statusCode).toBe(404);

    // A view-once upload can't go out as an ordinary message, and an ordinary one can't be view once.
    expect((await as(t.app, sender).post(`/v1/conversations/${convo}/messages`, { attachments: [{ mediaId }] })).body.error.code).toBe('view_once_only');
    const plain = await upload(sender, 'plain.jpg', 'image/jpeg', await photo());
    const wrong = await as(t.app, sender).post(`/v1/conversations/${convo}/messages`, { viewOnce: true, attachments: [{ mediaId: plain.body.media.id }] });
    expect(wrong.body.error.code).toBe('view_once_upload');

    const seenByB = (await as(t.app, b).get(`/v1/conversations/${convo}/messages`)).body.items.find((m: any) => m.id === messageId);
    expect(seenByB.viewOnce).toMatchObject({ state: 'ready', kind: 'image' });
    expect(seenByB.viewOnce.openedBy).toBeUndefined();
    expect(seenByB.attachments[0].url).toBe('');

    // The sender and people outside the chat can't open it.
    expect((await as(t.app, sender).post(`/v1/messages/${messageId}/view-once/open`)).status).toBe(403);
    expect((await as(t.app, outsider).post(`/v1/messages/${messageId}/view-once/open`)).status).toBe(404);

    const opened = await as(t.app, b).post(`/v1/messages/${messageId}/view-once/open`);
    expect(opened.status).toBe(200);
    expect(opened.body.url).toMatch(/^\/v1\/view-once\//);
    const fetchAs = (u: TestUser, url: string) => t.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${u.token}` } });

    // Another member of the chat can't use b's link, and neither can someone signed out.
    expect((await fetchAs(c, opened.body.url)).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: opened.body.url })).statusCode).toBe(401);
    expect((await fetchAs(b, opened.body.url.slice(0, -3) + 'abc')).statusCode).toBe(403);

    const file = await fetchAs(b, opened.body.url);
    expect(file.statusCode).toBe(200);
    expect(file.headers['cache-control']).toContain('no-store');
    expect(file.headers['content-type']).toBe('image/jpeg');
    expect(file.rawPayload.subarray(0, 3).toString('hex')).toBe('ffd8ff');

    // The sender sees who opened it.
    const senderView = async () =>
      (await as(t.app, sender).get(`/v1/conversations/${convo}/messages`)).body.items.find((m: any) => m.id === messageId).viewOnce;
    expect((await senderView()).openedBy).toMatchObject([{ user: { id: b.id }, viewedAt: null, screenshot: false }]);

    // Closed: a second fetch, even with a link that hasn't expired yet, is refused, and so is opening it again.
    const closed = await as(t.app, b).post(`/v1/messages/${messageId}/view-once/viewed`);
    expect(closed.body.viewOnce.state).toBe('viewed');
    const again = await fetchAs(b, opened.body.url);
    expect(again.statusCode).toBe(410);
    expect(again.json().error.code).toBe('view_once_viewed');
    expect((await as(t.app, b).post(`/v1/messages/${messageId}/view-once/open`)).status).toBe(410);
    expect((await senderView()).openedBy[0].viewedAt).not.toBeNull();
    // c hasn't opened it yet, so the file is still there.
    await runJobs();
    expect(existsSync(privatePath(t.ctx, stored.storage_key))).toBe(true);
  });

  it('deletes the file from storage once everyone in the chat has viewed it', async () => {
    const sender = await adult();
    const b = await adult();
    const c = await adult();
    const { convo, mediaId, messageId } = await sendViewOnce(sender, [b, c]);
    const key = (await keyOf(mediaId)).storage_key;
    const s = connect(sender);

    for (const u of [b, c]) {
      expect((await as(t.app, u).post(`/v1/messages/${messageId}/view-once/open`)).status).toBe(200);
      expect((await as(t.app, u).post(`/v1/messages/${messageId}/view-once/viewed`)).status).toBe(200);
    }
    await runJobs();
    expect(existsSync(privatePath(t.ctx, key))).toBe(false);
    expect((await keyOf(mediaId)).deleted_at).not.toBeNull();
    const view = (u: TestUser) => as(t.app, u).get(`/v1/conversations/${convo}/messages`);
    expect((await view(sender)).body.items.find((m: any) => m.id === messageId).viewOnce).toMatchObject({ state: 'viewed' });
    expect((await view(b)).body.items.find((m: any) => m.id === messageId).viewOnce.state).toBe('viewed');
    expect(s.events.some((e) => e.type === 'view_once.updated' && e.data.id === messageId && e.data.viewOnce.state === 'viewed')).toBe(true);
    s.remove();
  });

  it('expires after 14 days: the file is deleted and the message shows it expired', async () => {
    const sender = await adult();
    const b = await adult();
    const { convo, mediaId, messageId } = await sendViewOnce(sender, [b]);
    const key = (await keyOf(mediaId)).storage_key;
    // The worker has a job queued for day 14.
    const job = (
      await db().query(`SELECT run_at - now() > interval '13 days' AS later FROM jobs WHERE kind = 'viewonce.check' AND payload->>'messageId' = $1`, [
        messageId,
      ])
    ).rows[0];
    expect(job.later).toBe(true);

    await db().query(`UPDATE messages SET created_at = now() - interval '13 days' WHERE id = $1`, [messageId]);
    await sweepViewOnce({ db: db(), config: t.ctx.config, storage: t.ctx.storage });
    expect(existsSync(privatePath(t.ctx, key))).toBe(true);

    await db().query(`UPDATE messages SET created_at = now() - interval '15 days' WHERE id = $1`, [messageId]);
    await db().query(`UPDATE jobs SET run_at = now() WHERE kind = 'viewonce.check' AND payload->>'messageId' = $1`, [messageId]);
    await runJobs();
    expect(existsSync(privatePath(t.ctx, key))).toBe(false);
    const bView = (await as(t.app, b).get(`/v1/conversations/${convo}/messages`)).body.items.find((m: any) => m.id === messageId);
    expect(bView.viewOnce.state).toBe('expired');
    expect((await as(t.app, sender).get(`/v1/conversations/${convo}/messages`)).body.items.find((m: any) => m.id === messageId).viewOnce.state).toBe('expired');
    const late = await as(t.app, b).post(`/v1/messages/${messageId}/view-once/open`);
    expect(late.status).toBe(410);
    expect(late.body.error.code).toBe('view_once_expired');
  });

  it('tells the sender about a screenshot, counts an open that was never closed, and deletes the file of an unsent message', async () => {
    const sender = await adult();
    const b = await adult();
    const first = await sendViewOnce(sender, [b]);
    expect((await as(t.app, b).post(`/v1/messages/${first.messageId}/view-once/screenshot`)).status).toBe(400); // not opened yet
    await as(t.app, b).post(`/v1/messages/${first.messageId}/view-once/open`);
    expect((await as(t.app, b).post(`/v1/messages/${first.messageId}/view-once/screenshot`)).status).toBe(200);
    const note = (await db().query(`SELECT actor_id, data FROM notifications WHERE user_id = $1 AND type = 'view_once_screenshot'`, [sender.id])).rows;
    expect(note).toMatchObject([{ actor_id: b.id, data: { messageId: first.messageId } }]);

    // Opened 11 minutes ago and never closed (the app was closed): it counts as viewed.
    await db().query(`UPDATE message_views SET opened_at = now() - interval '11 minutes' WHERE message_id = $1`, [first.messageId]);
    expect((await as(t.app, b).post(`/v1/messages/${first.messageId}/view-once/open`)).status).toBe(410);
    await sweepViewOnce({ db: db(), config: t.ctx.config, storage: t.ctx.storage });
    expect((await keyOf(first.mediaId)).deleted_at).not.toBeNull();

    const second = await sendViewOnce(sender, [b]);
    const key = (await keyOf(second.mediaId)).storage_key;
    expect((await as(t.app, sender).del(`/v1/messages/${second.messageId}`)).status).toBe(200);
    await runJobs();
    expect(existsSync(privatePath(t.ctx, key))).toBe(false);
  });

  it('turns a view-once video into a web MP4 that stays private', async () => {
    const sender = await adult();
    const dir = mkdtempSync(path.join(tmpdir(), 'ypl-vo-'));
    const mov = path.join(dir, 'clip.mov');
    execFileSync(ffmpegPath as unknown as string, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=160x120:rate=10:duration=2',
      '-c:v',
      'mpeg4',
      mov,
    ]);
    const up = await upload(sender, 'clip.mov', 'video/quicktime', readFileSync(mov), true);
    rmSync(dir, { recursive: true, force: true });
    expect(up.status).toBe(201);
    expect(up.body.media).toMatchObject({ kind: 'video', url: '' });
    const before = (await keyOf(up.body.media.id)).storage_key;
    await runJobs();
    const after = (await db().query(`SELECT storage_key, mime, url, variants, poster_url FROM media WHERE id = $1`, [up.body.media.id])).rows[0];
    expect(after).toMatchObject({ mime: 'video/mp4', url: '', variants: {}, poster_url: null });
    expect(after.storage_key).toMatch(/^private\/.*\.mp4$/);
    expect(existsSync(privatePath(t.ctx, before))).toBe(false);
    expect(existsSync(privatePath(t.ctx, after.storage_key))).toBe(true);
  });

  it('accepts only photos and videos, and each upload goes in one message', async () => {
    const sender = await adult();
    const b = await adult();
    expect((await upload(sender, 'voice.m4a', 'audio/mp4', tone(1), true)).status).toBe(415);
    const { convo, mediaId } = await sendViewOnce(sender, [b]);
    const again = await as(t.app, sender).post(`/v1/conversations/${convo}/messages`, { viewOnce: true, attachments: [{ mediaId }] });
    expect(again.status).toBe(409);
  });
});
