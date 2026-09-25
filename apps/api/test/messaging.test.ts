import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { QueryResultRow } from 'pg';
import { withTransaction } from '@yapilapi/database';
import {
  Client,
  ORIGIN,
  createTestApp,
  signup,
  uniq,
  type TestApp,
  type TestUser,
} from './helpers.js';
import { getDeletionHooks } from '../src/lib/hooks.js';
import { notify } from '../src/lib/notify.js';
import { sendMessage } from '../src/modules/messaging/index.js';
import { realtimeSettings } from '../src/modules/messaging/realtime.js';

let t: TestApp;
let port = 0;
beforeAll(async () => {
  t = await createTestApp();
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  port = (t.app.server.address() as { port: number }).port;
});
afterAll(async () => {
  await t.close();
});

// ------------------------------------------------------------------ helpers
const sql = <T extends QueryResultRow = any>(text: string, params: unknown[] = []) =>
  t.ctx.db.query<T>(text, params);

const befriend = async (a: TestUser, b: TestUser) => {
  await a.client.post('/v1/friends/requests', { username: b.username });
  await b.client.post(`/v1/friends/requests/${a.id}/accept`);
};
const teen = () => signup(t, { birthDate: `${new Date().getUTCFullYear() - 15}-02-02` });
const setWho = (u: TestUser, whoCanMessage: string) =>
  sql('UPDATE user_preferences SET who_can_message = $2 WHERE user_id = $1', [u.id, whoCanMessage]);

const dm = async (a: TestUser, b: TestUser) => {
  const r = await a.client.post('/v1/conversations/direct', { userId: b.id });
  if (r.status !== 200 && r.status !== 201)
    throw new Error(`dm failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id as string;
};
const group = async (owner: TestUser, members: TestUser[], title = 'Trip crew') => {
  const r = await owner.client.post('/v1/conversations/group', {
    title,
    memberIds: members.map((m) => m.id),
  });
  if (r.status !== 201) throw new Error(`group failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id as string;
};
const say = async (
  u: TestUser,
  conv: string,
  body: string,
  extra: Record<string, unknown> = {},
) => {
  const r = await u.client.post(`/v1/conversations/${conv}/messages`, { body, ...extra });
  if (r.status !== 201) throw new Error(`send failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const mkMedia = async (u: TestUser, kind = 'image') =>
  (
    await sql<{ id: string }>(
      `INSERT INTO media (owner_id, kind, storage_key, mime_type, size_bytes, status) VALUES ($1,$2,$3,'application/octet-stream',1000,'ready') RETURNING id`,
      [u.id, kind, `m/${uniq('k')}`],
    )
  ).rows[0]!.id;

async function createCommunity(owner: TestUser) {
  const slug = `${uniq('c')}x`;
  const { rows } = await sql<{ id: string }>(
    `INSERT INTO communities (slug, name, visibility, created_by) VALUES ($1,$2,'public',$3) RETURNING id`,
    [slug, `Community ${slug}`, owner.id],
  );
  const id = rows[0]!.id;
  for (const [key, rank, perms] of [
    ['owner', 100, ['post', 'comment', 'moderate']],
    ['member', 10, ['post', 'comment']],
    ['reader', 5, ['comment']],
  ] as const) {
    await sql(
      `INSERT INTO community_roles (community_id, key, name, permissions, is_system, rank) VALUES ($1,$2,$2,$3,true,$4)`,
      [id, key, perms as unknown as string[], rank],
    );
  }
  await sql(
    `INSERT INTO community_members (community_id, user_id, role_key, status, joined_at) VALUES ($1,$2,'owner','active',now())`,
    [id, owner.id],
  );
  const ch = await sql<{ id: string }>(
    `INSERT INTO conversations (kind, community_id, channel_name, channel_kind, created_by) VALUES ('community_channel',$1,'general','text',$2) RETURNING id`,
    [id, owner.id],
  );
  return { communityId: id, channelId: ch.rows[0]!.id };
}
const joinCommunity = (communityId: string, u: TestUser, status = 'active', role = 'member') =>
  sql(
    `INSERT INTO community_members (community_id, user_id, role_key, status, joined_at) VALUES ($1,$2,$3,$4,now()) ON CONFLICT (community_id, user_id) DO UPDATE SET status = $4, role_key = $3`,
    [communityId, u.id, role, status],
  );

// WebSocket client helper
class Sock {
  frames: any[] = [];
  private used = new Set<number>();
  closed: Promise<{ code: number }>;
  constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => this.frames.push(JSON.parse(d.toString())));
    this.closed = new Promise((res) => ws.on('close', (code) => res({ code })));
  }
  async expect(pred: (f: any) => boolean, ms = 3000): Promise<any> {
    const end = Date.now() + ms;
    for (;;) {
      const i = this.frames.findIndex((f, idx) => !this.used.has(idx) && pred(f));
      if (i >= 0) {
        this.used.add(i);
        return this.frames[i];
      }
      if (Date.now() > end)
        throw new Error(`timeout waiting for frame; got ${JSON.stringify(this.frames)}`);
      await new Promise((r) => setTimeout(r, 15));
    }
  }
  async none(pred: (f: any) => boolean, ms = 300) {
    await new Promise((r) => setTimeout(r, ms));
    expect(this.frames.filter((f, idx) => !this.used.has(idx) && pred(f))).toEqual([]);
  }
  send(f: unknown) {
    this.ws.send(typeof f === 'string' ? f : JSON.stringify(f));
  }
  close() {
    this.ws.close();
  }
}
const wsUrl = (ticket: string) =>
  `ws://127.0.0.1:${port}/v1/ws?ticket=${encodeURIComponent(ticket)}`;
const ticketFor = async (u: TestUser) => {
  const r = await u.client.post('/v1/ws/ticket');
  if (r.status !== 200) throw new Error(`ticket failed ${r.status}`);
  return r.body.ticket as string;
};
const open: Sock[] = [];
async function connect(u: TestUser): Promise<Sock> {
  const ws = new WebSocket(wsUrl(await ticketFor(u)), { headers: { origin: ORIGIN } });
  const s = new Sock(ws);
  open.push(s);
  await new Promise<void>((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
    ws.once('unexpected-response', (_q, r) => rej(new Error(`rejected ${r.statusCode}`)));
  });
  await s.expect((f) => f.type === 'ready');
  return s;
}
/** Try to connect and return the HTTP status the upgrade was rejected with (or 101). */
function upgradeStatus(
  url: string,
  headers: Record<string, string> = { origin: ORIGIN },
): Promise<number> {
  return new Promise((res) => {
    const ws = new WebSocket(url, { headers });
    ws.once('open', () => {
      open.push(new Sock(ws));
      res(101);
    });
    ws.once('unexpected-response', (_q, r) => {
      r.resume();
      res(r.statusCode ?? 0);
    });
    ws.once('error', () => res(0));
  });
}
afterEach(() => {
  for (const s of open.splice(0)) s.close();
  realtimeSettings.heartbeatMs = 30_000;
});

// ================================================================== conversations
describe('direct conversations', () => {
  it('creates or gets the same conversation idempotently, from either side', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const first = await a.client.post('/v1/conversations/direct', { userId: b.id });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      kind: 'direct',
      canSend: true,
      peer: { id: b.id, username: b.username },
    });
    const again = await a.client.post('/v1/conversations/direct', { username: b.username });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    const reverse = await b.client.post('/v1/conversations/direct', { userId: a.id });
    expect(reverse.body.id).toBe(first.body.id);
    const [low, high] = [a.id, b.id].sort();
    const row = await sql('SELECT direct_key FROM conversations WHERE id = $1', [first.body.id]);
    expect(row.rows[0].direct_key).toBe(`${low}:${high}`);
    expect(
      (
        await sql(
          'SELECT count(*)::int AS n FROM conversation_members WHERE conversation_id = $1',
          [first.body.id],
        )
      ).rows[0].n,
    ).toBe(2);
  });

  it('survives concurrent creation without duplicates', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const rs = await Promise.all([
      a.client.post('/v1/conversations/direct', { userId: b.id }),
      b.client.post('/v1/conversations/direct', { userId: a.id }),
      a.client.post('/v1/conversations/direct', { userId: b.id }),
    ]);
    expect(new Set(rs.map((r) => r.body.id)).size).toBe(1);
    expect(rs.every((r) => r.status === 200 || r.status === 201)).toBe(true);
  });

  it('validates input and authentication', async () => {
    const a = await signup(t);
    const b = await signup(t);
    expect((await a.client.post('/v1/conversations/direct', { userId: a.id })).status).toBe(400);
    expect((await a.client.post('/v1/conversations/direct', {})).status).toBe(400);
    expect(
      (await a.client.post('/v1/conversations/direct', { userId: b.id, username: b.username }))
        .status,
    ).toBe(400);
    expect((await a.client.post('/v1/conversations/direct', { userId: 'nope' })).status).toBe(400);
    expect(
      (
        await a.client.post('/v1/conversations/direct', {
          userId: '00000000-0000-4000-8000-000000000000',
        })
      ).status,
    ).toBe(404);
    expect(
      (await a.client.post('/v1/conversations/direct', { username: 'nobody_here_x' })).status,
    ).toBe(404);
    expect((await new Client(t).post('/v1/conversations/direct', { userId: b.id })).status).toBe(
      401,
    );
    expect((await new Client(t).get('/v1/conversations')).status).toBe(401);
  });

  it('cannot be left, renamed or have members managed', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const c = await signup(t);
    const id = await dm(a, b);
    expect((await a.client.post(`/v1/conversations/${id}/leave`)).status).toBe(400);
    expect((await a.client.patch(`/v1/conversations/${id}`, { title: 'x' })).status).toBe(400);
    expect(
      (await a.client.post(`/v1/conversations/${id}/members`, { userIds: [c.id] })).status,
    ).toBe(400);
  });
});

