import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '@yapilapi/database';
import { getDeletionHooks } from '../src/lib/hooks.js';
import { getMediaRuntime } from '../src/modules/media/index.js';
import { getAiRuntime } from '../src/modules/ai/index.js';
import { getExportSections } from '../src/modules/privacy/registry.js';
import { Client, createTestApp, signup, type TestApp, type TestUser } from './helpers.js';
import { auditCount, befriend, block, follow, insertImage, teenBirth } from './entity-helpers.js';
import { hasFfmpeg, png, upload } from './media-fixtures.js';

let t: TestApp;
let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'yl-memory-test-'));
  t = await createTestApp({ MEDIA_LOCAL_DIR: dir });
});
afterAll(async () => {
  await getMediaRuntime(t.ctx).queue.idle();
  await t.close();
  rmSync(dir, { recursive: true, force: true });
});

const sql = <R extends Record<string, any> = any>(text: string, params: unknown[] = []) =>
  t.ctx.db.query<R>(text, params);
const setFlag = async (key: string, enabled: boolean) => {
  await sql('UPDATE feature_flags SET enabled = $2 WHERE key = $1', [key, enabled]);
  t.ctx.flags.invalidate();
};
const anon = () => new Client(t);
const post = async (u: TestUser, body: Record<string, unknown> = {}) => {
  const r = await u.client.post('/v1/posts', { body: 'a post', visibility: 'public', ...body });
  if (r.status !== 201) throw new Error(`post failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id as string;
};
const moment = async (u: TestUser, body: Record<string, unknown> = {}) => {
  const r = await u.client.post('/v1/moments', {
    kind: 'text',
    body: 'a moment',
    visibility: 'friends',
    expiry: 'permanent',
    ...body,
  });
  if (r.status !== 201) throw new Error(`moment failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id as string;
};
const mem = async (u: TestUser, body: Record<string, unknown> = {}) => {
  const r = await u.client.post('/v1/memories', { title: 'My memory', ...body });
  if (r.status !== 201) throw new Error(`memory failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const ids = async (v: Client, id: string) => {
  const r = await v.get(`/v1/memories/${id}`);
  return r.status === 200 ? r.body.items.map((i: any) => i.id).sort() : null;
};
const media = (u: TestUser) => insertImage(t, u.id, { purpose: 'attachment' });
async function real(u: TestUser, over: Record<string, unknown> = {}) {
  const s = (await u.client.post('/v1/real/capture-sessions', { deviceId: `device-${u.username}` }))
    .body;
  const r = await u.client.post('/v1/real/captures', {
    captureToken: s.token,
    deviceId: `device-${u.username}`,
    rearMediaId: await media(u),
    capturedAt: new Date().toISOString(),
    visibility: 'friends',
    ...over,
  });
  if (r.status !== 201) throw new Error(`real failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
async function event(
  host: TestUser,
  attendees: TestUser[],
  over: { visibility?: string; days?: number } = {},
) {
  const { rows } = await sql(
    `INSERT INTO events (title, host_id, starts_at, ends_at, status, visibility) VALUES ('Garden party', $1, now() - ($3 || ' days')::interval, now() - ($3 || ' days')::interval + interval '2 hours', 'completed', $2) RETURNING id`,
    [host.id, over.visibility ?? 'public', String(over.days ?? 3)],
  );
  for (const u of attendees)
    await sql(`INSERT INTO event_attendees (event_id, user_id, status) VALUES ($1,$2,'attended')`, [
      rows[0].id,
      u.id,
    ]);
  return rows[0].id as string;
}
async function experience(owner: TestUser, members: TestUser[] = []) {
  const e = (
    await owner.client.post('/v1/together', { title: 'Weekend away', visibility: 'private' })
  ).body;
  for (const m of members) {
    await befriend(owner, m).catch(() => undefined);
    await owner.client.post(`/v1/together/${e.id}/members`, { userId: m.id });
    await m.client.post(`/v1/together/${e.id}/accept`);
  }
  return e.id as string;
}
async function sentMessage(from: TestUser, to: TestUser, text: string) {
  const conv = (await from.client.post('/v1/conversations/direct', { userId: to.id })).body;
  const m = await from.client.post(`/v1/conversations/${conv.id}/messages`, {
    kind: 'text',
    body: text,
    clientMessageId: `c-${Math.random().toString(36).slice(2)}`,
  });
  if (m.status !== 201) throw new Error(`message failed ${m.status} ${JSON.stringify(m.body)}`);
  return m.body.id as string;
}

describe('creating memories', () => {
  it('requires auth, validates input, defaults to private, and audits nothing shared', async () => {
    const a = await signup(t);
    expect((await anon().post('/v1/memories', { title: 'x' })).status).toBe(401);
    expect((await a.client.post('/v1/memories', { title: '' })).status).toBe(400);
    expect((await a.client.post('/v1/memories', { title: 'x', kind: 'bogus' })).status).toBe(400);
    expect(
      (await a.client.post('/v1/memories', { title: 'x', dateStart: '2026-13-45' })).status,
    ).toBe(400);
    expect(
      (
        await a.client.post('/v1/memories', {
          title: 'x',
          dateStart: '2026-05-02',
          dateEnd: '2026-05-01',
        })
      ).status,
    ).toBe(400);
    expect(
      (await a.client.post('/v1/memories', { title: 'x', items: [{ type: 'post', id: 'nope' }] }))
        .status,
    ).toBe(400);
    expect(
      (
        await a.client.post('/v1/memories', {
          title: 'I will kill you and your family, you are going to die',
        })
      ).status,
    ).toBe(422);
    const m = await mem(a, {
      kind: 'trip',
      summary: 'nice',
      dateStart: '2026-05-01',
      dateEnd: '2026-05-04',
    });
    expect(m).toMatchObject({
      kind: 'trip',
      privacy: 'private',
      dateStart: '2026-05-01',
      dateEnd: '2026-05-04',
      aiGenerated: false,
      items: [],
      links: [],
      viewer: { isOwner: true },
      source: 'manual',
    });
    expect(await auditCount(t, 'memory.created', m.id)).toBe(1);
    expect(await auditCount(t, 'memory.shared', m.id)).toBe(0);
  });

  it('teens: private or friends only', async () => {
    const teen = await signup(t, { birthDate: teenBirth() });
    expect((await teen.client.post('/v1/memories', { title: 'x', privacy: 'public' })).status).toBe(
      422,
    );
    expect((await mem(teen, { privacy: 'friends' })).privacy).toBe('friends');
    const m = await mem(teen);
    expect((await teen.client.patch(`/v1/memories/${m.id}`, { privacy: 'public' })).status).toBe(
      422,
    );
  });

  it('edits, lists (filters, pagination) and deletes; only the owner may', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const m1 = await mem(a, { title: 'Alpine hike', kind: 'trip' });
    await mem(a, { title: 'Birthday', kind: 'highlight' });
    await mem(a, { title: 'Alpine again', kind: 'trip' });
    expect((await b.client.patch(`/v1/memories/${m1.id}`, { title: 'hacked' })).status).toBe(404);
    expect((await b.client.del(`/v1/memories/${m1.id}`)).status).toBe(404);
    expect((await anon().del(`/v1/memories/${m1.id}`)).status).toBe(401);
    expect(
      (
        await a.client.patch(`/v1/memories/${m1.id}`, {
          title: 'Alpine hike 2026',
          summary: 'sunny',
        })
      ).body,
    ).toMatchObject({ title: 'Alpine hike 2026', summary: 'sunny' });
    expect((await a.client.get('/v1/memories', { kind: 'trip' })).body.items).toHaveLength(2);
    expect(
      (await a.client.get('/v1/memories', { q: 'birth' })).body.items.map((i: any) => i.title),
    ).toEqual(['Birthday']);
    expect((await a.client.get('/v1/memories', { q: '%' })).body.items).toHaveLength(0);
    const p1 = (await a.client.get('/v1/memories', { limit: '2' })).body;
    const p2 = (await a.client.get('/v1/memories', { limit: '2', cursor: p1.nextCursor })).body;
    expect(p1.items).toHaveLength(2);
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
    expect((await b.client.get('/v1/memories')).body.items).toEqual([]);
    expect((await a.client.del(`/v1/memories/${m1.id}`)).status).toBe(204);
    expect((await a.client.get(`/v1/memories/${m1.id}`)).status).toBe(404);
    expect((await a.client.del(`/v1/memories/${m1.id}`)).status).toBe(404);
    expect(await auditCount(t, 'memory.deleted', m1.id)).toBe(1);
  });
});

describe('what may be added', () => {
  it('own things, things visible to you; never things you cannot see; messages only if you sent them', async () => {
    const a = await signup(t);
    const friend = await signup(t);
    const stranger = await signup(t);
    const blockedUser = await signup(t);
    await befriend(a, friend);
    const m = await mem(a);
    const add = (type: string, id: string, u = a) =>
      u.client.post(`/v1/memories/${m.id}/items`, { items: [{ type, id }] });
    const okCode = async (type: string, id: string, u = a) => (await add(type, id, u)).status;

    // posts
    expect(await okCode('post', await post(a, { visibility: 'private' }))).toBe(200);
    expect(await okCode('post', await post(friend, { visibility: 'friends' }))).toBe(200); // visible to me
    expect(await okCode('post', await post(friend, { visibility: 'private' }))).toBe(400);
    expect(await okCode('post', await post(stranger, { visibility: 'friends' }))).toBe(400);
    expect(await okCode('post', await post(stranger, { visibility: 'public' }))).toBe(200);
    await block(a, blockedUser);
    expect(await okCode('post', await post(blockedUser, { visibility: 'public' }))).toBe(400);
    expect(await okCode('post', '00000000-0000-4000-8000-000000000000')).toBe(400);
    // moments
    expect(await okCode('moment', await moment(a))).toBe(200);
    expect(await okCode('moment', await moment(friend))).toBe(200);
    expect(await okCode('moment', await moment(stranger))).toBe(400);
    // media: only my own files
    expect(await okCode('media', await media(a))).toBe(200);
    expect(await okCode('media', await media(friend))).toBe(400);
    // Reals: mine, or visible to me
    expect(await okCode('real_capture', (await real(a, { visibility: 'private' })).id)).toBe(200);
    expect(await okCode('real_capture', (await real(friend, { visibility: 'friends' })).id)).toBe(
      200,
    );
    expect(await okCode('real_capture', (await real(friend, { visibility: 'private' })).id)).toBe(
      400,
    );
    // messages: only ones I sent
    const mine = await sentMessage(a, friend, 'see you at the lake');
    const theirs = await sentMessage(friend, a, 'private reply');
    expect(await okCode('message', mine)).toBe(200);
    expect(await okCode('message', theirs)).toBe(400);
    expect(await okCode('message', mine, stranger)).toBe(404); // not their memory
    // events: attended only
    const attended = await event(a, [a, friend]);
    const notAttended = await event(friend, [friend]);
    expect(await okCode('event', attended)).toBe(200);
    expect(await okCode('event', notAttended)).toBe(400);
    // experiences: joined only
    const exp = await experience(friend, [a]);
    expect(await okCode('experience', exp)).toBe(200);
    expect(await okCode('experience', await experience(friend))).toBe(400);
    // one bad item rejects the whole batch (nothing half-added)
    const before = (await a.client.get(`/v1/memories/${m.id}`)).body.itemCount;
    const bad = await a.client.post(`/v1/memories/${m.id}/items`, {
      items: [
        { type: 'post', id: await post(a) },
        { type: 'post', id: await post(friend, { visibility: 'private' }) },
      ],
    });
    expect(bad.status).toBe(400);
    expect((await a.client.get(`/v1/memories/${m.id}`)).body.itemCount).toBe(before);
    // duplicates are ignored; creating with items enforces the same rules
    const p = await post(a);
    expect((await add('post', p)).body.added).toBe(1);
    expect((await add('post', p)).body.added).toBe(0);
    expect(
      (
        await a.client.post('/v1/memories', {
          title: 'x',
          items: [{ type: 'post', id: await post(friend, { visibility: 'private' }) }],
        })
      ).status,
    ).toBe(400);
    expect((await a.client.post(`/v1/memories/${m.id}/items`, { items: [] })).status).toBe(400);
    expect(
      (await a.client.post(`/v1/memories/${m.id}/items`, { items: [{ type: 'nope', id: p }] }))
        .status,
    ).toBe(400);
  });

  it('links: friends, places, attended events, own trips, joined communities and experiences only', async () => {
    const a = await signup(t);
    const friend = await signup(t);
    const stranger = await signup(t);
    await befriend(a, friend);
    const m = await mem(a);
    const link = (type: string, id: string) =>
      a.client.post(`/v1/memories/${m.id}/links`, { links: [{ type, id }] });
    expect((await link('person', friend.id)).status).toBe(200);
    expect((await link('person', stranger.id)).status).toBe(400);
    expect((await link('person', a.id)).status).toBe(200);
    expect((await link('place', '00000000-0000-4000-8000-000000000000')).status).toBe(400);
    const { rows } = await sql(
      `INSERT INTO places (name, kind, latitude, longitude) VALUES ('Lake Cafe','venue',1,2) RETURNING id`,
    );
    expect((await link('place', rows[0].id)).status).toBe(200);
    expect((await link('event', await event(a, [a]))).status).toBe(200);
    expect((await link('event', await event(friend, [friend]))).status).toBe(400);
    const trip = await mem(a, { kind: 'trip' });
    expect((await link('trip', trip.id)).status).toBe(200);
    expect((await link('trip', m.id)).status).toBe(400); // not a trip memory
    expect((await link('community', '00000000-0000-4000-8000-000000000000')).status).toBe(400);
    expect((await link('experience', await experience(a))).status).toBe(200);
    const view = (await a.client.get(`/v1/memories/${m.id}`)).body;
    expect(view.links.map((l: any) => l.type).sort()).toEqual([
      'event',
      'experience',
      'person',
      'person',
      'place',
      'trip',
    ]);
    expect(view.links.find((l: any) => l.type === 'place').label).toBe('Lake Cafe');
    expect((await a.client.del(`/v1/memories/${m.id}/links/person/${a.id}`)).status).toBe(204);
    expect((await a.client.del(`/v1/memories/${m.id}/links/person/${a.id}`)).status).toBe(404);
    expect(
      (
        await stranger.client.post(`/v1/memories/${m.id}/links`, {
          links: [{ type: 'place', id: rows[0].id }],
        })
      ).status,
    ).toBe(404);
  });

  it('removes and reorders items without touching the items themselves', async () => {
    const a = await signup(t);
    const p1 = await post(a);
    const p2 = await post(a);
    const p3 = await post(a);
    const m = await mem(a, {
      items: [
        { type: 'post', id: p1 },
        { type: 'post', id: p2 },
        { type: 'post', id: p3 },
      ],
    });
    expect(await ids(a.client, m.id)).toEqual([p1, p2, p3].sort());
    expect(
      (
        await a.client.put(`/v1/memories/${m.id}/items/order`, {
          items: [
            { type: 'post', id: p3 },
            { type: 'post', id: p1 },
          ],
        })
      ).status,
    ).toBe(204);
    expect((await a.client.get(`/v1/memories/${m.id}`)).body.items.map((i: any) => i.id)).toEqual([
      p3,
      p1,
      p2,
    ]);
    expect(
      (
        await a.client.put(`/v1/memories/${m.id}/items/order`, {
          items: [{ type: 'post', id: '00000000-0000-4000-8000-000000000000' }],
        })
      ).status,
    ).toBe(400);
    expect((await a.client.del(`/v1/memories/${m.id}/items/post/${p1}`)).status).toBe(204);
    expect((await a.client.del(`/v1/memories/${m.id}/items/post/${p1}`)).status).toBe(404);
    expect((await a.client.get(`/v1/posts/${p1}`)).status).toBe(200);
    expect((await a.client.get(`/v1/memories/${m.id}`)).body.items.map((i: any) => i.id)).toEqual([
      p3,
      p2,
    ]);
    const b = await signup(t);
    expect((await b.client.del(`/v1/memories/${m.id}/items/post/${p2}`)).status).toBe(404);
  });
});

describe("sharing never widens an item's audience (the key privacy property)", () => {
  it("each viewer sees exactly the items they could already see, whatever the memory's own privacy", async () => {
    const owner = await signup(t);
    const friend = await signup(t);
    const follower = await signup(t);
    const stranger = await signup(t);
    const picked = await signup(t);
    const blocked = await signup(t);
    const teen = await signup(t, { birthDate: teenBirth() });
    await befriend(owner, friend);
    await befriend(owner, picked);
    await follow(follower, owner);
    await block(owner, blocked);

    const pubPost = await post(owner, { visibility: 'public' });
    const friendPost = await post(owner, { visibility: 'friends' });
    const followerPost = await post(owner, { visibility: 'followers' });
    const privPost = await post(owner, { visibility: 'private' });
    const selPost = await post(owner, { visibility: 'selected', audience: [picked.id] });
    const friendMoment = await moment(owner, { visibility: 'friends' });
    const privReal = (await real(owner, { visibility: 'private' })).id;
    const friendReal = (await real(owner, { visibility: 'friends' })).id;
    const ownMedia = await media(owner);
    const message = await sentMessage(owner, friend, 'only between us');
    const exp = await experience(owner);
    const all = [
      pubPost,
      friendPost,
      followerPost,
      privPost,
      selPost,
      friendMoment,
      privReal,
      friendReal,
      ownMedia,
      message,
      exp,
    ];
    const refs = [
      ...[pubPost, friendPost, followerPost, privPost, selPost].map((id) => ({ type: 'post', id })),
      { type: 'moment', id: friendMoment },
      { type: 'real_capture', id: privReal },
      { type: 'real_capture', id: friendReal },
      { type: 'media', id: ownMedia },
      { type: 'message', id: message },
      { type: 'experience', id: exp },
    ];

    const m = await mem(owner, { items: refs, privacy: 'public' });
    expect(m.itemCount).toBe(all.length);
    expect(await auditCount(t, 'memory.shared', m.id)).toBe(1); // creating it public is itself a sharing act

    const seen = async (u: Client | null) => new Set((await ids(u ?? anon(), m.id)) ?? []);
    const set = (...xs: string[]) => new Set(xs);
    // The owner sees all of it.
    expect(await seen(owner.client)).toEqual(set(...all));
    // A friend: the public and friends-audience items, and NOTHING private, even though the memory is public. The message is the owner's alone.
    expect(await seen(friend.client)).toEqual(set(pubPost, friendPost, friendMoment, friendReal));
    // A follower: public and followers-only posts.
    expect(await seen(follower.client)).toEqual(set(pubPost, followerPost));
    // The selected person sees the public post and the one addressed to them.
    expect(await seen(picked.client)).toEqual(
      set(pubPost, friendPost, selPost, friendMoment, friendReal),
    );
    // Strangers, teens and anonymous: the public post only.
    expect(await seen(stranger.client)).toEqual(set(pubPost));
    expect(await seen(teen.client)).toEqual(set(pubPost));
    expect(await seen(anon())).toEqual(set(pubPost));
    // Blocked either way: the memory itself is gone.
    expect((await blocked.client.get(`/v1/memories/${m.id}`)).status).toBe(404);
    // Viewers are never told how many items were hidden from them.
    const fv = (await friend.client.get(`/v1/memories/${m.id}`)).body;
    expect(fv.itemCount).toBe(4);
    expect(fv.unavailableItemCount).toBeUndefined();
    expect(JSON.stringify(fv)).not.toContain('only between us');
    expect((await owner.client.get(`/v1/memories/${m.id}`)).body.unavailableItemCount).toBe(0);
    // Listing shows per-viewer counts too.
    const lst = (await friend.client.get(`/v1/users/${owner.username}/memories`)).body.items.find(
      (i: any) => i.id === m.id,
    );
    expect(lst.itemCount).toBe(4);
    expect(
      (await stranger.client.get(`/v1/users/${owner.username}/memories`)).body.items.find(
        (i: any) => i.id === m.id,
      ).itemCount,
    ).toBe(1);

    // Recap and AI-free summaries are computed from what the VIEWER can see only.
    const fr = (await friend.client.get(`/v1/memories/${m.id}/recap`)).body.recap;
    expect(fr.total).toBe(4);
    expect((await stranger.client.get(`/v1/memories/${m.id}/recap`)).body.recap.total).toBe(1);
    expect((await owner.client.get(`/v1/memories/${m.id}/recap`)).body.recap.total).toBe(
      all.length,
    );

    // Changing the item's own audience is respected immediately (no copy was made).
    await sql(`UPDATE posts SET visibility = 'private' WHERE id = $1`, [friendPost]);
    expect(await seen(friend.client)).toEqual(set(pubPost, friendMoment, friendReal));
    await sql(`UPDATE posts SET deleted_at = now() WHERE id = $1`, [pubPost]);
    expect(await seen(anon())).toEqual(set());
    // Un-friending removes friend-audience items from the friend's view.
    await sql(
      `DELETE FROM friendships WHERE user_low = LEAST($1::uuid,$2::uuid) AND user_high = GREATEST($1::uuid,$2::uuid)`,
      [owner.id, friend.id],
    );
    expect((await friend.client.get(`/v1/memories/${m.id}`)).status).toBe(200);
    expect(await seen(friend.client)).toEqual(set());
  });

  it('friends-only memory: only friends open it, and still only their own audience of items', async () => {
    const owner = await signup(t);
    const friend = await signup(t);
    const stranger = await signup(t);
    await befriend(owner, friend);
    const pubPost = await post(owner, { visibility: 'public' });
    const privPost = await post(owner, { visibility: 'private' });
    const m = await mem(owner, {
      privacy: 'friends',
      items: [
        { type: 'post', id: pubPost },
        { type: 'post', id: privPost },
      ],
    });
    expect(await ids(friend.client, m.id)).toEqual([pubPost]);
    expect((await stranger.client.get(`/v1/memories/${m.id}`)).status).toBe(404);
    expect((await anon().get(`/v1/memories/${m.id}`)).status).toBe(404);
    expect((await stranger.client.get(`/v1/users/${owner.username}/memories`)).body.items).toEqual(
      [],
    );
    expect(
      (await friend.client.get(`/v1/users/${owner.username}/memories`)).body.items.map(
        (i: any) => i.id,
      ),
    ).toEqual([m.id]);
    // private again
    await owner.client.patch(`/v1/memories/${m.id}`, { privacy: 'private' });
    expect((await friend.client.get(`/v1/memories/${m.id}`)).status).toBe(404);
  });

  it("a memory holding someone else's friends-only post never exposes it to the owner's other audiences", async () => {
    const owner = await signup(t);
    const author = await signup(t);
    const ownersFriend = await signup(t);
    await befriend(owner, author);
    await befriend(owner, ownersFriend);
    const authorsPost = await post(author, { visibility: 'friends' });
    const m = await mem(owner, { privacy: 'public', items: [{ type: 'post', id: authorsPost }] });
    expect(await ids(owner.client, m.id)).toEqual([authorsPost]);
    expect(await ids(ownersFriend.client, m.id)).toEqual([]); // not the author's friend
    expect(await ids(anon(), m.id)).toEqual([]);
    expect(await ids(author.client, m.id)).toEqual([authorsPost]);
    // if the author blocks the owner, the owner loses the item too
    await block(author, owner);
    expect(await ids(owner.client, m.id)).toEqual([]);
    expect((await owner.client.get(`/v1/memories/${m.id}`)).body.unavailableItemCount).toBe(1);
  });

  it('links are shown to viewers only when they are allowed to learn of them', async () => {
    const owner = await signup(t);
    const friend = await signup(t);
    const mutual = await signup(t);
    const stranger = await signup(t);
    await befriend(owner, friend);
    await befriend(owner, mutual);
    await befriend(friend, mutual);
    const { rows } = await sql(
      `INSERT INTO places (name, kind, latitude, longitude) VALUES ('Some Place','venue',1,2) RETURNING id`,
    );
    const m = await mem(owner, {
      privacy: 'public',
      links: [
        { type: 'person', id: friend.id },
        { type: 'place', id: rows[0].id },
      ],
    });
    const linksFor = async (u: Client) =>
      (await u.get(`/v1/memories/${m.id}`)).body.links.map((l: any) => l.type);
    expect(await linksFor(owner.client)).toEqual(['person', 'place']);
    expect(await linksFor(friend.client)).toEqual(['person', 'place']);
    expect(await linksFor(mutual.client)).toEqual(['person', 'place']); // friend of the linked person
    expect(await linksFor(stranger.client)).toEqual(['place']);
    expect(await linksFor(anon())).toEqual(['place']);
  });
});

describe('timeline', () => {
  it('shows my own life across sources, filterable by range, place, event, person and type, with pagination', async () => {
    const a = await signup(t);
    const friend = await signup(t);
    const stranger = await signup(t);
    await befriend(a, friend);
    const { rows: pl } = await sql(
      `INSERT INTO places (name, kind, latitude, longitude) VALUES ('Harbour','venue',1,2) RETURNING id`,
    );
    const ev = await event(a, [a, friend], { days: 10 });
    const p1 = await post(a, { placeId: pl[0].id });
    const p2 = await post(a);
    await sql(`UPDATE posts SET event_id = $1 WHERE id = $2`, [ev, p2]);
    const p3 = await post(a);
    const mo = await moment(a);
    const rc = (await real(a)).id;
    await post(friend); // someone else's: never on my timeline
    await sql(`UPDATE posts SET created_at = '2026-01-10T10:00:00Z' WHERE id = $1`, [p1]);
    await sql(`UPDATE posts SET created_at = '2026-02-10T10:00:00Z' WHERE id = $1`, [p2]);
    await sql(`UPDATE posts SET created_at = '2026-03-10T10:00:00Z' WHERE id = $1`, [p3]);
    const tl = async (q: Record<string, string> = {}, u: TestUser = a) =>
      await u.client.get('/v1/memory/timeline', q);
    const all = (await tl({ limit: '50' })).body.items;
    expect(all.map((i: any) => i.id)).toEqual(expect.arrayContaining([p1, p2, p3, mo, rc, ev]));
    expect(all).toHaveLength(6);
    const times = all.map((i: any) => Date.parse(i.at));
    expect(times).toEqual([...times].sort((x, y) => y - x));
    expect(
      (
        await tl({
          order: 'asc',
          from: '2026-01-01T00:00:00Z',
          to: '2026-03-01T00:00:00Z',
          types: 'post',
        })
      ).body.items.map((i: any) => i.id),
    ).toEqual([p1, p2]);
    expect((await tl({ placeId: pl[0].id })).body.items.map((i: any) => i.id)).toEqual([p1]);
    expect((await tl({ eventId: ev })).body.items.map((i: any) => i.id).sort()).toEqual(
      [p2, ev].sort(),
    );
    expect((await tl({ personId: friend.id })).body.items.map((i: any) => i.id).sort()).toEqual(
      [p2, ev].sort(),
    ); // what we did together
    expect((await tl({ personId: stranger.id })).status).toBe(404);
    expect((await tl({ types: 'bogus' })).status).toBe(400);
    expect((await tl({ from: 'yesterday' })).status).toBe(400);
    const pg1 = (await tl({ limit: '4' })).body;
    const pg2 = (await tl({ limit: '4', cursor: pg1.nextCursor })).body;
    expect([...pg1.items, ...pg2.items].map((i: any) => i.id).sort()).toEqual(
      [p1, p2, p3, mo, rc, ev].sort(),
    );
    expect(pg2.nextCursor).toBeNull();
    expect((await tl({}, friend)).body.items.map((i: any) => i.id)).not.toContain(p1); // it is my timeline only
    expect((await anon().get('/v1/memory/timeline')).status).toBe(401);
  });
});

describe('on this day', () => {
  it('computes suggestions deterministically, never auto-creating or sharing; accepting makes a private memory once', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const p1 = await post(a);
    const p2 = await post(a);
    const p3 = await post(a);
    const other = await post(b);
    await sql(`UPDATE posts SET created_at = '2024-06-12T09:00:00Z' WHERE id = ANY($1)`, [
      [p1, p2],
    ]);
    await sql(`UPDATE posts SET created_at = '2023-06-12T09:00:00Z' WHERE id = ANY($1)`, [
      [p3, other],
    ]);
    const get = async () =>
      (await a.client.get('/v1/memory/on-this-day', { date: '2026-06-12' })).body.suggestions;
    const s = await get();
    expect(s.map((x: any) => [x.year, x.itemCount])).toEqual([
      [2024, 2],
      [2023, 1],
    ]);
    expect(await get()).toEqual(s); // deterministic
    expect(s[0].key).toBe('otd:06-12:2024');
    expect((await a.client.get('/v1/memories')).body.items).toEqual([]); // nothing was created
    expect(
      (await a.client.get('/v1/memory/on-this-day', { date: '2026-06-13' })).body.suggestions,
    ).toEqual([]);
    expect(
      (await b.client.get('/v1/memory/on-this-day', { date: '2026-06-12' })).body.suggestions
        .map((x: any) => x.items.map((i: any) => i.id))
        .flat(),
    ).toEqual([other]);
    expect((await a.client.get('/v1/memory/on-this-day', { date: 'soon' })).status).toBe(400);
    const acc = await a.client.post('/v1/memory/on-this-day/accept', {
      date: '2026-06-12',
      year: 2024,
    });
    expect(acc.status).toBe(201);
    expect(acc.body).toMatchObject({
      kind: 'on_this_day',
      privacy: 'private',
      source: 'on_this_day',
      itemCount: 2,
    });
    expect(acc.body.title).toBe('On this day in 2024');
    expect((await get()).map((x: any) => x.year)).toEqual([2023]); // accepted ones are not suggested again
    expect(
      (await a.client.post('/v1/memory/on-this-day/accept', { date: '2026-06-12', year: 2024 }))
        .status,
    ).toBe(404);
    expect(
      (await a.client.post('/v1/memory/suggestions/dismiss', { key: 'otd:06-12:2023' })).status,
    ).toBe(204);
    expect(await get()).toEqual([]);
    expect((await a.client.post('/v1/memory/suggestions/dismiss', { key: 'bogus' })).status).toBe(
      400,
    );
    expect(
      (await a.client.post('/v1/memory/on-this-day/accept', { date: '2026-06-12', year: 2023 }))
        .status,
    ).toBe(404);
    expect(await auditCount(t, 'memory.shared', acc.body.id)).toBe(0);
  });
});

describe('trips', () => {
  it('detects a trip from geotagged items, and only creates a private memory when accepted', async () => {
    const a = await signup(t);
    const geo = async (lat: number, lng: number, at: string) => {
      const id = await post(a, { latitude: lat, longitude: lng });
      await sql('UPDATE posts SET created_at = $2 WHERE id = $1', [id, at]);
      return id;
    };
    const home = [
      await geo(51.5, -0.12, '2026-03-01T10:00:00Z'),
      await geo(51.51, -0.11, '2026-03-02T10:00:00Z'),
      await geo(51.5, -0.13, '2026-03-04T10:00:00Z'),
    ];
    const away = [
      await geo(38.72, -9.14, '2026-04-10T09:00:00Z'),
      await geo(38.71, -9.13, '2026-04-10T19:00:00Z'),
      await geo(38.75, -9.2, '2026-04-11T12:00:00Z'),
    ];
    await post(a); // not geotagged: ignored
    const s = (await a.client.get('/v1/memory/trips/suggestions')).body.suggestions;
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ itemCount: 3, distinctDays: 2 });
    expect(s[0].maxDistanceFromHomeKm).toBeGreaterThan(1500);
    expect((await a.client.get('/v1/memories')).body.items).toEqual([]);
    expect((await a.client.post('/v1/memory/trips/accept', { key: 'a'.repeat(24) })).status).toBe(
      404,
    );
    expect((await a.client.post('/v1/memory/trips/accept', { key: 'zz' })).status).toBe(400);
    const acc = await a.client.post('/v1/memory/trips/accept', { key: s[0].key, title: 'Lisbon' });
    expect(acc.status).toBe(201);
    expect(acc.body).toMatchObject({
      kind: 'trip',
      title: 'Lisbon',
      privacy: 'private',
      source: 'trip',
      dateStart: '2026-04-10',
      dateEnd: '2026-04-11',
    });
    expect(acc.body.items.map((i: any) => i.id).sort()).toEqual([...away].sort());
    expect(acc.body.items.map((i: any) => i.id)).not.toContain(home[0]);
    expect((await a.client.get('/v1/memory/trips/suggestions')).body.suggestions).toEqual([]);
    const b = await signup(t);
    expect((await b.client.get('/v1/memory/trips/suggestions')).body.suggestions).toEqual([]);
    expect((await b.client.post('/v1/memory/trips/accept', { key: s[0].key })).status).toBe(404);
  });
});

