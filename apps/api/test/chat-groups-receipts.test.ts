import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuiltApp } from '../src/app.ts';
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

async function befriend(a: TestUser, b: TestUser) {
  const [x, y] = [a.id, b.id].sort();
  await db().query(`INSERT INTO friendships (user_a, user_b) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [x, y]);
}

/** A fake connected device: records every realtime event the user gets. */
function connect(u: TestUser) {
  const events: { type: string; data: any }[] = [];
  const remove = t.ctx.realtime.add(u.id, { readyState: 1, send: (raw: string) => void events.push(JSON.parse(raw)) });
  return { events, remove, of: (type: string) => events.filter((e) => e.type === type) };
}

async function group(owner: TestUser, others: TestUser[]): Promise<string> {
  for (const o of others) await befriend(owner, o);
  const r = await as(t.app, owner).post('/v1/conversations', { memberIds: others.map((o) => o.id), title: 'Crew' });
  expect(r.status).toBe(201);
  return r.body.conversation.id;
}

const lines = async (u: TestUser, conversationId: string) => {
  const r = await as(t.app, u).get(`/v1/conversations/${conversationId}/messages`);
  expect(r.status).toBe(200);
  return (r.body.items as any[]).filter((m) => m.system?.type === 'group').map((m) => m.system);
};

describe('group members and admins', () => {
  it('renames, adds, removes and chooses admins, each with a line in the chat', async () => {
    const [ada, bo, cy, di] = [await adult(), await adult(), await adult(), await adult()];
    const g = await group(ada, [bo, cy]);
    const boLive = connect(bo);

    // Only admins rename.
    expect((await as(t.app, bo).patch(`/v1/conversations/${g}`, { title: 'Mine now' })).status).toBe(403);
    const renamed = await as(t.app, ada).patch(`/v1/conversations/${g}`, { title: 'Weekend' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.conversation.title).toBe('Weekend');
    expect(renamed.body.message.system).toMatchObject({ type: 'group', action: 'renamed', title: 'Weekend' });
    expect(boLive.of('conversation.changed').some((e) => e.data.id === g)).toBe(true);
    expect((await as(t.app, ada).patch(`/v1/conversations/${g}`, { title: '  ' })).status).toBe(400);

    // Anyone in it adds people (the rules for messaging them apply).
    await befriend(bo, di);
    const diLive = connect(di);
    const added = await as(t.app, bo).post(`/v1/conversations/${g}/members`, { userIds: [di.id, cy.id] });
    expect(added.status).toBe(200);
    expect(added.body.added).toBe(1);
    expect(added.body.message.system).toMatchObject({ type: 'group', action: 'added', people: [{ id: di.id }] });
    expect(diLive.of('conversation.created').some((e) => e.data.id === g)).toBe(true);

    // Only admins remove people and choose admins.
    expect((await as(t.app, bo).del(`/v1/conversations/${g}/members/${cy.id}`)).status).toBe(403);
    expect((await as(t.app, bo).put(`/v1/conversations/${g}/members/${bo.id}/role`, { role: 'admin' })).status).toBe(403);
    const cyLive = connect(cy);
    const removed = await as(t.app, ada).del(`/v1/conversations/${g}/members/${cy.id}`);
    expect(removed.status).toBe(200);
    expect(cyLive.of('conversation.removed').some((e) => e.data.id === g)).toBe(true);
    expect((await as(t.app, cy).get(`/v1/conversations/${g}/messages`)).status).toBe(404);
    expect((await as(t.app, ada).del(`/v1/conversations/${g}/members/${ada.id}`)).status).toBe(400);

    const made = await as(t.app, ada).put(`/v1/conversations/${g}/members/${bo.id}/role`, { role: 'admin' });
    expect(made.status).toBe(200);
    expect(made.body.conversation.adminIds.sort()).toEqual([ada.id, bo.id].sort());
    // A group keeps at least one admin.
    expect((await as(t.app, bo).put(`/v1/conversations/${g}/members/${ada.id}/role`, { role: 'member' })).status).toBe(200);
    const last = await as(t.app, bo).put(`/v1/conversations/${g}/members/${bo.id}/role`, { role: 'member' });
    expect(last.status).toBe(409);
    expect(last.body.error.code).toBe('last_admin');

    const said = (await lines(bo, g)).map((s) => s.action);
    expect(said).toEqual(['renamed', 'added', 'removed', 'admin', 'unadmin']);
  });

  it('when the last admin leaves, whoever has been there longest becomes one', async () => {
    const [ada, bo, cy] = [await adult(), await adult(), await adult()];
    const g = await group(ada, [bo, cy]);
    // Bo joined before Cy (same insert: order by id); make it certain.
    await db().query(`UPDATE conversation_members SET joined_at = now() - interval '1 hour' WHERE conversation_id = $1 AND user_id = $2`, [g, bo.id]);
    expect((await as(t.app, ada).post(`/v1/conversations/${g}/leave`)).status).toBe(200);
    const conv = await as(t.app, bo).get(`/v1/conversations/${g}`);
    expect(conv.body.conversation.myRole).toBe('admin');
    expect(conv.body.conversation.adminIds).toEqual([bo.id]);
    const said = await lines(bo, g);
    expect(said.map((s) => s.action)).toEqual(['left', 'promoted']);
    expect(said[1].people).toEqual([{ id: bo.id, displayName: expect.any(String) }]);
    // Leaving as a member leaves the admins as they are.
    expect((await as(t.app, cy).post(`/v1/conversations/${g}/leave`)).status).toBe(200);
    expect((await as(t.app, bo).get(`/v1/conversations/${g}`)).body.conversation.adminIds).toEqual([bo.id]);
  });

  it('someone coming back is a member again, and people with a block between them are not put together', async () => {
    const [ada, bo, cy] = [await adult(), await adult(), await adult()];
    const g = await group(ada, [bo]);
    await as(t.app, ada).put(`/v1/conversations/${g}/members/${bo.id}/role`, { role: 'admin' });
    await as(t.app, bo).post(`/v1/conversations/${g}/leave`);
    expect((await as(t.app, ada).post(`/v1/conversations/${g}/members`, { userIds: [bo.id] })).status).toBe(200);
    expect((await as(t.app, bo).get(`/v1/conversations/${g}`)).body.conversation.myRole).toBe('member');

    await befriend(ada, cy);
    await as(t.app, cy).post(`/v1/users/${bo.id}/block`);
    const r = await as(t.app, ada).post(`/v1/conversations/${g}/members`, { userIds: [cy.id] });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('blocked_in_group');
  });
});

describe('read receipts', () => {
  it('say how far the others have read, live, and never across a block', async () => {
    const [ada, bo] = [await adult(), await adult()];
    await befriend(ada, bo);
    const c = (await as(t.app, ada).post('/v1/conversations', { memberIds: [bo.id] })).body.conversation.id;
    const sent = await as(t.app, ada).post(`/v1/conversations/${c}/messages`, { body: 'hi', clientId: 'r1' });
    const adaLive = connect(ada);
    let conv = (await as(t.app, ada).get(`/v1/conversations/${c}`)).body.conversation;
    expect(conv.readBy).toHaveLength(1);
    expect(conv.readBy[0].lastReadAt < sent.body.message.createdAt).toBe(true);

    expect((await as(t.app, bo).post(`/v1/conversations/${c}/read`)).status).toBe(200);
    const read = adaLive.of('conversation.read').find((e) => e.data.conversationId === c);
    expect(read?.data.userId).toBe(bo.id);
    conv = (await as(t.app, ada).get(`/v1/conversations/${c}`)).body.conversation;
    expect(conv.readBy[0].lastReadAt >= sent.body.message.createdAt).toBe(true);

    await as(t.app, bo).post(`/v1/users/${ada.id}/block`);
    adaLive.events.length = 0;
    await as(t.app, bo).post(`/v1/conversations/${c}/read`);
    expect(adaLive.of('conversation.read')).toHaveLength(0);
    expect((await as(t.app, ada).get(`/v1/conversations/${c}`)).body.conversation.readBy).toEqual([]);
  });

  it('can be turned off, and then go neither way', async () => {
    const [ada, bo] = [await adult(), await adult()];
    await befriend(ada, bo);
    const c = (await as(t.app, ada).post('/v1/conversations', { memberIds: [bo.id] })).body.conversation.id;
    await as(t.app, ada).post(`/v1/conversations/${c}/messages`, { body: 'hi', clientId: 'r2' });
    expect((await as(t.app, bo).get('/v1/me/interactions')).body.settings.readReceipts).toBe(true);
    expect((await as(t.app, bo).put('/v1/me/interactions', { readReceipts: false })).body.settings.readReceipts).toBe(false);

    // Bo's reads aren't shown to Ada, live or later.
    const adaLive = connect(ada);
    await as(t.app, bo).post(`/v1/conversations/${c}/read`);
    expect(adaLive.of('conversation.read')).toHaveLength(0);
    expect((await as(t.app, ada).get(`/v1/conversations/${c}`)).body.conversation.readBy).toEqual([]);
    // And Bo doesn't see Ada's.
    await as(t.app, ada).post(`/v1/conversations/${c}/read`);
    expect((await as(t.app, bo).get(`/v1/conversations/${c}`)).body.conversation.readBy).toEqual([]);

    await as(t.app, bo).put('/v1/me/interactions', { readReceipts: true });
    expect((await as(t.app, ada).get(`/v1/conversations/${c}`)).body.conversation.readBy).toHaveLength(1);
    expect((await as(t.app, bo).get(`/v1/conversations/${c}`)).body.conversation.readBy).toHaveLength(1);
  });
});

describe('reactions', () => {
  it('are one emoji, never words', async () => {
    const [ada, bo] = [await adult(), await adult()];
    await befriend(ada, bo);
    const c = (await as(t.app, ada).post('/v1/conversations', { memberIds: [bo.id] })).body.conversation.id;
    const m = (await as(t.app, ada).post(`/v1/conversations/${c}/messages`, { body: 'hi', clientId: 'x1' })).body.message.id;
    for (const emoji of ['❤️', '👍🏽', '🇳🇬', '👨‍👩‍👧'])
      expect((await as(t.app, bo).put(`/v1/messages/${m}/reactions/${encodeURIComponent(emoji)}`)).status).toBe(200);
    for (const text of ['hello', '<b>', '1', 'ok👍'])
      expect((await as(t.app, bo).put(`/v1/messages/${m}/reactions/${encodeURIComponent(text)}`)).status).toBe(400);
  });
});