describe('group conversations', () => {
  it('creates a group with roles, and hides it from non-members with 404', async () => {
    const owner = await signup(t);
    const m1 = await signup(t);
    const m2 = await signup(t);
    const outsider = await signup(t);
    const id = await group(owner, [m1, m2]);
    const view = (await owner.client.get(`/v1/conversations/${id}`)).body;
    expect(view).toMatchObject({
      kind: 'group',
      title: 'Trip crew',
      role: 'owner',
      canManage: true,
      memberCount: 3,
    });
    expect(view.members.map((m: any) => m.role).sort()).toEqual(['member', 'member', 'owner']);
    expect((await m1.client.get(`/v1/conversations/${id}`)).body).toMatchObject({
      role: 'member',
      canManage: false,
    });
    expect((await outsider.client.get(`/v1/conversations/${id}`)).status).toBe(404);
    expect((await outsider.client.get(`/v1/conversations/${id}/messages`)).status).toBe(404);
    expect(
      (await outsider.client.post(`/v1/conversations/${id}/messages`, { body: 'hi' })).status,
    ).toBe(404);
    expect((await outsider.client.post(`/v1/conversations/${id}/read`)).status).toBe(404);
  });

  it('validates group creation', async () => {
    const a = await signup(t);
    const b = await signup(t);
    expect(
      (await a.client.post('/v1/conversations/group', { title: '', memberIds: [b.id] })).status,
    ).toBe(400);
    expect(
      (await a.client.post('/v1/conversations/group', { title: 'x', memberIds: [] })).status,
    ).toBe(400);
    expect(
      (await a.client.post('/v1/conversations/group', { title: 'x', memberIds: [a.id] })).status,
    ).toBe(400);
    expect(
      (
        await a.client.post('/v1/conversations/group', {
          title: 'x',
          memberIds: ['00000000-0000-4000-8000-000000000000'],
        })
      ).status,
    ).toBe(400);
  });

  it('lets only admins add/remove/rename, protects the owner, and transfers ownership on leave', async () => {
    const owner = await signup(t);
    const admin = await signup(t);
    const member = await signup(t);
    const extra = await signup(t);
    const extra2 = await signup(t);
    const id = await group(owner, [admin, member]);
    expect(
      (
        await owner.client.put(`/v1/conversations/${id}/members/${admin.id}/role`, {
          role: 'admin',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await member.client.put(`/v1/conversations/${id}/members/${member.id}/role`, {
          role: 'admin',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await admin.client.put(`/v1/conversations/${id}/members/${member.id}/role`, {
          role: 'admin',
        })
      ).status,
    ).toBe(403);

    expect(
      (await member.client.post(`/v1/conversations/${id}/members`, { userIds: [extra.id] })).status,
    ).toBe(403);
    expect(
      (await member.client.patch(`/v1/conversations/${id}`, { title: 'Hijacked' })).status,
    ).toBe(403);
    const add = await admin.client.post(`/v1/conversations/${id}/members`, {
      userIds: [extra.id, extra.id, member.id],
    });
    expect(add.status).toBe(200);
    expect(add.body.added).toEqual([extra.id]); // dedupes and ignores existing members
    expect(
      (await admin.client.patch(`/v1/conversations/${id}`, { title: 'Renamed' })).body.title,
    ).toBe('Renamed');

    expect((await member.client.del(`/v1/conversations/${id}/members/${extra.id}`)).status).toBe(
      403,
    );
    expect((await admin.client.del(`/v1/conversations/${id}/members/${owner.id}`)).status).toBe(
      403,
    );
    expect((await admin.client.del(`/v1/conversations/${id}/members/${admin.id}`)).status).toBe(
      400,
    );
    expect((await admin.client.del(`/v1/conversations/${id}/members/${extra.id}`)).status).toBe(
      204,
    );
    expect((await admin.client.del(`/v1/conversations/${id}/members/${extra2.id}`)).status).toBe(
      404,
    );
    // removed members lose access immediately
    expect((await extra.client.get(`/v1/conversations/${id}`)).status).toBe(404);
    expect((await extra.client.get(`/v1/conversations/${id}/messages`)).status).toBe(404);

    // owner leaves: the admin inherits ownership
    expect((await owner.client.post(`/v1/conversations/${id}/leave`)).status).toBe(204);
    expect((await owner.client.get(`/v1/conversations/${id}`)).status).toBe(404);
    expect((await admin.client.get(`/v1/conversations/${id}`)).body.role).toBe('owner');
    // audit trail for access changes
    const audits = await sql(`SELECT action FROM audit_logs WHERE target_id = $1`, [id]);
    expect(audits.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        'conversation.member_added',
        'conversation.member_removed',
        'conversation.left',
      ]),
    );
  });

  it('a member who left cannot read or send anything new, but can be re-added without seeing old history', async () => {
    const owner = await signup(t);
    const m = await signup(t);
    const id = await group(owner, [m]);
    await say(owner, id, 'before leave');
    expect((await m.client.post(`/v1/conversations/${id}/leave`)).status).toBe(204);
    await say(owner, id, 'after leave');
    expect((await m.client.get(`/v1/conversations/${id}/messages`)).status).toBe(404);
    expect(
      (await m.client.post(`/v1/conversations/${id}/messages`, { body: 'sneaky' })).status,
    ).toBe(404);
    expect(
      (await m.client.get(`/v1/conversations`)).body.items.find((c: any) => c.id === id),
    ).toBeUndefined();
    expect((await m.client.post(`/v1/conversations/${id}/leave`)).status).toBe(404);
    // re-add: history before the re-join stays hidden
    await owner.client.post(`/v1/conversations/${id}/members`, { userIds: [m.id] });
    await say(owner, id, 'after rejoin');
    const list = (await m.client.get(`/v1/conversations/${id}/messages`)).body.items;
    expect(list.map((x: any) => x.body)).toEqual(['after rejoin']);
  });

  it('enforces the member cap', async () => {
    const owner = await signup(t);
    const [first] = [await signup(t)];
    const id = await group(owner, [first]);
    // fill the group directly to the cap, then the API refuses one more
    const filler = await sql<{ id: string }>(
      `INSERT INTO users (email, birth_date, age_band) SELECT 'fill' || g || '_' || $1::text || '@example.test', '1990-01-01', 'adult' FROM generate_series(1, 98) g RETURNING id`,
      [uniq('f')],
    );
    for (const r of filler.rows)
      await sql(`INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1,$2)`, [
        id,
        r.id,
      ]);
    const one = await signup(t);
    const res = await owner.client.post(`/v1/conversations/${id}/members`, { userIds: [one.id] });
    expect(res.status).toBe(409);
  });
});

describe('inbox', () => {
  it('lists conversations by recent activity with previews, unread, pinned and muted state, and paginates by keyset', async () => {
    const me = await signup(t);
    const p1 = await signup(t);
    const p2 = await signup(t);
    const p3 = await signup(t);
    const c1 = await dm(me, p1);
    const c2 = await dm(me, p2);
    const c3 = await dm(me, p3);
    await say(p1, c1, 'oldest');
    await say(p2, c2, 'middle one');
    await say(p3, c3, 'newest, hi');
    await say(p3, c3, 'newest, second');
    const inbox = (await me.client.get('/v1/conversations')).body;
    expect(inbox.items.map((c: any) => c.id)).toEqual([c3, c2, c1]);
    expect(inbox.items[0]).toMatchObject({
      unreadCount: 2,
      pinned: false,
      muted: false,
      peer: { id: p3.id },
      lastMessage: { preview: 'newest, second', senderId: p3.id },
    });
    expect(inbox.items[2].unreadCount).toBe(1);
    expect(inbox.nextCursor).toBeNull();

    const page1 = (await me.client.get('/v1/conversations', { limit: '2' })).body;
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = (
      await me.client.get('/v1/conversations', { limit: '2', cursor: page1.nextCursor })
    ).body;
    expect(page2.items.map((c: any) => c.id)).toEqual([c1]);
    expect(page2.nextCursor).toBeNull();
    expect((await me.client.get('/v1/conversations', { cursor: '!!!' })).status).toBe(400);

    // sending bumps a conversation to the top and my own message never counts as unread
    await say(me, c1, 'me again');
    const bumped = (await me.client.get('/v1/conversations')).body.items;
    expect(bumped[0]).toMatchObject({ id: c1, unreadCount: 0 }); // sending marks the conversation read
    expect(bumped[0].lastMessage.preview).toBe('me again');

    // pin + mute are per-member
    const pin = await me.client.patch(`/v1/conversations/${c2}/me`, {
      pinned: true,
      mutedUntil: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(pin.body).toMatchObject({ pinned: true });
    const item = (await me.client.get('/v1/conversations')).body.items.find(
      (c: any) => c.id === c2,
    );
    expect(item).toMatchObject({ pinned: true, muted: true });
    expect((await p2.client.get('/v1/conversations')).body.items[0]).toMatchObject({
      pinned: false,
      muted: false,
    });
    expect(
      (await me.client.get('/v1/conversations', { pinned: 'true' })).body.items.map(
        (c: any) => c.id,
      ),
    ).toEqual([c2]);
    expect((await me.client.get('/v1/conversations', { kind: 'group' })).body.items).toHaveLength(
      0,
    );
    expect(
      (await me.client.patch(`/v1/conversations/${c2}/me`, { mutedUntil: null })).body.mutedUntil,
    ).toBeNull();
    expect((await me.client.patch(`/v1/conversations/${c2}/me`, {})).status).toBe(400);
    expect((await p1.client.patch(`/v1/conversations/${c2}/me`, { pinned: true })).status).toBe(
      404,
    );
  });

  it('never leaks tombstoned text into previews', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const c = await dm(a, b);
    await say(a, c, 'first');
    const m2 = await say(a, c, 'secret second');
    await a.client.del(`/v1/messages/${m2.id}`);
    expect((await b.client.get('/v1/conversations')).body.items[0].lastMessage.preview).toBe(
      'first',
    );
  });
});

// ================================================================== messages
describe('sending messages', () => {
  it('sends text, supports replies and is idempotent on clientMessageId', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const c = await dm(a, b);
    const m1 = await say(a, c, '  hello there  ');
    expect(m1).toMatchObject({
      kind: 'text',
      body: 'hello there',
      senderId: a.id,
      deleted: false,
      sender: { username: a.username },
    });
    const reply = await say(b, c, 'hi!', { replyToId: m1.id });
    expect(reply.replyTo).toMatchObject({ id: m1.id, body: 'hello there', senderId: a.id });

    const cid = `client-${uniq('c')}`;
    const first = await a.client.post(`/v1/conversations/${c}/messages`, {
      body: 'once',
      clientMessageId: cid,
    });
    const second = await a.client.post(`/v1/conversations/${c}/messages`, {
      body: 'once (retry with different text)',
      clientMessageId: cid,
    });
    const third = await a.client.post(`/v1/conversations/${c}/messages`, {
      body: 'x',
      clientMessageId: cid,
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.body).toBe('once'); // the ORIGINAL message
    expect(third.body.id).toBe(first.body.id);
    expect(
      (await sql('SELECT count(*)::int AS n FROM messages WHERE client_message_id = $1', [cid]))
        .rows[0].n,
    ).toBe(1);
    // concurrent duplicates also collapse
    const cid2 = `client-${uniq('d')}`;
    const rs = await Promise.all(
      [1, 2, 3, 4].map(() =>
        a.client.post(`/v1/conversations/${c}/messages`, { body: 'race', clientMessageId: cid2 }),
      ),
    );
    expect(new Set(rs.map((r) => r.body.id)).size).toBe(1);
    expect(
      (await sql('SELECT count(*)::int AS n FROM messages WHERE client_message_id = $1', [cid2]))
        .rows[0].n,
    ).toBe(1);
    // the same clientMessageId from another sender is a different message
    const other = await b.client.post(`/v1/conversations/${c}/messages`, {
      body: 'mine',
      clientMessageId: cid,
    });
    expect(other.status).toBe(201);
    expect(other.body.id).not.toBe(first.body.id);
  });

  it('validates message input', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const c = await dm(a, b);
    const post = (body: unknown) => a.client.post(`/v1/conversations/${c}/messages`, body);
    expect((await post({})).status).toBe(400);
    expect((await post({ body: '   ' })).status).toBe(400);
    expect((await post({ body: 'x'.repeat(8001) })).status).toBe(400);
    expect((await post({ body: 'x'.repeat(8000) })).status).toBe(201);
    expect((await post({ body: 'x', kind: 'system' })).status).toBe(400);
    expect((await post({ body: 'x', kind: 'call' })).status).toBe(400);
    expect((await post({ kind: 'media' })).status).toBe(400);
    expect(
      (await post({ kind: 'text', body: 'x', attachmentIds: [await mkMedia(a)] })).status,
    ).toBe(400); // text + attachment mismatch
    expect((await post({ body: 'x', clientMessageId: 'short' })).status).toBe(400);
    expect(
      (await post({ body: 'x', replyToId: '00000000-0000-4000-8000-000000000000' })).status,
    ).toBe(400);
    expect(
      (await new Client(t).post(`/v1/conversations/${c}/messages`, { body: 'x' })).status,
    ).toBe(401);
    expect(
      (await a.client.post('/v1/conversations/not-a-uuid/messages', { body: 'x' })).status,
    ).toBe(400);
    // replies cannot cross conversations
    const other = await signup(t);
    const c2 = await dm(a, other);
    const foreign = await say(a, c2, 'elsewhere');
    expect((await post({ body: 'x', replyToId: foreign.id })).status).toBe(400);
  });

  it('attaches only media the sender owns, once, with matching kinds', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const c = await dm(a, b);
    const img = await mkMedia(a, 'image');
    const theirs = await mkMedia(b, 'image');
    const audio = await mkMedia(a, 'audio');
    const file = await mkMedia(a, 'file');
    const post = (body: unknown) => a.client.post(`/v1/conversations/${c}/messages`, body);
    expect((await post({ kind: 'media', attachmentIds: [theirs] })).status).toBe(400);
    expect(
      (await post({ kind: 'media', attachmentIds: ['00000000-0000-4000-8000-000000000000'] }))
        .status,
    ).toBe(400);
    expect((await post({ kind: 'media', attachmentIds: [audio] })).status).toBe(400);
    expect((await post({ kind: 'voice', attachmentIds: [img] })).status).toBe(400);
    const ok = await post({ kind: 'media', attachmentIds: [img], body: 'look' });
    expect(ok.status).toBe(201);
    expect(ok.body.attachments[0]).toMatchObject({ id: img, kind: 'image' });
    expect(ok.body.attachments[0].url).toContain('/m/');
    expect((await post({ kind: 'media', attachmentIds: [img] })).status).toBe(400); // already used
    expect((await post({ kind: 'voice', attachmentIds: [audio] })).status).toBe(201);
    expect((await post({ kind: 'file', attachmentIds: [file] })).status).toBe(201);
    expect(
      (await sql('SELECT count(*)::int AS n FROM message_attachments WHERE media_id = $1', [img]))
        .rows[0].n,
    ).toBe(1);
    // an idempotent retry of an attachment message still returns the original
    const m = await mkMedia(a, 'image');
    const cid = `client-${uniq('m')}`;
    const r1 = await post({ kind: 'media', attachmentIds: [m], clientMessageId: cid });
    const r2 = await post({ kind: 'media', attachmentIds: [m], clientMessageId: cid });
    expect([r1.status, r2.status]).toEqual([201, 200]);
    expect(r2.body.id).toBe(r1.body.id);
  });

  it('lists newest first with a stable keyset cursor', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const c = await dm(a, b);
    for (let i = 1; i <= 5; i++) await say(i % 2 ? a : b, c, `msg ${i}`);
    const all = (await a.client.get(`/v1/conversations/${c}/messages`)).body;
    expect(all.items.map((m: any) => m.body)).toEqual([
      'msg 5',
      'msg 4',
      'msg 3',
      'msg 2',
      'msg 1',
    ]);
    expect(all.nextCursor).toBeNull();
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 4; i++) {
      const page = (
        await b.client.get(`/v1/conversations/${c}/messages`, {
          limit: '2',
          ...(cursor ? { cursor } : {}),
        })
      ).body;
      seen.push(...page.items.map((m: any) => m.body));
      cursor = page.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(seen).toEqual(['msg 5', 'msg 4', 'msg 3', 'msg 2', 'msg 1']);
    // new messages arriving between pages do not shift the cursor
    const p1 = (await a.client.get(`/v1/conversations/${c}/messages`, { limit: '2' })).body;
    await say(a, c, 'msg 6');
    const p2 = (
      await a.client.get(`/v1/conversations/${c}/messages`, { limit: '2', cursor: p1.nextCursor })
    ).body;
    expect(p2.items.map((m: any) => m.body)).toEqual(['msg 3', 'msg 2']);
    expect((await a.client.get(`/v1/conversations/${c}/messages`, { limit: '0' })).status).toBe(
      400,
    );
  });
});