describe('recap', () => {
  it('is deterministic, viewer-specific, and only saved when the owner asks', async () => {
    const a = await signup(t);
    const p1 = await post(a);
    const p2 = await post(a);
    const mo = await moment(a);
    await sql(`UPDATE posts SET created_at = '2026-06-12T10:00:00Z' WHERE id = $1`, [p1]);
    await sql(`UPDATE posts SET created_at = '2026-06-14T10:00:00Z' WHERE id = $1`, [p2]);
    await sql(`UPDATE moments SET created_at = '2026-06-13T10:00:00Z' WHERE id = $1`, [mo]);
    const m = await mem(a, {
      items: [
        { type: 'post', id: p1 },
        { type: 'post', id: p2 },
        { type: 'moment', id: mo },
      ],
    });
    const r1 = (await a.client.get(`/v1/memories/${m.id}/recap`)).body;
    expect(r1.recap).toMatchObject({
      total: 3,
      counts: { post: 2, moment: 1 },
      dateStart: '2026-06-12',
      dateEnd: '2026-06-14',
      spanDays: 3,
    });
    expect(r1.text).toBe('3 items from 2026-06-12 to 2026-06-14 (3 days): 2 posts, 1 moment.');
    expect((await a.client.get(`/v1/memories/${m.id}/recap`)).body).toEqual(r1);
    expect((await a.client.get(`/v1/memories/${m.id}`)).body.summary).toBe('');
    const b = await signup(t);
    expect((await b.client.post(`/v1/memories/${m.id}/recap/apply`)).status).toBe(404);
    expect((await b.client.get(`/v1/memories/${m.id}/recap`)).status).toBe(404);
    expect((await a.client.post(`/v1/memories/${m.id}/recap/apply`)).body.summary).toBe(r1.text);
    expect((await a.client.get(`/v1/memories/${m.id}`)).body).toMatchObject({
      summary: r1.text,
      aiGenerated: false,
    });
  });
});

