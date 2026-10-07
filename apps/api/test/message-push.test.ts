import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BuiltApp } from '../src/app.ts';
import { createPushSender, type PushMessage } from '../src/lib/push.ts';
import { setPushSender } from '../src/lib/services.ts';
import { as, followAccepted, signUp, testApp, type TestUser } from './helpers.ts';

let t: BuiltApp;
const pushes: { userId: string; msg: PushMessage }[] = [];
const record = async (userId: string, msg: PushMessage) => void pushes.push({ userId, msg });
beforeAll(async () => {
  t = await testApp();
  // Tests run without a push service; this records what would go out.
  setPushSender(record);
});
beforeEach(() => setPushSender(record));
afterAll(async () => {
  setPushSender(null);
  await t.close();
});

const db = () => t.ctx.db;

async function person(name: string, extra: Record<string, unknown> = {}): Promise<TestUser> {
  const u = await signUp(t.app, extra);
  await db().query(`UPDATE profiles SET display_name = $2 WHERE user_id = $1`, [u.id, name]);
  return u;
}

async function befriend(a: TestUser, b: TestUser) {
  const [x, y] = [a.id, b.id].sort();
  await db().query(`INSERT INTO friendships (user_a, user_b) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [x, y]);
}

/** A connected device: the person is online. */
const connect = (u: TestUser) => t.ctx.realtime.add(u.id, { readyState: 1, send: () => {} });

async function chat(a: TestUser, b: TestUser, friends = true): Promise<string> {
  if (friends) await befriend(a, b);
  const r = await as(t.app, a).post('/v1/conversations', { memberIds: [b.id] });
  expect(r.status).toBe(201);
  return r.body.conversation.id;
}

async function send(from: TestUser, conversationId: string, payload: Record<string, unknown>) {
  const r = await as(t.app, from).post(`/v1/conversations/${conversationId}/messages`, { clientId: `c-${Math.random()}`, ...payload });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.message;
}

/** Pushes go out in the background: wait a moment for them. */
async function settle() {
  await new Promise((r) => setTimeout(r, 60));
}
const messagePushes = (u: TestUser) => pushes.filter((p) => p.userId === u.id && p.msg.data?.type === 'message');

async function media(owner: TestUser, kind: 'image' | 'audio', viewOnce = false): Promise<string> {
  const { rows } = await db().query(
    `INSERT INTO media (owner_id, kind, url, mime, status, private, duration_ms) VALUES ($1,$2,$3,$4,'ready',$5,$6) RETURNING id`,
    [
      owner.id,
      kind,
      viewOnce ? '' : `http://localhost:4000/media/x.${kind === 'image' ? 'jpg' : 'm4a'}`,
      kind === 'image' ? 'image/jpeg' : 'audio/mp4',
      viewOnce,
      kind === 'audio' ? 4000 : null,
    ],
  );
  return rows[0].id;
}