describe('editing and deleting', () => {
  it('lets only the sender edit; non-members get 404', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const out = await signup(t);
    const c = await dm(a, b);
    const m = await say(a, c, 'typo');
    const ok = await a.client.patch(`/v1/messages/${m.id}`, { body: 'fixed' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ body: 'fixed' });
    expect(ok.body.editedAt).toBeTruthy();
    expect((await b.client.patch(`/v1/messages/${m.id}`, { body: 'hijack' })).status).toBe(403);
    expect((await out.client.patch(`/v1/messages/${m.id}`, { body: 'hijack' })).status).toBe(404);
    expect((await a.client.patch(`/v1/messages/${m.id}`, { body: '  ' })).status).toBe(400);
    expect((await a.client.patch(`/v1/messages/${m.id}`, { body: 'x'.repeat(8001) })).status).toBe(
      400,
    );
    expect(
      (await a.client.patch('/v1/messages/00000000-0000-4000-8000-000000000000', { body: 'x' }))
        .status,
    ).toBe(404);
    expect((await b.client.get(`/v1/messages/${m.id}`)).body.body).toBe('fixed');
    expect((await out.client.get(`/v1/messages/${m.id}`)).status).toBe(404);
    const vote = await say(a, c, '', { poll: { question: 'q?', options: ['a', 'b'] } });
    expect((await a.client.patch(`/v1/messages/${vote.id}`, { body: 'nope' })).status).toBe(400); // polls are not editable
  });

  it('deletes for everyone as a tombstone: body cleared for all readers and in the database', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const out = await signup(t);
    const c = await dm(a, b);
    const img = await mkMedia(a);
    const m = await say(a, c, 'regrettable', { kind: 'media', attachmentIds: [img] });
    expect((await b.client.put(`/v1/messages/${m.id}/reaction`, { kind: 'love' })).status).toBe(
      200,
    );
    expect((await b.client.del(`/v1/messages/${m.id}`)).status).toBe(403);
    expect((await out.client.del(`/v1/messages/${m.id}`)).status).toBe(404);
    expect((await a.client.del(`/v1/messages/${m.id}`)).status).toBe(204);
    expect((await a.client.del(`/v1/messages/${m.id}`)).status).toBe(204); // idempotent
    for (const u of [a, b]) {
      const list = (await u.client.get(`/v1/conversations/${c}/messages`)).body.items;
      expect(list[0]).toMatchObject({
        id: m.id,
        deleted: true,
        body: '',
        attachments: [],
        metadata: {},
        reactions: { counts: {} },
      });
    }
    const row = (await sql('SELECT body, deleted_at FROM messages WHERE id = $1', [m.id])).rows[0];
    expect(row.body).toBe('');
    expect(row.deleted_at).not.toBeNull();
    expect(
      (
        await sql('SELECT count(*)::int AS n FROM message_attachments WHERE message_id = $1', [
          m.id,
        ])
      ).rows[0].n,
    ).toBe(0);
    expect(
      (await sql(`SELECT count(*)::int AS n FROM reactions WHERE target_id = $1`, [m.id])).rows[0]
        .n,
    ).toBe(0);
    expect((await a.client.patch(`/v1/messages/${m.id}`, { body: 'undelete' })).status).toBe(404);
    expect((await b.client.put(`/v1/messages/${m.id}/reaction`, { kind: 'like' })).status).toBe(
      404,
    );
    // replies to a deleted message do not leak its text
    const r = await say(b, c, 'about that', {});
    expect(r.replyTo).toBeNull();
  });
});