describe('AI drafts (optional, confirmed by the human)', () => {
  const rt = () => getAiRuntime(t.ctx);
  const provider = (name: string, reply: (req: any) => string) => {
    const p: any = {
      name,
      isDev: false,
      model: `${name}-1`,
      calls: 0,
      requests: [] as any[],
      supports: () => true,
      async chat(req: any) {
        p.calls++;
        p.requests.push(req);
        return {
          content: reply(req),
          toolCalls: [],
          provider: name,
          model: `${name}-1`,
          usage: { inputTokens: 5, outputTokens: 5 },
          finishReason: 'stop',
        };
      },
    };
    return p;
  };
  const consent = (u: TestUser, granted = true) =>
    u.client.put('/v1/privacy/consents/ai_processing', { granted });

  it('needs AI consent, produces drafts that change nothing until confirmed, then records provenance', async () => {
    const a = await signup(t);
    const friend = await signup(t);
    await befriend(a, friend);
    const mine = await post(a, { body: 'sunrise at the ridge' });
    const theirs = await post(friend, { body: 'FRIENDS-SECRET-TEXT', visibility: 'friends' });
    const m = await mem(a, {
      title: 'Ridge day',
      items: [
        { type: 'post', id: mine },
        { type: 'post', id: theirs },
      ],
    });
    const fake = provider('memfake', (req) =>
      req.json ? JSON.stringify({ picks: [1, 0, 99] }) : 'A bright day on the ridge.',
    );
    rt().registry.register(fake);
    rt().router.setRoute('summarise', ['memfake']);
    try {
      expect(
        (await a.client.post(`/v1/memories/${m.id}/ai-drafts`, { kind: 'summary' })).status,
      ).toBe(403); // no consent
      expect(fake.calls).toBe(0);
      await consent(a);
      const b = await signup(t);
      expect(
        (await b.client.post(`/v1/memories/${m.id}/ai-drafts`, { kind: 'summary' })).status,
      ).toBe(404);
      expect((await a.client.post(`/v1/memories/${m.id}/ai-drafts`, { kind: 'poem' })).status).toBe(
        400,
      );
      const d = await a.client.post(`/v1/memories/${m.id}/ai-drafts`, { kind: 'summary' });
      expect(d.status).toBe(201);
      expect(d.body).toMatchObject({
        kind: 'summary',
        status: 'pending',
        provider: 'memfake',
        payload: { text: 'A bright day on the ridge.' },
      });
      // the model saw the user's own text, never the friend's
      const sent = JSON.stringify(fake.requests[0]);
      expect(sent).toContain('sunrise at the ridge');
      expect(sent).not.toContain('FRIENDS-SECRET-TEXT');
      // nothing changed yet
      expect((await a.client.get(`/v1/memories/${m.id}`)).body).toMatchObject({
        summary: '',
        aiGenerated: false,
      });
      // another user cannot confirm it
      expect(
        (await b.client.post(`/v1/memories/${m.id}/ai-drafts/${d.body.id}/confirm`, {})).status,
      ).toBe(404);
      const ok = await a.client.post(`/v1/memories/${m.id}/ai-drafts/${d.body.id}/confirm`, {
        text: 'A bright day on the ridge, edited.',
      });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({
        summary: 'A bright day on the ridge, edited.',
        aiGenerated: true,
      });
      expect(ok.body.aiProvenance).toMatchObject({
        generated: true,
        provider: 'memfake',
        kind: 'summary',
        editedByUser: true,
        draftId: d.body.id,
      });
      expect(
        (await a.client.post(`/v1/memories/${m.id}/ai-drafts/${d.body.id}/confirm`, {})).status,
      ).toBe(404); // single use
      expect(await auditCount(t, 'memory.ai_draft_confirmed', m.id)).toBe(1);
      // title draft, discarded
      const td = await a.client.post(`/v1/memories/${m.id}/ai-drafts`, { kind: 'title' });
      expect(
        (await a.client.post(`/v1/memories/${m.id}/ai-drafts/${td.body.id}/discard`)).status,
      ).toBe(204);
      expect(
        (await a.client.post(`/v1/memories/${m.id}/ai-drafts/${td.body.id}/confirm`, {})).status,
      ).toBe(404);
      expect((await a.client.get(`/v1/memories/${m.id}`)).body.title).toBe('Ridge day');
      expect(
        (await a.client.get(`/v1/memories/${m.id}/ai-drafts`)).body.items
          .map((i: any) => i.status)
          .sort(),
      ).toEqual(['confirmed', 'discarded']);
      // highlights reorder only, from valid indexes
      const hd = await a.client.post(`/v1/memories/${m.id}/ai-drafts`, { kind: 'highlights' });
      expect(hd.status).toBe(201);
      expect(hd.body.payload.items).toHaveLength(2);
      const hv = await a.client.post(`/v1/memories/${m.id}/ai-drafts/${hd.body.id}/confirm`, {});
      expect(hv.body.items).toHaveLength(2);
      // editing an AI memory by hand is recorded
      await a.client.patch(`/v1/memories/${m.id}`, { summary: 'my words' });
      expect((await a.client.get(`/v1/memories/${m.id}`)).body.aiProvenance.editedByUser).toBe(
        true,
      );
      // consent withdrawn: no more drafts
      await consent(a, false);
      expect(
        (await a.client.post(`/v1/memories/${m.id}/ai-drafts`, { kind: 'summary' })).status,
      ).toBe(403);
    } finally {
      rt().router.setRoute('summarise', undefined);
      rt().registry.unregister('memfake');
    }
  });

  it('refuses unusable model output and unsafe text instead of saving it', async () => {
    const a = await signup(t);
    await consent(a);
    const m = await mem(a, { items: [{ type: 'post', id: await post(a) }] });
    const bad = provider('memjunk', (req) =>
      req.json ? 'not json at all' : 'I will kill you and your family, you are going to die',
    );
    rt().registry.register(bad);
    rt().router.setRoute('summarise', ['memjunk']);
    try {
      expect(
        (await a.client.post(`/v1/memories/${m.id}/ai-drafts`, { kind: 'highlights' })).status,
      ).toBe(422);
      expect(
        (await a.client.post(`/v1/memories/${m.id}/ai-drafts`, { kind: 'summary' })).status,
      ).toBe(422);
      expect(
        (await sql('SELECT count(*)::int AS n FROM memory_ai_drafts WHERE memory_id = $1', [m.id]))
          .rows[0].n,
      ).toBe(0);
    } finally {
      rt().router.setRoute('summarise', undefined);
      rt().registry.unregister('memjunk');
    }
  });

  it('is unavailable (not faked) when AI is switched off', async () => {
    const off = await createTestApp({ MEDIA_LOCAL_DIR: dir, AI_ENABLED: 'false' });
    try {
      const a = await signup(off);
      await a.client.put('/v1/privacy/consents/ai_processing', { granted: true });
      const m = (await a.client.post('/v1/memories', { title: 'x' })).body;
      const r = await a.client.post(`/v1/memories/${m.id}/ai-drafts`, { kind: 'title' });
      expect([r.status, r.body.error.details?.reason]).toEqual([503, 'ai_unavailable']);
    } finally {
      await off.close();
    }
  });
});