describe('new message pushes', () => {
  it('pushes once per chat while unread, says how many later, opens the chat and stays out of Activity', async () => {
    const ada = await person('Ada');
    const bo = await person('Bo');
    const id = await chat(ada, bo);
    const unreadBefore = (await as(t.app, bo).get('/v1/notifications')).body.unread;
    await send(ada, id, { body: 'See you at six' });
    await send(ada, id, { body: 'Bring the speaker' });
    await send(ada, id, { body: 'And snacks' });
    await settle();
    // One push for the three: the first one's words, and it opens the chat (YAPILAPI, Yap and the web).
    expect(messagePushes(bo)).toHaveLength(1);
    expect(messagePushes(bo)[0]!.msg).toMatchObject({
      title: 'YAPILAPI',
      body: 'Ada: See you at six',
      url: `/inbox/${id}`,
      tag: `message:${id}`,
      data: { type: 'message', entityType: 'conversation', entityId: id },
    });
    // The sender is never told about their own messages.
    expect(messagePushes(ada)).toHaveLength(0);
    // Not in the Activity list, nor its count: the chat list's unread count says it.
    const activity = (await as(t.app, bo).get('/v1/notifications')).body;
    expect(activity.items.some((n: any) => n.type === 'message')).toBe(false);
    expect(activity.unread).toBe(unreadBefore);
    // A while later, the next one goes out again, saying how many (the browser replaces the first).
    await db().query(`UPDATE notifications SET data = data || '{"pushedAt": 0}' WHERE user_id = $1 AND type = 'message'`, [bo.id]);
    await send(ada, id, { body: 'On my way' });
    await settle();
    expect(messagePushes(bo).map((p) => p.msg.body)).toEqual(['Ada: See you at six', 'Ada: 4 new messages']);
    expect(messagePushes(bo)[1]!.msg.tag).toBe(`message:${id}`);
  });

  it('clears when the chat is read, so the next message pushes again with its words', async () => {
    const ada = await person('Ada');
    const bo = await person('Bo');
    const id = await chat(ada, bo);
    await send(ada, id, { body: 'First' });
    await send(ada, id, { body: 'Second' });
    await settle();
    expect(messagePushes(bo)).toHaveLength(1);
    const rows = async () => (await db().query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'message' AND entity_id = $2`, [bo.id, id])).rowCount;
    expect(await rows()).toBe(1);
    expect((await as(t.app, bo).post(`/v1/conversations/${id}/read`)).status).toBe(200);
    expect(await rows()).toBe(0);
    await send(ada, id, { body: 'Third' });
    await settle();
    expect(messagePushes(bo).map((p) => p.msg.body)).toEqual(['Ada: First', 'Ada: Third']);
    // Marking all of Activity read doesn't touch a chat's push.
    expect((await as(t.app, bo).post('/v1/notifications/read')).status).toBe(200);
    expect(await rows()).toBe(1);
  });

  it('pushes nobody who is connected, and names the group', async () => {
    const ada = await person('Ada');
    const bo = await person('Bo');
    const cy = await person('Cy');
    await befriend(ada, bo);
    await befriend(ada, cy);
    const r = await as(t.app, ada).post('/v1/conversations', { memberIds: [bo.id, cy.id], title: 'Crew' });
    const id = r.body.conversation.id;
    const remove = connect(cy);
    try {
      await send(ada, id, { body: 'Who is in' });
      await settle();
    } finally {
      remove();
    }
    expect(messagePushes(bo).map((p) => p.msg.body)).toEqual(['Ada in Crew: Who is in']);
    expect(messagePushes(cy)).toHaveLength(0);
    // Lines the server writes (someone renamed the group) never push.
    expect((await as(t.app, ada).patch(`/v1/conversations/${id}`, { title: 'Crew 2' })).status).toBe(200);
    await as(t.app, bo).post(`/v1/conversations/${id}/read`);
    await settle();
    expect(messagePushes(bo)).toHaveLength(1);
  });

  it('respects the Messages setting, quiet hours, a pause, mutes, blocks and suspended accounts', async () => {
    const ada = await person('Ada');
    const off = await person('Off');
    const quiet = await person('Quiet');
    const paused = await person('Paused');
    const muter = await person('Muter');
    const blocker = await person('Blocker');
    const suspended = await person('Suspended');
    for (const u of [off, quiet, paused, muter, blocker, suspended]) await befriend(ada, u);
    const crew = (
      await as(t.app, ada).post('/v1/conversations', { memberIds: [off.id, quiet.id, paused.id, muter.id, blocker.id, suspended.id], title: 'All' })
    ).body.conversation.id;
    expect((await as(t.app, off).put('/v1/me/preferences/notifications', { categories: { messages: false } })).status).toBe(200);
    // Quiet hours around now, in UTC.
    const hh = (h: number) => `${String((h + 24) % 24).padStart(2, '0')}:00`;
    const hour = new Date().getUTCHours();
    expect((await as(t.app, quiet).put('/v1/me/interactions', { quietHours: { start: hh(hour - 1), end: hh(hour + 2), timezone: 'UTC' } })).status).toBe(200);
    const until = new Date(Date.now() + 3600_000).toISOString();
    expect((await as(t.app, paused).put('/v1/me/preferences/attention', { notificationsPausedUntil: until })).status).toBe(200);
    await db().query(`INSERT INTO mutes (muter_id, muted_id) VALUES ($1,$2)`, [muter.id, ada.id]);
    await db().query(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1,$2)`, [blocker.id, ada.id]);
    await db().query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [suspended.id]);
    await send(ada, crew, { body: 'Anyone' });
    await settle();
    for (const u of [off, quiet, paused, muter, blocker, suspended]) expect(messagePushes(u), u.username).toHaveLength(0);
    // Quiet hours hold the push, not the next one after them: nothing went out, so it does once they end.
    await as(t.app, quiet).put('/v1/me/interactions', { quietHours: null });
    await send(ada, crew, { body: 'Still here' });
    await settle();
    expect(messagePushes(quiet).map((p) => p.msg.body)).toEqual(['Ada in All: 2 new messages']);
  });

  it('pushes a message request once, until they write back', async () => {
    const stranger = await person('Dee');
    const bo = await person('Bo');
    // They follow each other (so writing needs no confirmed email) but aren't friends.
    await followAccepted(t.app, stranger, bo);
    await followAccepted(t.app, bo, stranger);
    const id = await chat(stranger, bo, false);
    await send(stranger, id, { body: 'Hi, we met at the fair' });
    await send(stranger, id, { body: 'Hello?' });
    await settle();
    expect(messagePushes(bo).map((p) => p.msg.body)).toEqual(['Dee: Hi, we met at the fair']);
    // Reading it doesn't open the door to a push per message.
    await as(t.app, bo).post(`/v1/conversations/${id}/read`);
    await send(stranger, id, { body: 'Are you there' });
    await settle();
    expect(messagePushes(bo)).toHaveLength(1);
    // Once they write back it's a conversation.
    await send(bo, id, { body: 'Hi Dee' });
    await send(stranger, id, { body: 'Great' });
    await settle();
    expect(messagePushes(bo).map((p) => p.msg.body)).toEqual(['Dee: Hi, we met at the fair', 'Dee: Great']);
  });

  it('says what it is, never what it says, for disappearing and view-once messages', async () => {
    const ada = await person('Ada');
    const bo = await person('Bo');
    const id = await chat(ada, bo);
    const read = () => as(t.app, bo).post(`/v1/conversations/${id}/read`);
    // A voice message and a photo say so.
    await send(ada, id, { attachments: [{ mediaId: await media(ada, 'audio') }] });
    await settle();
    await read();
    await send(ada, id, { body: '', attachments: [{ mediaId: await media(ada, 'image') }] });
    await settle();
    await read();
    // View once: what it is, never more.
    await send(ada, id, { viewOnce: true, attachments: [{ mediaId: await media(ada, 'image', true) }] });
    await settle();
    await read();
    // Disappearing messages: never their words.
    expect((await as(t.app, ada).put(`/v1/conversations/${id}/disappearing`, { seconds: 86400 })).status).toBe(200);
    await read();
    await send(ada, id, { body: 'The code is 4417' });
    await settle();
    await read();
    await send(ada, id, { body: 'With a photo', attachments: [{ mediaId: await media(ada, 'image') }] });
    await settle();
    const bodies = messagePushes(bo).map((p) => p.msg.body);
    expect(bodies).toEqual(['Ada: Voice message', 'Ada: Photo', 'Ada: Photo · View once', 'Ada: New message', 'Ada: Photo']);
    expect(JSON.stringify(messagePushes(bo))).not.toMatch(/4417|With a photo/);
  });

  it('pushes polls, and writes in the recipient’s language', async () => {
    const ada = await person('Ada');
    const bo = await person('Bo');
    await db().query(`UPDATE profiles SET locale = 'fr' WHERE user_id = $1`, [bo.id]);
    const id = await chat(ada, bo);
    const r = await as(t.app, ada).post(`/v1/conversations/${id}/polls`, { question: 'Pizza or rice', options: ['Pizza', 'Rice'], clientId: 'p1' });
    expect(r.status).toBe(201);
    await settle();
    const [p] = messagePushes(bo);
    expect(p!.msg.body).toMatch(/^Ada : .*Pizza or rice/);
    await db().query(`UPDATE notifications SET data = data || '{"pushedAt": 0}' WHERE user_id = $1 AND type = 'message'`, [bo.id]);
    await send(ada, id, { body: 'Vote' });
    await settle();
    expect(messagePushes(bo)[1]!.msg.body).toBe('Ada : 2 nouveaux messages');
  });

  it('reaches the Yap phone app, titled Yap', async () => {
    const ada = await person('Ada');
    const bo = await person('Bo');
    const id = await chat(ada, bo);
    const token = `ExponentPushToken[yap-${bo.id.slice(0, 8)}]`;
    expect((await as(t.app, bo).post('/v1/push/subscriptions', { kind: 'expo', endpoint: token, app: 'yap' })).status).toBe(201);
    const sent: { to: string; title: string; body: string; data: Record<string, string> }[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ data: { status: 'ok' } }));
    }) as typeof fetch;
    setPushSender(createPushSender(t.ctx.db, t.ctx.config, fakeFetch));
    await send(ada, id, { body: 'Call me' });
    for (let i = 0; i < 40 && !sent.length; i++) await new Promise((r) => setTimeout(r, 25));
    expect(sent).toEqual([
      expect.objectContaining({
        to: token,
        title: 'Yap',
        body: 'Ada: Call me',
        data: expect.objectContaining({ url: `/inbox/${id}`, type: 'message', entityId: id }),
      }),
    ]);
  });
});