describe('read receipts and unread counts', () => {
  it('tracks unread per member, marks read (optionally up to a message) and reports totals', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const c = await dm(a, b);
    const m1 = await say(a, c, 'one');
    await say(a, c, 'two');
    await say(a, c, 'three');
    expect((await b.client.get(`/v1/conversations/${c}`)).body.unreadCount).toBe(3);
    expect((await a.client.get(`/v1/conversations/${c}`)).body.unreadCount).toBe(0);
    expect((await b.client.get('/v1/conversations/unread-count')).body).toEqual({
      conversations: 1,
      messages: 3,
    });

    const upTo = await b.client.post(`/v1/conversations/${c}/read`, { messageId: m1.id });
    expect(upTo.status).toBe(200);
    expect((await b.client.get(`/v1/conversations/${c}`)).body.unreadCount).toBe(2);
    // read marks never move backwards
    await b.client.post(`/v1/conversations/${c}/read`, { messageId: m1.id });
    expect((await b.client.get(`/v1/conversations/${c}`)).body.unreadCount).toBe(2);
    expect(
      (
        await b.client.post(`/v1/conversations/${c}/read`, {
          messageId: '00000000-0000-4000-8000-000000000000',
        })
      ).status,
    ).toBe(404);

    expect((await b.client.post(`/v1/conversations/${c}/read`)).status).toBe(200);
    expect((await b.client.get(`/v1/conversations/${c}`)).body.unreadCount).toBe(0);
    expect((await b.client.get('/v1/conversations')).body.items[0].unreadCount).toBe(0);
    expect((await b.client.get('/v1/conversations/unread-count')).body).toEqual({
      conversations: 0,
      messages: 0,
    });
    // read receipt is visible to the peer via member state
    const members = (await a.client.get(`/v1/conversations/${c}`)).body.members;
    expect(members.find((m: any) => m.userId === b.id).lastReadAt).toBeTruthy();
    // muted conversations do not count towards the badge
    await say(a, c, 'four');
    await b.client.patch(`/v1/conversations/${c}/me`, {
      mutedUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    expect((await b.client.get('/v1/conversations/unread-count')).body.messages).toBe(0);
    expect((await b.client.get(`/v1/conversations/${c}`)).body.unreadCount).toBe(1);
  });

  it('does not count deleted or hidden messages as unread', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const c = await dm(a, b);
    const m = await say(a, c, 'oops');
    await say(a, c, 'ok');
    await a.client.del(`/v1/messages/${m.id}`);
    expect((await b.client.get(`/v1/conversations/${c}`)).body.unreadCount).toBe(1);
  });
});

describe('reactions and polls', () => {
  it('reacts to messages with counts, my reaction and access control', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const out = await signup(t);
    const c = await dm(a, b);
    const m = await say(a, c, 'react to me');
    expect(
      (await b.client.put(`/v1/messages/${m.id}/reaction`, { kind: 'love' })).body.reactions,
    ).toEqual({ counts: { love: 1 }, mine: 'love' });
    const r = await a.client.put(`/v1/messages/${m.id}/reaction`, { kind: 'laugh' });
    expect(r.body.reactions.counts).toEqual({ love: 1, laugh: 1 });
    expect(
      (await b.client.put(`/v1/messages/${m.id}/reaction`, { kind: 'wow' })).body.reactions.counts,
    ).toEqual({ wow: 1, laugh: 1 });
    expect((await b.client.put(`/v1/messages/${m.id}/reaction`, { kind: 'bogus' })).status).toBe(
      400,
    );
    expect((await out.client.put(`/v1/messages/${m.id}/reaction`, { kind: 'like' })).status).toBe(
      404,
    );
    expect(
      (
        await sql(
          `SELECT count(*)::int AS n FROM reactions WHERE target_type = 'message' AND target_id = $1`,
          [m.id],
        )
      ).rows[0].n,
    ).toBe(2);
    expect((await b.client.del(`/v1/messages/${m.id}/reaction`)).body.reactions).toEqual({
      counts: { laugh: 1 },
      mine: null,
    });
    const listed = (await a.client.get(`/v1/conversations/${c}/messages`)).body.items[0];
    expect(listed.reactions).toEqual({ counts: { laugh: 1 }, mine: 'laugh' });
  });

  it('runs in-message polls: single/multiple choice, changing and clearing votes', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const c3 = await signup(t);
    const out = await signup(t);
    const g = await group(a, [b, c3]);
    const poll = await say(a, g, '', {
      poll: { question: 'Where to?', options: ['Lisbon', 'Osaka', 'Nairobi'] },
    });
    expect(poll).toMatchObject({
      kind: 'poll',
      poll: { question: 'Where to?', multiple: false, totalVotes: 0 },
    });
    expect(poll.poll.options.map((o: any) => o.label)).toEqual(['Lisbon', 'Osaka', 'Nairobi']);
    const [o1, o2, o3] = poll.poll.options.map((o: any) => o.id);
    const vote = (u: TestUser, ids: string[]) =>
      u.client.put(`/v1/messages/${poll.id}/poll/votes`, { optionIds: ids });
    expect((await vote(b, [o1])).body.poll).toMatchObject({ myVotes: [o1], totalVotes: 1 });
    expect((await vote(c3, [o1])).body.poll.options[0].votes).toBe(2);
    expect((await vote(b, [o2])).body.poll.options.map((o: any) => o.votes)).toEqual([1, 1, 0]); // changed vote
    expect((await vote(b, [o1, o2])).status).toBe(400); // single choice
    expect((await vote(b, ['o99'])).status).toBe(400);
    expect((await vote(out, [o1])).status).toBe(404);
    expect((await vote(b, [])).body.poll).toMatchObject({ myVotes: [], totalVotes: 1 });
    const listed = (await a.client.get(`/v1/conversations/${g}/messages`)).body.items[0];
    expect(listed.poll.options.map((o: any) => o.votes)).toEqual([1, 0, 0]);

    const multi = await say(a, g, '', {
      poll: { question: 'Pick some', options: ['x', 'y', 'z'], multiple: true },
    });
    const res = await b.client.put(`/v1/messages/${multi.id}/poll/votes`, { optionIds: [o1, o3] });
    expect(res.body.poll.myVotes.sort()).toEqual([o1, o3]);
    // invalid polls
    expect(
      (
        await a.client.post(`/v1/conversations/${g}/messages`, {
          poll: { question: 'q', options: ['only'] },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await a.client.post(`/v1/conversations/${g}/messages`, {
          poll: { question: 'q', options: ['a', 'A'] },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await a.client.put(`/v1/messages/${(await say(a, g, 'not a poll')).id}/poll/votes`, {
          optionIds: [o1],
        })
      ).status,
    ).toBe(404);
  });
});

describe('plan proposals', () => {
  it('creates a plan in a conversation with RSVPs and tasks, visible to members only', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const c3 = await signup(t);
    const out = await signup(t);
    const g = await group(a, [b, c3]);
    const res = await a.client.post(`/v1/conversations/${g}/plans`, {
      title: 'Weekend in Porto',
      destination: 'Porto',
      startsOn: '2027-05-01',
      endsOn: '2027-05-03',
      budgetCents: 30000,
      currency: 'eur',
      tasks: [{ title: 'Book flights', assigneeId: b.id }, { title: 'Reserve dinner' }],
    });
    expect(res.status).toBe(201);
    const plan = res.body.plan;
    expect(plan).toMatchObject({
      title: 'Weekend in Porto',
      status: 'proposed',
      currency: 'EUR',
      createdBy: a.id,
      conversationId: g,
    });
    expect(plan.participants).toHaveLength(3);
    expect(plan.participants.find((p: any) => p.userId === a.id).rsvp).toBe('going');
    expect(plan.tasks.map((x: any) => x.title)).toEqual(['Book flights', 'Reserve dinner']);
    expect(res.body.message).toMatchObject({
      kind: 'plan',
      plan: { id: plan.id, title: 'Weekend in Porto', rsvp: { going: 1, invited: 2 } },
    });

    expect((await b.client.get(`/v1/plans/${plan.id}`)).status).toBe(200);
    expect((await out.client.get(`/v1/plans/${plan.id}`)).status).toBe(404);
    expect((await out.client.put(`/v1/plans/${plan.id}/rsvp`, { rsvp: 'going' })).status).toBe(404);
    expect((await out.client.post(`/v1/plans/${plan.id}/tasks`, { title: 'x' })).status).toBe(404);

    const rsvp = await b.client.put(`/v1/plans/${plan.id}/rsvp`, { rsvp: 'going' });
    expect(rsvp.body.participants.find((p: any) => p.userId === b.id).rsvp).toBe('going');
    expect((await b.client.put(`/v1/plans/${plan.id}/rsvp`, { rsvp: 'invited' })).status).toBe(400);
    const listed = (await c3.client.get(`/v1/conversations/${g}/messages`)).body.items[0];
    expect(listed.plan).toMatchObject({ rsvp: { going: 2, invited: 1 }, myRsvp: 'invited' });

    const add = await c3.client.post(`/v1/plans/${plan.id}/tasks`, {
      title: 'Rent a car',
      assigneeId: c3.id,
    });
    expect(add.status).toBe(201);
    expect(
      (await c3.client.post(`/v1/plans/${plan.id}/tasks`, { title: 'x', assigneeId: out.id }))
        .status,
    ).toBe(400);
    const taskId = add.body.id;
    const done = await b.client.patch(`/v1/plans/${plan.id}/tasks/${taskId}`, { done: true });
    expect(done.body.tasks.find((x: any) => x.id === taskId).done).toBe(true);
    expect(
      (
        await b.client.patch(`/v1/plans/${plan.id}/tasks/00000000-0000-4000-8000-000000000000`, {
          done: true,
        })
      ).status,
    ).toBe(404);
    expect(
      (await out.client.patch(`/v1/plans/${plan.id}/tasks/${taskId}`, { done: false })).status,
    ).toBe(404);

    expect((await b.client.patch(`/v1/plans/${plan.id}`, { status: 'confirmed' })).status).toBe(
      403,
    );
    expect(
      (await a.client.patch(`/v1/plans/${plan.id}`, { status: 'confirmed' })).body.status,
    ).toBe('confirmed');
    expect(
      (await a.client.patch(`/v1/plans/${plan.id}`, { status: 'cancelled' })).body.status,
    ).toBe('cancelled');
    expect((await b.client.put(`/v1/plans/${plan.id}/rsvp`, { rsvp: 'maybe' })).status).toBe(409); // closed
    expect((await a.client.post(`/v1/plans/${plan.id}/tasks`, { title: 'late' })).status).toBe(409);
  });

  it('validates plans and refuses non-members', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const out = await signup(t);
    const c = await dm(a, b);
    expect((await a.client.post(`/v1/conversations/${c}/plans`, { title: '' })).status).toBe(400);
    expect(
      (
        await a.client.post(`/v1/conversations/${c}/plans`, {
          title: 'x',
          startsOn: '2027-05-03',
          endsOn: '2027-05-01',
        })
      ).status,
    ).toBe(400);
    expect(
      (await a.client.post(`/v1/conversations/${c}/plans`, { title: 'x', budgetCents: 100 }))
        .status,
    ).toBe(400);
    expect(
      (
        await a.client.post(`/v1/conversations/${c}/plans`, {
          title: 'x',
          tasks: [{ title: 't', assigneeId: out.id }],
        })
      ).status,
    ).toBe(400);
    expect((await out.client.post(`/v1/conversations/${c}/plans`, { title: 'x' })).status).toBe(
      404,
    );
    expect((await a.client.post(`/v1/conversations/${c}/plans`, { title: 'Coffee?' })).status).toBe(
      201,
    );
  });
});