describe('slideshow export', () => {
  it.runIf(hasFfmpeg)(
    "renders a real video from the owner's own photos into the owner's media, sharing nothing",
    async () => {
      const a = await signup(t);
      const b = await signup(t);
      await befriend(a, b);
      const imgs: string[] = [];
      for (const c of ['red', 'green', 'blue']) {
        const up = await upload(t, a, await png(c, 64));
        expect(up.status).toBe(201);
        imgs.push(up.body.id);
      }
      await getMediaRuntime(t.ctx).queue.idle();
      const p = await post(a, { body: 'with photos', mediaIds: [imgs[0]!], visibility: 'friends' });
      const m = await mem(a, {
        privacy: 'friends',
        items: [
          { type: 'post', id: p },
          { type: 'media', id: imgs[1]! },
          { type: 'media', id: imgs[2]! },
        ],
      });
      expect((await b.client.post(`/v1/memories/${m.id}/exports/slideshow`)).status).toBe(404);
      expect((await anon().post(`/v1/memories/${m.id}/exports/slideshow`)).status).toBe(401);
      const r = await a.client.post(`/v1/memories/${m.id}/exports/slideshow`);
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({
        kind: 'slideshow',
        images: 3,
        media: { kind: 'video', mimeType: 'video/mp4', purpose: 'attachment' },
      });
      const row = (await sql('SELECT owner_id FROM media WHERE id = $1', [r.body.media.id]))
        .rows[0];
      expect(row.owner_id).toBe(a.id);
      // the video is private to its owner: not attached to the memory or anything else
      expect((await b.client.get(`/v1/media/${r.body.media.id}`)).status).toBe(404);
      expect(await ids(a.client, m.id)).not.toContain(r.body.media.id);
      // a memory with no photos of mine
      const empty = await mem(a, { items: [{ type: 'moment', id: await moment(a) }] });
      expect((await a.client.post(`/v1/memories/${empty.id}/exports/slideshow`)).status).toBe(400);
    },
  );

  it('answers processing_unavailable (never a fake success) when ffmpeg is missing', async () => {
    const no = await createTestApp({
      MEDIA_LOCAL_DIR: dir,
      MEDIA_FFMPEG_PATH: '/nonexistent/ffmpeg',
    });
    try {
      const a = await signup(no);
      const m = (await a.client.post('/v1/memories', { title: 'x' })).body;
      const r = await a.client.post(`/v1/memories/${m.id}/exports/slideshow`);
      expect([r.status, r.body.error.details.reason]).toEqual([503, 'processing_unavailable']);
    } finally {
      await no.close();
    }
  });
});