// ================================================================== access control
describe('blocks', () => {
  it('denies everything in a direct conversation once either side blocks, without revealing the block', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const c = await dm(a, b);
    const m = await say(a, c, 'before block');
    expect((await b.client.put(`/v1/users/${a.username}/block`)).status).toBeLessThan(300);
    for (const u of [a, b]) {
      expect((await u.client.get(`/v1/conversations/${c}`)).status).toBe(404);
      expect((await u.client.get(`/v1/conversations/${c}/messages`)).status).toBe(404);
      expect(
        (await u.client.post(`/v1/conversations/${c}/messages`, { body: 'hello?' })).status,
      ).toBe(404);
      expect((await u.client.get(`/v1/messages/${m.id}`)).status).toBe(404);
      expect((await u.client.put(`/v1/messages/${m.id}/reaction`, { kind: 'like' })).status).toBe(
        404,
      );
      expect((await u.client.post(`/v1/conversations/${c}/calls`, { kind: 'audio' })).status).toBe(
        404,
      );
      expect(
        (await u.client.get('/v1/conversations')).body.items.find((x: any) => x.id === c),
      ).toBeUndefined();
    }
    expect((await a.client.post('/v1/conversations/direct', { userId: b.id })).status).toBe(404);
    expect((await b.client.post('/v1/conversations/direct', { username: a.username })).status).toBe(
      404,
    );
    expect(
      (await a.client.post('/v1/conversations/group', { title: 'g', memberIds: [b.id] })).status,
    ).toBe(400);
    // service-level entry point obeys the same rule
    await expect(
      sendMessage(t.ctx, { conversationId: c, senderId: a.id, body: 'via service' }),
    ).rejects.toMatchObject({ status: 404 });
    // unblocking restores access to the history
    await b.client.del(`/v1/users/${a.username}/block`);
    expect((await a.client.get(`/v1/conversations/${c}/messages`)).body.items).toHaveLength(1);
    expect((await a.client.post(`/v1/conversations/${c}/messages`, { body: 'back' })).status).toBe(
      201,
    );
  });
});

describe('who can message me', () => {
  it('honours everyone / followers / friends / nobody on create and on every send', async () => {
    const target = await signup(t);
    const stranger = await signup(t);
    const follower = await signup(t);
    const friend = await signup(t);
    await follower.client.put(`/v1/users/${target.username}/follow`);
    await befriend(friend, target);

    await setWho(target, 'nobody');
    for (const u of [stranger, follower, friend]) {
      const r = await u.client.post('/v1/conversations/direct', { userId: target.id });
      expect(r.status).toBe(403);
      expect(r.body.error.details).toEqual({ reason: 'recipient_preference' });
    }
    await setWho(target, 'friends');
    expect(
      (await stranger.client.post('/v1/conversations/direct', { userId: target.id })).status,
    ).toBe(403);
    expect(
      (await follower.client.post('/v1/conversations/direct', { userId: target.id })).status,
    ).toBe(403);
    expect(
      (await friend.client.post('/v1/conversations/direct', { userId: target.id })).status,
    ).toBe(201);
    await setWho(target, 'followers');
    expect(
      (await stranger.client.post('/v1/conversations/direct', { userId: target.id })).status,
    ).toBe(403);
    expect(
      (await follower.client.post('/v1/conversations/direct', { userId: target.id })).status,
    ).toBe(201);
    await setWho(target, 'everyone');
    expect(
      (await stranger.client.post('/v1/conversations/direct', { userId: target.id })).status,
    ).toBe(201);

    // the preference is re-checked on every send, not just at creation
    const cid = await dm(stranger, target);
    await say(stranger, cid, 'allowed now');
    await setWho(target, 'nobody');
    expect(
      (await stranger.client.post(`/v1/conversations/${cid}/messages`, { body: 'not any more' }))
        .status,
    ).toBe(403);
    expect(
      (await stranger.client.post(`/v1/conversations/${cid}/calls`, { kind: 'audio' })).status,
    ).toBe(403);
    // ...but an existing conversation stays readable, and the target can still write out
    expect((await stranger.client.get(`/v1/conversations/${cid}/messages`)).status).toBe(200);
    expect(
      (await target.client.post(`/v1/conversations/${cid}/messages`, { body: 'I can still reply' }))
        .status,
    ).toBe(201);
    await setWho(target, 'everyone');
    // groups respect it too
    await setWho(target, 'nobody');
    expect(
      (
        await stranger.client.post('/v1/conversations/group', {
          title: 'g',
          memberIds: [target.id],
        })
      ).status,
    ).toBe(403);
    await setWho(target, 'everyone');
  });

  it('rejects unavailable (deactivated) recipients', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const c = await dm(a, b);
    await sql(`UPDATE users SET status = 'deactivated' WHERE id = $1`, [b.id]);
    expect(
      (await a.client.post(`/v1/conversations/${c}/messages`, { body: 'anyone there?' })).status,
    ).toBe(403);
    expect((await a.client.post('/v1/conversations/direct', { userId: b.id })).status).toBe(404);
  });
});

describe('teen accounts', () => {
  it('can only exchange direct messages with accepted friends, in both directions', async () => {
    const kid = await teen();
    const adult = await signup(t);
    const otherKid = await teen();
    expect(
      (await adult.client.post('/v1/conversations/direct', { userId: kid.id })).body.error.details,
    ).toEqual({ reason: 'teen_friends_only' });
    expect((await kid.client.post('/v1/conversations/direct', { userId: adult.id })).status).toBe(
      403,
    );
    expect(
      (await kid.client.post('/v1/conversations/direct', { userId: otherKid.id })).status,
    ).toBe(403);
    await kid.client.put(`/v1/users/${adult.username}/follow`);
    expect((await kid.client.post('/v1/conversations/direct', { userId: adult.id })).status).toBe(
      403,
    ); // following is not friendship

    await kid.client.post('/v1/friends/requests', { username: adult.username }); // pending only
    expect((await adult.client.post('/v1/conversations/direct', { userId: kid.id })).status).toBe(
      403,
    );
    await adult.client.post(`/v1/friends/requests/${kid.id}/accept`);
    const c = await dm(adult, kid);
    expect(
      (await kid.client.post(`/v1/conversations/${c}/messages`, { body: 'hi from the kid' }))
        .status,
    ).toBe(201);
    expect(
      (await adult.client.post(`/v1/conversations/${c}/messages`, { body: 'hi back' })).status,
    ).toBe(201);
    // unfriending shuts the conversation for sending immediately
    await adult.client.del(`/v1/friends/${kid.id}`);
    expect(
      (await adult.client.post(`/v1/conversations/${c}/messages`, { body: 'still there?' })).status,
    ).toBe(403);
    expect(
      (await kid.client.post(`/v1/conversations/${c}/messages`, { body: 'still there?' })).status,
    ).toBe(403);
  });

  it('only joins groups made of their accepted friends', async () => {
    const kid = await teen();
    const friend = await signup(t);
    const stranger = await signup(t);
    await befriend(kid, friend);
    await befriend(stranger, friend);
    // adult creating a group with a teen and a non-friend of the teen
    const r = await friend.client.post('/v1/conversations/group', {
      title: 'mix',
      memberIds: [kid.id, stranger.id],
    });
    expect(r.status).toBe(403);
    expect(r.body.error.details).toEqual({ reason: 'teen_friends_only' });
    const g = await group(friend, [kid]);
    // adding the teen's non-friend to an existing group is refused too
    expect(
      (await friend.client.post(`/v1/conversations/${g}/members`, { userIds: [stranger.id] }))
        .status,
    ).toBe(403);
    // a teen cannot create a group with a non-friend
    expect(
      (await kid.client.post('/v1/conversations/group', { title: 'k', memberIds: [stranger.id] }))
        .status,
    ).toBe(403);
    expect(
      (await kid.client.post('/v1/conversations/group', { title: 'k', memberIds: [friend.id] }))
        .status,
    ).toBe(201);
  });
});