describe('privacy: export, deletion, flag', () => {
  it("registers an export section with the person's own memories and suggestions state", async () => {
    const a = await signup(t);
    const p = await post(a);
    const m = await mem(a, { title: 'Export me', items: [{ type: 'post', id: p }] });
    await a.client.post('/v1/memory/suggestions/dismiss', { key: 'otd:01-01:2020' });
    const section = getExportSections().find((s) => s.key === 'memory')!;
    const data: any = await section.collect(t.ctx, t.ctx.db, a.id);
    expect(data.memories.find((x: any) => x.id === m.id)).toMatchObject({
      title: 'Export me',
      items: [{ type: 'post', id: p, position: 0 }],
    });
    expect(data.dismissedSuggestions).toHaveLength(1);
    expect(getExportSections().some((s) => s.key === 'real')).toBe(true);
    expect(getExportSections().some((s) => s.key === 'together')).toBe(true);
    const other: any = await section.collect(t.ctx, t.ctx.db, (await signup(t)).id);
    expect(other.memories).toEqual([]);
  });

  it("account deletion erases the person's memories and removes their content and links from other people's memories", async () => {
    const a = await signup(t);
    const b = await signup(t);
    await befriend(a, b);
    const ap = await post(a, { visibility: 'friends' });
    const bp = await post(b);
    const am = await mem(a, {
      title: 'Mine',
      summary: 'private words',
      items: [{ type: 'post', id: ap }],
      links: [{ type: 'person', id: b.id }],
    });
    const bm = await mem(b, {
      items: [
        { type: 'post', id: ap },
        { type: 'post', id: bp },
      ],
      links: [{ type: 'person', id: a.id }],
      privacy: 'friends',
    });
    await withTransaction(t.ctx.db, async (tx) => {
      for (const h of getDeletionHooks()) await h(t.ctx, tx, a.id);
    });
    const row = (
      await sql('SELECT title, summary, deleted_at FROM memories WHERE id = $1', [am.id])
    ).rows[0];
    expect(row).toMatchObject({ title: '', summary: '' });
    expect(row.deleted_at).not.toBeNull();
    expect(
      (await sql('SELECT count(*)::int AS n FROM memory_items WHERE memory_id = $1', [am.id]))
        .rows[0].n,
    ).toBe(0);
    expect(
      (await sql('SELECT count(*)::int AS n FROM memory_links WHERE memory_id = $1', [am.id]))
        .rows[0].n,
    ).toBe(0);
    expect(await ids(b.client, bm.id)).toEqual([bp]);
    expect(
      (await sql(`SELECT count(*)::int AS n FROM memory_links WHERE memory_id = $1`, [bm.id]))
        .rows[0].n,
    ).toBe(0);
  });

  it('deleting a source (Real, post) removes it from memories', async () => {
    const a = await signup(t);
    const r = await real(a);
    const p = await post(a);
    const m = await mem(a, {
      items: [
        { type: 'real_capture', id: r.id },
        { type: 'post', id: p },
      ],
    });
    await a.client.del(`/v1/real/captures/${r.id}`);
    await a.client.del(`/v1/posts/${p}`);
    expect((await a.client.get(`/v1/memories/${m.id}`)).body.items).toEqual([]);
    expect(
      (
        await sql(
          `SELECT count(*)::int AS n FROM memory_items WHERE item_type = 'real_capture' AND item_id = $1`,
          [r.id],
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it('audits sharing and unsharing; MEMORY off hides everything', async () => {
    const a = await signup(t);
    const m = await mem(a);
    await a.client.patch(`/v1/memories/${m.id}`, { privacy: 'friends' });
    await a.client.patch(`/v1/memories/${m.id}`, { privacy: 'friends' }); // no change: not audited again
    await a.client.patch(`/v1/memories/${m.id}`, { privacy: 'private' });
    expect(await auditCount(t, 'memory.shared', m.id)).toBe(1);
    expect(await auditCount(t, 'memory.unshared', m.id)).toBe(1);
    await setFlag('MEMORY', false);
    try {
      for (const [meth, url] of [
        ['get', '/v1/memories'],
        ['get', `/v1/memories/${m.id}`],
        ['post', '/v1/memories'],
        ['get', '/v1/memory/timeline'],
        ['get', '/v1/memory/on-this-day'],
        ['get', '/v1/memory/trips/suggestions'],
        ['get', `/v1/users/${a.username}/memories`],
      ] as const) {
        const r =
          meth === 'post' ? await a.client.post(url, { title: 'x' }) : await a.client.get(url);
        expect([r.status, r.body?.error?.code]).toEqual([404, 'feature_disabled']);
      }
      expect((await anon().get(`/v1/memories/${m.id}`)).status).toBe(404);
    } finally {
      await setFlag('MEMORY', true);
    }
    expect((await a.client.get(`/v1/memories/${m.id}`)).status).toBe(200);
  });
});