describe('moderation and restrictions', () => {
  it('holds risky messages back from recipients and realtime while the sender sees their status', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const c = await dm(a, b);
    const sock = await connect(b);
    const risky = await a.client.post(`/v1/conversations/${c}/messages`, {
      body: 'I will kill you',
    });
    expect(risky.status).toBe(201);
    expect(risky.body.moderationStatus).not.toBe('approved');
    expect((await b.client.get(`/v1/conversations/${c}/messages`)).body.items).toHaveLength(0);
    expect((await b.client.get(`/v1/messages/${risky.body.id}`)).status).toBe(404);
    expect((await a.client.get(`/v1/conversations/${c}/messages`)).body.items[0].id).toBe(
      risky.body.id,
    );
    expect((await b.client.get(`/v1/conversations/${c}`)).body.unreadCount).toBe(0);
    expect(
      (
        await sql(
          `SELECT count(*)::int AS n FROM moderation_cases WHERE target_type = 'message' AND target_id = $1`,
          [risky.body.id],
        )
      ).rows[0].n,
    ).toBe(1);
    await sock.none((f) => f.type === 'message.new');
    // and a normal message still flows
    await say(a, c, 'sorry, that was a joke');
    await sock.expect(
      (f) => f.type === 'message.new' && f.message.body === 'sorry, that was a joke',
    );
  });

  it('delivers messages from restricted users but suppresses the restrictor’s notification', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const other = await signup(t);
    await sql('INSERT INTO user_restrictions (restrictor_id, restricted_id) VALUES ($1,$2)', [
      b.id,
      a.id,
    ]);
    const c = await dm(a, b);
    await say(a, c, 'restricted hello');
    expect((await b.client.get(`/v1/conversations/${c}/messages`)).body.items).toHaveLength(1);
    const notes = (k: string, u: TestUser) =>
      sql(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND kind = $2`, [
        u.id,
        k,
      ]);
    expect((await notes('message', b)).rows[0].n).toBe(0);
    // control: an unrestricted sender does notify; a muted conversation does not
    const c2 = await dm(other, b);
    await say(other, c2, 'normal hello');
    expect((await notes('message', b)).rows[0].n).toBe(1);
    await b.client.patch(`/v1/conversations/${c2}/me`, {
      mutedUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    await say(other, c2, 'quiet hello');
    expect((await notes('message', b)).rows[0].n).toBe(1);
  });
});

describe('community channels', () => {
  it('derives access from ACTIVE community membership and the post permission', async () => {
    const owner = await signup(t);
    const member = await signup(t);
    const reader = await signup(t);
    const banned = await signup(t);
    const left = await signup(t);
    const pending = await signup(t);
    const outsider = await signup(t);
    const { communityId, channelId } = await createCommunity(owner);
    await joinCommunity(communityId, member);
    await joinCommunity(communityId, reader, 'active', 'reader');
    await joinCommunity(communityId, banned, 'banned');
    await joinCommunity(communityId, left, 'left');
    await joinCommunity(communityId, pending, 'pending');

    expect(
      (await owner.client.post(`/v1/conversations/${channelId}/messages`, { body: 'welcome' }))
        .status,
    ).toBe(201);
    expect(
      (await member.client.post(`/v1/conversations/${channelId}/messages`, { body: 'hello all' }))
        .status,
    ).toBe(201);
    const view = (await member.client.get(`/v1/conversations/${channelId}`)).body;
    expect(view).toMatchObject({
      kind: 'community_channel',
      channelName: 'general',
      canSend: true,
      communityId,
    });
    expect(
      (await member.client.get(`/v1/conversations/${channelId}/messages`)).body.items.map(
        (m: any) => m.body,
      ),
    ).toEqual(['hello all', 'welcome']);

    // read-only role: can read and react, cannot send or call
    expect((await reader.client.get(`/v1/conversations/${channelId}`)).body.canSend).toBe(false);
    expect((await reader.client.get(`/v1/conversations/${channelId}/messages`)).status).toBe(200);
    const send = await reader.client.post(`/v1/conversations/${channelId}/messages`, {
      body: 'let me talk',
    });
    expect(send.status).toBe(403);
    expect(
      (await reader.client.post(`/v1/conversations/${channelId}/calls`, { kind: 'audio' })).status,
    ).toBe(403);
    const first = (await reader.client.get(`/v1/conversations/${channelId}/messages`)).body
      .items[0];
    expect(
      (await reader.client.put(`/v1/messages/${first.id}/reaction`, { kind: 'like' })).status,
    ).toBe(200);
    expect((await reader.client.post(`/v1/conversations/${channelId}/read`)).status).toBe(200);
    expect((await reader.client.get(`/v1/conversations/${channelId}`)).body.unreadCount).toBe(0);

    // banned / left / pending / non-members get 404 everywhere
    for (const u of [banned, left, pending, outsider]) {
      expect((await u.client.get(`/v1/conversations/${channelId}`)).status).toBe(404);
      expect((await u.client.get(`/v1/conversations/${channelId}/messages`)).status).toBe(404);
      expect(
        (await u.client.post(`/v1/conversations/${channelId}/messages`, { body: 'let me in' }))
          .status,
      ).toBe(404);
      expect((await u.client.post(`/v1/conversations/${channelId}/read`)).status).toBe(404);
      expect((await u.client.get(`/v1/messages/${first.id}`)).status).toBe(404);
    }
    // membership changes apply immediately
    await joinCommunity(communityId, member, 'banned');
    expect((await member.client.get(`/v1/conversations/${channelId}/messages`)).status).toBe(404);
    expect(
      (await member.client.post(`/v1/conversations/${channelId}/messages`, { body: 'still?' }))
        .status,
    ).toBe(404);
    // channels never appear in the inbox and cannot be left, renamed or managed through messaging
    expect(
      (await owner.client.get('/v1/conversations')).body.items.find((c: any) => c.id === channelId),
    ).toBeUndefined();
    expect((await owner.client.post(`/v1/conversations/${channelId}/leave`)).status).toBe(400);
    expect(
      (await owner.client.patch(`/v1/conversations/${channelId}`, { title: 'x' })).status,
    ).toBe(400);
  });
});

// ================================================================== service export + deletion hook
describe('reusable service and account deletion', () => {
  it('exports sendMessage with the same rules as the HTTP route', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const out = await signup(t);
    const c = await dm(a, b);
    const cid = `svc-${uniq('s')}`;
    const m = await sendMessage(t.ctx, {
      conversationId: c,
      senderId: a.id,
      body: 'from another module',
      clientMessageId: cid,
      metadata: { source: 'commerce' },
    });
    expect(m).toMatchObject({
      body: 'from another module',
      senderId: a.id,
      metadata: { source: 'commerce' },
    });
    expect(
      (
        await sendMessage(t.ctx, {
          conversationId: c,
          senderId: a.id,
          body: 'dup',
          clientMessageId: cid,
        })
      ).id,
    ).toBe(m.id);
    await expect(
      sendMessage(t.ctx, { conversationId: c, senderId: out.id, body: 'intruder' }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      sendMessage(t.ctx, { conversationId: c, senderId: a.id, body: '' }),
    ).rejects.toMatchObject({ status: 400 });
    expect((await b.client.get(`/v1/conversations/${c}/messages`)).body.items[0].body).toBe(
      'from another module',
    );
    // clients cannot inject server-side metadata
    const viaHttp = await a.client.post(`/v1/conversations/${c}/messages`, {
      body: 'x',
      metadata: { source: 'evil' },
    });
    expect(viaHttp.body.metadata).toEqual({});
  });

  it('removes DM content and anonymises group messages when an account is deleted', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const c3 = await signup(t);
    const c = await dm(a, b);
    const g = await group(a, [b, c3]);
    const dmMsg = await say(a, c, 'private words');
    const grpMsg = await say(a, g, 'group words');
    await say(b, g, 'someone else');
    await b.client.put(`/v1/messages/${dmMsg.id}/reaction`, { kind: 'like' });
    await a.client.put(`/v1/messages/${(await say(b, c, 'from b')).id}/reaction`, { kind: 'like' });
    await withTransaction(t.ctx.db, async (tx) => {
      for (const h of getDeletionHooks()) await h(t.ctx, tx, a.id);
    });

    const dmRow = (
      await sql('SELECT body, deleted_at, sender_id FROM messages WHERE id = $1', [dmMsg.id])
    ).rows[0];
    expect(dmRow.body).toBe('');
    expect(dmRow.deleted_at).not.toBeNull();
    const grpRow = (await sql('SELECT body, sender_id FROM messages WHERE id = $1', [grpMsg.id]))
      .rows[0];
    expect(grpRow).toMatchObject({ body: 'group words', sender_id: null });
    expect(
      (
        await sql(
          `SELECT count(*)::int AS n FROM reactions WHERE user_id = $1 AND target_type = 'message'`,
          [a.id],
        )
      ).rows[0].n,
    ).toBe(0);
    // b sees the tombstone and an anonymous group message; a is out of the group and ownership moved on
    expect(
      (await b.client.get(`/v1/conversations/${c}/messages`)).body.items.find(
        (m: any) => m.id === dmMsg.id,
      ),
    ).toMatchObject({ deleted: true, body: '' });
    const bg = (await b.client.get(`/v1/conversations/${g}/messages`)).body.items.find(
      (m: any) => m.id === grpMsg.id,
    );
    expect(bg).toMatchObject({ body: 'group words', senderId: null, sender: null });
    const owner = (await b.client.get(`/v1/conversations/${g}`)).body.members.find(
      (m: any) => m.role === 'owner',
    );
    expect([b.id, c3.id]).toContain(owner.userId);
    expect(
      (
        await sql(
          `SELECT left_at FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`,
          [g, a.id],
        )
      ).rows[0].left_at,
    ).not.toBeNull();
  });
});

// ================================================================== calls
describe('calls', () => {
  it('runs the call lifecycle: start, join, leave, end, with access control', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const out = await signup(t);
    const c = await dm(a, b);
    const start = await a.client.post(`/v1/conversations/${c}/calls`, { kind: 'video' });
    expect(start.status).toBe(201);
    const call = start.body;
    expect(call).toMatchObject({
      kind: 'video',
      status: 'ringing',
      initiatorId: a.id,
      conversationId: c,
      signaling: { media: 'webrtc-p2p-mesh' },
    });
    expect(call.participants).toEqual([expect.objectContaining({ userId: a.id, active: true })]);
    expect((await a.client.post(`/v1/conversations/${c}/calls`, { kind: 'audio' })).status).toBe(
      409,
    );
    expect((await b.client.post(`/v1/conversations/${c}/calls`, { kind: 'audio' })).status).toBe(
      409,
    );
    expect((await a.client.post(`/v1/conversations/${c}/calls`, { kind: 'hologram' })).status).toBe(
      400,
    );
    expect((await out.client.post(`/v1/conversations/${c}/calls`, { kind: 'audio' })).status).toBe(
      404,
    );
    for (const path of ['', '/join', '/leave', '/end']) {
      const r = path
        ? await out.client.post(`/v1/calls/${call.id}${path}`)
        : await out.client.get(`/v1/calls/${call.id}`);
      expect(r.status).toBe(404);
    }
    const active = (await b.client.get(`/v1/conversations/${c}/calls`, { active: 'true' })).body
      .items;
    expect(active.map((x: any) => x.id)).toEqual([call.id]);
    // a call announcement is part of the conversation
    expect((await b.client.get(`/v1/conversations/${c}/messages`)).body.items[0]).toMatchObject({
      kind: 'call',
      metadata: { callId: call.id, callKind: 'video' },
    });

    const join = await b.client.post(`/v1/calls/${call.id}/join`);
    expect(join.status).toBe(200);
    expect(join.body.status).toBe('active');
    expect(join.body.startedAt).toBeTruthy();
    expect(join.body.participants.filter((p: any) => p.active)).toHaveLength(2);
    expect((await b.client.post(`/v1/calls/${call.id}/join`)).status).toBe(200); // idempotent
    expect((await b.client.post(`/v1/calls/${call.id}/leave`)).body.status).toBe('active'); // a is still in
    expect((await b.client.post(`/v1/calls/${call.id}/end`)).status).toBe(403);
    expect((await a.client.post(`/v1/calls/${call.id}/leave`)).body.status).toBe('ended'); // last one out closes it
    expect((await b.client.post(`/v1/calls/${call.id}/join`)).status).toBe(409);
    expect(
      (await b.client.get(`/v1/conversations/${c}/calls`, { active: 'true' })).body.items,
    ).toHaveLength(0);

    // a new call can start; the initiator can end it for everyone
    const again = (await b.client.post(`/v1/conversations/${c}/calls`, { kind: 'audio' })).body;
    await a.client.post(`/v1/calls/${again.id}/join`);
    expect((await b.client.post(`/v1/calls/${again.id}/end`)).body).toMatchObject({
      status: 'ended',
    });
    expect((await b.client.post(`/v1/calls/${again.id}/end`)).status).toBe(200); // ending twice is harmless
    expect(
      (await a.client.get(`/v1/calls/${again.id}`)).body.participants.every((p: any) => !p.active),
    ).toBe(true);
  });

  it('declines direct calls, marks unanswered ones missed, and lets group admins end group calls', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const c3 = await signup(t);
    const c = await dm(a, b);
    const call = (await a.client.post(`/v1/conversations/${c}/calls`, { kind: 'audio' })).body;
    expect((await a.client.post(`/v1/calls/${call.id}/decline`)).status).toBe(400);
    expect((await b.client.post(`/v1/calls/${call.id}/decline`)).body.status).toBe('declined');
    // unanswered: ring timeout applied lazily
    const call2 = (await a.client.post(`/v1/conversations/${c}/calls`, { kind: 'audio' })).body;
    await sql(`UPDATE calls SET created_at = now() - interval '5 minutes' WHERE id = $1`, [
      call2.id,
    ]);
    expect((await b.client.get(`/v1/calls/${call2.id}`)).body.status).toBe('missed');
    expect((await b.client.post(`/v1/calls/${call2.id}/join`)).status).toBe(409);

    const g = await group(a, [b, c3]);
    const gc = (await b.client.post(`/v1/conversations/${g}/calls`, { kind: 'video' })).body;
    expect((await c3.client.post(`/v1/calls/${gc.id}/decline`)).body.status).toBe('ringing'); // one decline does not end a group call
    expect((await c3.client.post(`/v1/calls/${gc.id}/end`)).status).toBe(403);
    expect((await a.client.post(`/v1/calls/${gc.id}/end`)).body.status).toBe('ended'); // owner of the group may end it
  });

  it('caps participants of a peer-to-peer mesh call', async () => {
    const owner = await signup(t);
    const members = await Promise.all(Array.from({ length: 8 }, () => signup(t)));
    const g = await group(owner, members);
    const call = (await owner.client.post(`/v1/conversations/${g}/calls`, { kind: 'audio' })).body;
    const results: number[] = [];
    for (const m of members)
      results.push((await m.client.post(`/v1/calls/${call.id}/join`)).status);
    expect(results.slice(0, 7)).toEqual(Array(7).fill(200));
    expect(results[7]).toBe(409); // owner + 7 = 8 participants
  }, 60_000);
});

// ================================================================== realtime
describe('websocket tickets and upgrade security', () => {
  it('issues single-use tickets, stores only a hash, and never accepts a session token in the URL', async () => {
    const u = await signup(t);
    expect((await new Client(t).post('/v1/ws/ticket')).status).toBe(401);
    const r = await u.client.post('/v1/ws/ticket');
    expect(r.status).toBe(200);
    expect(r.body.expiresInSec).toBe(60);
    expect(r.body.ticket.length).toBeGreaterThanOrEqual(32);
    expect(r.headers['cache-control']).toBe('no-store');
    const stored = (
      await sql('SELECT ticket_hash, expires_at FROM ws_tickets WHERE user_id = $1', [u.id])
    ).rows;
    expect(stored).toHaveLength(1);
    expect(stored[0].ticket_hash).not.toContain(r.body.ticket);
    expect(stored[0].expires_at.getTime() - Date.now()).toBeLessThanOrEqual(60_500);

    expect(await upgradeStatus(wsUrl(r.body.ticket))).toBe(101);
    expect(await upgradeStatus(wsUrl(r.body.ticket))).toBe(401); // single use
    // a session token is not a ticket, whichever way it is presented
    const bearer = await signup(t, { mode: 'bearer' });
    expect(await upgradeStatus(wsUrl(bearer.client.token!))).toBe(401);
    expect(await upgradeStatus(`ws://127.0.0.1:${port}/v1/ws?token=${bearer.client.token}`)).toBe(
      401,
    );
    expect(await upgradeStatus(`ws://127.0.0.1:${port}/v1/ws`)).toBe(401);
    expect(
      await upgradeStatus(`ws://127.0.0.1:${port}/v1/ws`, {
        origin: ORIGIN,
        authorization: `Bearer ${bearer.client.token}`,
      }),
    ).toBe(401);
    expect(await upgradeStatus(`ws://127.0.0.1:${port}/v1/ws?ticket=short`)).toBe(401);
    expect(await upgradeStatus(wsUrl('x'.repeat(43)))).toBe(401);
  });

  it('rejects a foreign Origin (without burning the ticket), expired tickets and ended sessions', async () => {
    const u = await signup(t);
    const ticket = await ticketFor(u);
    expect(await upgradeStatus(wsUrl(ticket), { origin: 'https://evil.example' })).toBe(403);
    expect(
      (await sql('SELECT used_at FROM ws_tickets WHERE user_id = $1', [u.id])).rows[0].used_at,
    ).toBeNull();
    expect(await upgradeStatus(wsUrl(ticket), {})).toBe(101); // native clients send no Origin; the ticket still authenticates them

    const expired = await ticketFor(u);
    await sql(
      `UPDATE ws_tickets SET expires_at = now() - interval '1 second' WHERE user_id = $1 AND used_at IS NULL`,
      [u.id],
    );
    expect(await upgradeStatus(wsUrl(expired))).toBe(401);

    const revoked = await ticketFor(u);
    await sql('UPDATE sessions SET revoked_at = now() WHERE user_id = $1', [u.id]);
    expect(await upgradeStatus(wsUrl(revoked))).toBe(401);
    // plain HTTP GET on the ws route is not a way in
    expect(
      (await t.app.inject({ method: 'GET', url: `/v1/ws?ticket=${revoked}` })).statusCode,
    ).toBe(404);
  });

  it('rate limits ticket issuance', async () => {
    const limited = await createTestApp({ RATE_LIMIT_ENABLED: 'true' });
    try {
      const u = await signup(limited);
      const statuses: number[] = [];
      for (let i = 0; i < 32; i++) statuses.push((await u.client.post('/v1/ws/ticket')).status);
      expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
      expect(statuses.slice(30)).toEqual([429, 429]);
    } finally {
      await limited.close();
    }
  });
});

describe('websocket delivery', () => {
  it('pushes message events to conversation members only', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const stranger = await signup(t);
    const c = await dm(a, b);
    const [sa, sb, ss] = await Promise.all([connect(a), connect(b), connect(stranger)]);
    const m = await say(a, c, 'live hello');
    for (const s of [sa, sb]) {
      const f = await s.expect((x) => x.type === 'message.new');
      expect(f).toMatchObject({
        conversationId: c,
        message: { id: m.id, body: 'live hello', senderId: a.id },
      });
      expect(f.message.clientMessageId).toBeUndefined(); // none was sent, so none is broadcast
      expect(f.message.reactions.mine).toBeNull(); // still viewer-neutral: no "mine" fields
    }
    await ss.none((x) => x.type === 'message.new');

    // Regression: the realtime broadcast is always hydrated with viewerId: null (it's fanned out to every
    // conversation member from one row), so clientMessageId must not be gated behind "is this the sender's
    // own view" the way reactions.mine/moderationStatus are — otherwise the sender's own optimistic-send
    // reconciliation (matching the WS echo back to its pending local message) silently breaks and a real
    // duplicate briefly renders in the sender's own chat.
    const cid = `client-${uniq('live')}`;
    const m2 = await say(a, c, 'with a client id', { clientMessageId: cid });
    for (const s of [sa, sb]) {
      const f = await s.expect((x) => x.type === 'message.new' && x.message.id === m2.id);
      expect(f.message.clientMessageId).toBe(cid);
    }

    await a.client.patch(`/v1/messages/${m.id}`, { body: 'live hello (edited)' });
    expect((await sb.expect((x) => x.type === 'message.updated')).message).toMatchObject({
      id: m.id,
      body: 'live hello (edited)',
    });
    await b.client.put(`/v1/messages/${m.id}/reaction`, { kind: 'love' });
    expect(
      (
        await sa.expect(
          (x) => x.type === 'message.updated' && x.message.reactions.counts.love === 1,
        )
      ).message.id,
    ).toBe(m.id);
    await b.client.post(`/v1/conversations/${c}/read`);
    expect(await sa.expect((x) => x.type === 'conversation.read')).toMatchObject({
      userId: b.id,
      conversationId: c,
    });
    await a.client.del(`/v1/messages/${m.id}`);
    expect(await sb.expect((x) => x.type === 'message.deleted')).toMatchObject({
      messageId: m.id,
      conversationId: c,
    });
    await ss.none((x) => x.type.startsWith('message') || x.type === 'conversation.read');
  });

  it('relays typing to others (not back to the typist), throttled, and only within subscribed conversations', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const stranger = await signup(t);
    const c = await dm(a, b);
    const [sa, sb, ss] = await Promise.all([connect(a), connect(b), connect(stranger)]);
    sa.send({ type: 'typing', conversationId: c });
    expect(await sb.expect((x) => x.type === 'typing')).toMatchObject({
      conversationId: c,
      userId: a.id,
      state: 'start',
    });
    sa.send({ type: 'typing', conversationId: c }); // throttled
    await sb.none((x) => x.type === 'typing');
    sa.send({ type: 'typing', conversationId: c, state: 'stop' });
    expect(await sb.expect((x) => x.type === 'typing')).toMatchObject({ state: 'stop' });
    await sa.none((x) => x.type === 'typing');
    ss.send({ type: 'typing', conversationId: c });
    expect(await ss.expect((x) => x.type === 'error')).toMatchObject({ code: 'not_subscribed' });
    await sb.none((x) => x.type === 'typing');
  });

  it('bridges notifications from the user channel and rejects subscribing to foreign conversations', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const stranger = await signup(t);
    const c = await dm(a, b);
    const sb = await connect(b);
    const ss = await connect(stranger);
    await notify(t.ctx, { userId: b.id, kind: 'follow', actorId: a.id });
    expect(await sb.expect((x) => x.type === 'notification')).toMatchObject({ kind: 'follow' });
    await ss.none((x) => x.type === 'notification');
    ss.send({ type: 'subscribe', conversationId: c });
    expect(await ss.expect((x) => x.type === 'error')).toMatchObject({ code: 'not_found' });
    await say(a, c, 'nope');
    await ss.none((x) => x.type === 'message.new');
    // a real DM message also produces a notification frame for the recipient
    expect(await sb.expect((x) => x.type === 'notification' && x.kind === 'message')).toBeTruthy();
  });

  it('follows membership: new members start receiving, removed members stop, blocked pairs are cut off', async () => {
    const owner = await signup(t);
    const m1 = await signup(t);
    const m2 = await signup(t);
    const g = await group(owner, [m1]);
    const [so, s1, s2] = await Promise.all([connect(owner), connect(m1), connect(m2)]);
    await say(owner, g, 'before m2');
    await s1.expect((x) => x.type === 'message.new');
    await s2.none((x) => x.type === 'message.new');
    await owner.client.post(`/v1/conversations/${g}/members`, { userIds: [m2.id] });
    expect(await s2.expect((x) => x.type === 'conversation.added')).toMatchObject({
      conversationId: g,
    });
    await s1.expect((x) => x.type === 'conversation.member.added');
    await say(owner, g, 'after m2');
    expect((await s2.expect((x) => x.type === 'message.new')).message.body).toBe('after m2');
    await owner.client.del(`/v1/conversations/${g}/members/${m2.id}`);
    expect(await s2.expect((x) => x.type === 'conversation.removed')).toMatchObject({
      conversationId: g,
    });
    await say(owner, g, 'after removal');
    await s1.expect((x) => x.type === 'message.new' && x.message.body === 'after removal');
    await s2.none((x) => x.type === 'message.new' && x.message.body === 'after removal');
    await so.expect((x) => x.type === 'message.new' && x.message.body === 'after removal');
  });

  it('re-validates subscriptions on heartbeat even if no membership event arrives', async () => {
    realtimeSettings.heartbeatMs = 120;
    const a = await signup(t);
    const b = await signup(t);
    const g = await group(a, [b]);
    const sb = await connect(b);
    await say(a, g, 'one');
    await sb.expect((x) => x.type === 'message.new');
    await sql(
      'UPDATE conversation_members SET left_at = now() WHERE conversation_id = $1 AND user_id = $2',
      [g, b.id],
    ); // out-of-band change, no event
    expect(
      await sb.expect((x) => x.type === 'unsubscribed' && x.reason === 'access_revoked'),
    ).toMatchObject({ conversationId: g });
    await say(a, g, 'two');
    await sb.none((x) => x.type === 'message.new');
  });

  it('closes sockets whose session was revoked', async () => {
    realtimeSettings.heartbeatMs = 120;
    const u = await signup(t);
    const s = await connect(u);
    await sql('UPDATE sessions SET revoked_at = now() WHERE user_id = $1', [u.id]);
    expect((await s.closed).code).toBe(4401);
  });

  it('serves community channel messages to active community members only', async () => {
    const owner = await signup(t);
    const member = await signup(t);
    const outsider = await signup(t);
    const { communityId, channelId } = await createCommunity(owner);
    await joinCommunity(communityId, member);
    const sm = await connect(member);
    const so = await connect(outsider);
    sm.send({ type: 'subscribe', conversationId: channelId });
    await sm.expect((x) => x.type === 'subscribed');
    so.send({ type: 'subscribe', conversationId: channelId });
    expect(await so.expect((x) => x.type === 'error')).toMatchObject({ code: 'not_found' });
    await say(owner, channelId, 'announcement');
    expect((await sm.expect((x) => x.type === 'message.new')).message.body).toBe('announcement');
    await so.none((x) => x.type === 'message.new');
    // losing community membership cuts the feed at the next heartbeat
    realtimeSettings.heartbeatMs = 120;
    const sm2 = await connect(member);
    sm2.send({ type: 'subscribe', conversationId: channelId });
    await sm2.expect((x) => x.type === 'subscribed');
    await joinCommunity(communityId, member, 'banned');
    await sm2.expect((x) => x.type === 'unsubscribed' && x.reason === 'access_revoked');
    await say(owner, channelId, 'after ban');
    await sm2.none((x) => x.type === 'message.new');
  });

  it('is robust to bad frames, oversized frames and enforces heartbeat pings', async () => {
    const u = await signup(t);
    const s = await connect(u);
    s.send('not json');
    expect(await s.expect((x) => x.type === 'error')).toMatchObject({ code: 'invalid_frame' });
    s.send({ type: 'launch-missiles' });
    expect(await s.expect((x) => x.type === 'error')).toMatchObject({ code: 'invalid_frame' });
    s.send({ type: 'subscribe', conversationId: 'nope' });
    expect(await s.expect((x) => x.type === 'error')).toMatchObject({ code: 'invalid_frame' });
    s.send({ type: 'ping' });
    await s.expect((x) => x.type === 'pong');
    s.send(
      JSON.stringify({
        type: 'typing',
        conversationId: '00000000-0000-4000-8000-000000000000',
        pad: 'x'.repeat(20_000),
      }),
    );
    expect((await s.closed).code).toBe(1009); // message too big
  });

  it('cleans up subscriptions when sockets close', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const c = await dm(a, b);
    const spy: string[] = [];
    const orig = t.ctx.pubsub.subscribe.bind(t.ctx.pubsub);
    let live = 0;
    (t.ctx.pubsub as any).subscribe = async (channel: string, h: any) => {
      spy.push(channel);
      live++;
      const un = await orig(channel, h);
      return async () => {
        live--;
        await un();
      };
    };
    try {
      const s = await connect(b);
      expect(live).toBeGreaterThanOrEqual(2); // user channel + the DM
      expect(spy).toContain(`conv:${c}`);
      expect(spy).toContain(`user:${b.id}`);
      s.close();
      await s.closed;
      await new Promise((r) => setTimeout(r, 200));
      expect(live).toBe(0);
    } finally {
      (t.ctx.pubsub as any).subscribe = orig;
    }
  });
});

describe('call signaling over websocket', () => {
  it('relays offer/answer/ice only between joined participants and stamps the sender', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const c3 = await signup(t);
    const stranger = await signup(t);
    const g = await group(a, [b, c3]);
    const call = (await a.client.post(`/v1/conversations/${g}/calls`, { kind: 'video' })).body;
    const [sa, sb, sc, ss] = await Promise.all([
      connect(a),
      connect(b),
      connect(c3),
      connect(stranger),
    ]);
    await b.client.post(`/v1/calls/${call.id}/join`);
    // call events reach the conversation members
    await sc.expect((x) => x.type === 'call.updated' && x.call.id === call.id);
    await ss.none((x) => x.type.startsWith('call.'));

    sa.send({
      type: 'call.signal',
      callId: call.id,
      to: b.id,
      signal: { kind: 'offer', data: { sdp: 'v=0...' } },
    });
    expect(await sb.expect((x) => x.type === 'call.signal')).toEqual({
      type: 'call.signal',
      callId: call.id,
      from: a.id,
      signal: { kind: 'offer', data: { sdp: 'v=0...' } },
    });
    sb.send({
      type: 'call.signal',
      callId: call.id,
      to: a.id,
      signal: { kind: 'answer', data: { sdp: 'answer' } },
    });
    expect(await sa.expect((x) => x.type === 'call.signal')).toMatchObject({
      from: b.id,
      signal: { kind: 'answer' },
    });
    sa.send({
      type: 'call.signal',
      callId: call.id,
      to: b.id,
      signal: { kind: 'ice', data: { candidate: 'c1' } },
    });
    expect(await sb.expect((x) => x.type === 'call.signal')).toMatchObject({
      signal: { kind: 'ice' },
    });

    // spoofed "from" is ignored (server stamps it)
    sa.send({
      type: 'call.signal',
      callId: call.id,
      to: b.id,
      from: c3.id,
      signal: { kind: 'ice', data: {} },
    });
    expect((await sb.expect((x) => x.type === 'call.signal')).from).toBe(a.id);

    // recipient has not joined the call: rejected, nothing delivered
    sa.send({
      type: 'call.signal',
      callId: call.id,
      to: c3.id,
      signal: { kind: 'offer', data: {} },
    });
    expect(await sa.expect((x) => x.type === 'error')).toMatchObject({ code: 'signal_rejected' });
    // a non-participant cannot inject signals
    ss.send({
      type: 'call.signal',
      callId: call.id,
      to: b.id,
      signal: { kind: 'offer', data: {} },
    });
    expect(await ss.expect((x) => x.type === 'error')).toMatchObject({ code: 'signal_rejected' });
    sc.send({
      type: 'call.signal',
      callId: call.id,
      to: b.id,
      signal: { kind: 'offer', data: {} },
    });
    expect(await sc.expect((x) => x.type === 'error')).toMatchObject({ code: 'signal_rejected' });
    await sc.none((x) => x.type === 'call.signal');
    // oversized signal payloads and signals to self are refused
    sa.send({
      type: 'call.signal',
      callId: call.id,
      to: b.id,
      signal: { kind: 'offer', data: 'x'.repeat(13_000) },
    });
    expect(await sa.expect((x) => x.type === 'error')).toMatchObject({ code: 'signal_too_large' });
    sa.send({
      type: 'call.signal',
      callId: call.id,
      to: a.id,
      signal: { kind: 'offer', data: {} },
    });
    expect(await sa.expect((x) => x.type === 'error')).toMatchObject({ code: 'signal_rejected' });

    // after the call ends, signaling stops
    await a.client.post(`/v1/calls/${call.id}/end`);
    sa.send({ type: 'call.signal', callId: call.id, to: b.id, signal: { kind: 'ice', data: {} } });
    expect(await sa.expect((x) => x.type === 'error' && x.code === 'signal_rejected')).toBeTruthy();
  });
});
