import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chatJobHandlers, expireMessages } from '../src/lib/chat.ts';
import type { BuiltApp } from '../src/app.ts';
import { as, signUp, testApp, type TestUser, jobRunner, type JobRunner } from './helpers.ts';

let t: BuiltApp;
let runJobs: JobRunner;
beforeAll(async () => {
  t = await testApp();
  runJobs = await jobRunner(t.ctx.db);
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

async function direct(a: TestUser, b: TestUser): Promise<string> {
  await befriend(a, b);
  const r = await as(t.app, a).post('/v1/conversations', { memberIds: [b.id] });
  expect(r.status).toBe(201);
  return r.body.conversation.id;
}

/** A group owned (and administered) by `owner`. */
async function group(owner: TestUser, others: TestUser[]): Promise<string> {
  for (const o of others) await befriend(owner, o);
  const r = await as(t.app, owner).post('/v1/conversations', { memberIds: others.map((o) => o.id), title: 'Crew' });
  expect(r.status).toBe(201);
  return r.body.conversation.id;
}

async function send(from: TestUser, conversationId: string, body: string, extra: Record<string, unknown> = {}) {
  const r = await as(t.app, from).post(`/v1/conversations/${conversationId}/messages`, { body, clientId: `c-${Math.random()}`, ...extra });
  expect(r.status).toBe(201);
  return r.body.message as { id: string; expiresAt?: string; replyTo?: any; attachments: any[] };
}

const list = async (u: TestUser, conversationId: string) => {
  const r = await as(t.app, u).get(`/v1/conversations/${conversationId}/messages`);
  expect(r.status).toBe(200);
  return r.body.items as any[];
};

/** A photo stored like an upload, owned by `owner`. */
async function photo(owner: TestUser): Promise<{ id: string; path: string }> {
  const data = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#d21d4a' } })
    .jpeg()
    .toBuffer();
  const stored = await t.ctx.storage.put(data, 'jpg', 'image/jpeg');
  const { rows } = await db().query(
    `INSERT INTO media (owner_id, kind, url, mime, storage_key, status) VALUES ($1,'image',$2,'image/jpeg',$3,'ready') RETURNING id`,
    [owner.id, stored.url, stored.key],
  );
  return { id: rows[0].id, path: `/media/${stored.key}` };
}

const fetchMedia = async (p: string) => (await t.app.inject({ method: 'GET', url: p })).statusCode;

describe('Replies', () => {
  it('quotes a message from the same chat and refuses one from another chat', async () => {
    const [a, b, c] = [await adult(), await adult(), await adult()];
    const convo = await direct(a, b);
    const other = await direct(a, c);
    const original = await send(b, convo, 'Dinner at 8?');
    const elsewhere = await send(c, other, 'Secret plans');

    const reply = await send(a, convo, 'Sounds good', { replyToId: original.id });
    expect(reply.replyTo).toMatchObject({ id: original.id, available: true, body: 'Dinner at 8?', sender: { id: b.id } });

    const wrong = await as(t.app, a).post(`/v1/conversations/${convo}/messages`, { body: 'Hm', replyToId: elsewhere.id });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('reply_unavailable');
    // b isn't in the other chat, so can't quote it either.
    expect((await as(t.app, b).post(`/v1/conversations/${convo}/messages`, { body: 'x', replyToId: elsewhere.id })).status).toBe(400);

    const items = await list(b, convo);
    expect(items.find((m) => m.id === reply.id).replyTo).toMatchObject({ id: original.id, body: 'Dinner at 8?' });
  });
});

describe('Editing', () => {
  it('lets only the sender edit, within 15 minutes, and tells everyone', async () => {
    const [a, b, stranger] = [await adult(), await adult(), await adult()];
    const convo = await direct(a, b);
    const m = await send(a, convo, 'See you at 7');
    const live = connect(b);

    expect((await as(t.app, stranger).patch(`/v1/messages/${m.id}`, { body: 'hijacked' })).status).toBe(404);
    const notMine = await as(t.app, b).patch(`/v1/messages/${m.id}`, { body: 'changed' });
    expect(notMine.status).toBe(403);
    expect(notMine.body.error.code).toBe('not_sender');

    const ok = await as(t.app, a).patch(`/v1/messages/${m.id}`, { body: 'See you at 8' });
    expect(ok.status).toBe(200);
    expect(ok.body.message).toMatchObject({ body: 'See you at 8' });
    expect(ok.body.message.editedAt).toBeTruthy();
    expect(live.of('message.edited')).toEqual([expect.objectContaining({ data: expect.objectContaining({ id: m.id, body: 'See you at 8' }) })]);
    live.remove();
    expect((await list(b, convo)).find((x) => x.id === m.id)).toMatchObject({ body: 'See you at 8', editedAt: expect.any(String) });
    // The earlier text is kept for safety reports.
    expect((await db().query(`SELECT body FROM message_edits WHERE message_id = $1`, [m.id])).rows).toEqual([{ body: 'See you at 7' }]);

    await db().query(`UPDATE messages SET created_at = now() - interval '16 minutes' WHERE id = $1`, [m.id]);
    const late = await as(t.app, a).patch(`/v1/messages/${m.id}`, { body: 'Too late' });
    expect(late.status).toBe(403);
    expect(late.body.error.code).toBe('edit_window_closed');
  });
});

describe('Unsend and delete for me', () => {
  it('unsend leaves a placeholder for everyone and takes back the attachment', async () => {
    const [a, b, stranger] = [await adult(), await adult(), await adult()];
    const convo = await direct(a, b);
    const pic = await photo(a);
    const m = await send(a, convo, 'Look at this', { attachments: [{ mediaId: pic.id }] });
    await as(t.app, b).put(`/v1/messages/${m.id}/reactions/${encodeURIComponent('+1')}`);
    expect(await fetchMedia(pic.path)).toBe(200);
    const live = connect(b);

    expect((await as(t.app, stranger).post(`/v1/messages/${m.id}/unsend`)).status).toBe(404);
    const notMine = await as(t.app, b).post(`/v1/messages/${m.id}/unsend`);
    expect(notMine.status).toBe(403);

    const ok = await as(t.app, a).post(`/v1/messages/${m.id}/unsend`);
    expect(ok.status).toBe(200);
    expect(ok.body.message).toMatchObject({ id: m.id, unsent: true, body: '', attachments: [] });
    expect(live.of('message.unsent')).toHaveLength(1);
    live.remove();

    const seen = (await list(b, convo)).find((x) => x.id === m.id);
    expect(seen).toMatchObject({ unsent: true, body: '', attachments: [] });
    expect(seen.reactions).toBeUndefined();
    // The file's address no longer works, for anyone.
    expect(await fetchMedia(pic.path)).toBe(404);
    expect((await db().query(`SELECT deleted_at FROM media WHERE id = $1`, [pic.id])).rows[0].deleted_at).not.toBeNull();
    // And it can't be sent again.
    expect((await as(t.app, a).post(`/v1/conversations/${convo}/messages`, { body: '', attachments: [{ mediaId: pic.id }] })).status).toBe(404);
    // Nobody can reply to it or react to it any more.
    expect((await as(t.app, b).post(`/v1/conversations/${convo}/messages`, { body: 'Wait', replyToId: m.id })).status).toBe(400);
    expect((await as(t.app, b).put(`/v1/messages/${m.id}/reactions/ok`)).status).toBe(404);
  });

  it('keeps a file that is still used in another message', async () => {
    const [a, b] = [await adult(), await adult()];
    const convo = await direct(a, b);
    const pic = await photo(a);
    const first = await send(a, convo, '', { attachments: [{ mediaId: pic.id }] });
    await send(a, convo, 'Again', { attachments: [{ mediaId: pic.id }] });
    expect((await as(t.app, a).del(`/v1/messages/${first.id}`)).status).toBe(200);
    expect(await fetchMedia(pic.path)).toBe(200);
  });

  it('delete for me hides it only for you', async () => {
    const [a, b, stranger] = [await adult(), await adult(), await adult()];
    const convo = await direct(a, b);
    const m = await send(a, convo, 'Only mine to hide');
    expect((await as(t.app, stranger).post(`/v1/messages/${m.id}/delete-for-me`)).status).toBe(404);
    expect((await as(t.app, b).post(`/v1/messages/${m.id}/delete-for-me`)).status).toBe(200);
    expect((await list(b, convo)).some((x) => x.id === m.id)).toBe(false);
    expect((await list(a, convo)).find((x) => x.id === m.id)).toMatchObject({ body: 'Only mine to hide' });
  });
});

describe('Reactions', () => {
  it('shows counts to members and only members can react', async () => {
    const [a, b, stranger] = [await adult(), await adult(), await adult()];
    const convo = await direct(a, b);
    const m = await send(a, convo, 'Party');
    const party = encodeURIComponent('🎉');
    expect((await as(t.app, stranger).put(`/v1/messages/${m.id}/reactions/${party}`)).status).toBe(404);
    expect((await as(t.app, b).put(`/v1/messages/${m.id}/reactions/${party}`)).status).toBe(200);
    expect((await as(t.app, a).put(`/v1/messages/${m.id}/reactions/${party}`)).status).toBe(200);
    expect((await list(b, convo)).find((x) => x.id === m.id).reactions).toEqual([{ emoji: '🎉', count: 2, mine: true }]);
    expect((await as(t.app, b).del(`/v1/messages/${m.id}/reactions/${party}`)).status).toBe(200);
    expect((await list(b, convo)).find((x) => x.id === m.id).reactions).toEqual([{ emoji: '🎉', count: 1, mine: false }]);
  });
});

describe('Pins', () => {
  it('pins up to 3 in a one-to-one chat, by either person', async () => {
    const [a, b, stranger] = [await adult(), await adult(), await adult()];
    const convo = await direct(a, b);
    const ms: { id: string }[] = [];
    for (let i = 0; i < 4; i++) ms.push(await send(a, convo, `Message ${i}`));
    expect((await as(t.app, stranger).put(`/v1/messages/${ms[0]!.id}/pin`)).status).toBe(404);
    expect((await as(t.app, stranger).get(`/v1/conversations/${convo}/pins`)).status).toBe(404);
    expect((await as(t.app, b).put(`/v1/messages/${ms[0]!.id}/pin`)).status).toBe(200);
    expect((await as(t.app, a).put(`/v1/messages/${ms[1]!.id}/pin`)).status).toBe(200);
    expect((await as(t.app, a).put(`/v1/messages/${ms[2]!.id}/pin`)).status).toBe(200);
    // Pinning one that's already pinned is fine.
    expect((await as(t.app, a).put(`/v1/messages/${ms[2]!.id}/pin`)).status).toBe(200);
    const full = await as(t.app, a).put(`/v1/messages/${ms[3]!.id}/pin`);
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe('pins_full');

    const pins = await as(t.app, b).get(`/v1/conversations/${convo}/pins`);
    expect(pins.body.items.map((p: any) => p.message.body)).toEqual(['Message 2', 'Message 1', 'Message 0']);
    expect((await list(b, convo)).find((x) => x.id === ms[0]!.id).pinned).toBe(true);

    expect((await as(t.app, b).del(`/v1/messages/${ms[0]!.id}/pin`)).status).toBe(200);
    expect((await as(t.app, a).put(`/v1/messages/${ms[3]!.id}/pin`)).status).toBe(200);
    // Unsending a pinned message unpins it.
    await as(t.app, a).post(`/v1/messages/${ms[3]!.id}/unsend`);
    expect((await as(t.app, a).get(`/v1/conversations/${convo}/pins`)).body.items).toHaveLength(2);
  });

  it('only group admins pin in groups', async () => {
    const [owner, member] = [await adult(), await adult()];
    const convo = await group(owner, [member]);
    const m = await send(member, convo, 'Meeting notes');
    const denied = await as(t.app, member).put(`/v1/messages/${m.id}/pin`);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('admins_only');
    expect((await as(t.app, owner).put(`/v1/messages/${m.id}/pin`)).status).toBe(200);
    expect((await as(t.app, member).del(`/v1/messages/${m.id}/pin`)).status).toBe(403);
  });
});

describe('Search in a chat', () => {
  it('finds what the member can see, since they joined', async () => {
    const [owner, early, late, stranger] = [await adult(), await adult(), await adult(), await adult()];
    const convo = await group(owner, [early]);
    await db().query(`UPDATE conversation_members SET joined_at = now() - interval '2 hours' WHERE conversation_id = $1`, [convo]);
    const before = await send(owner, convo, 'The pizza place before you joined');
    await db().query(`UPDATE messages SET created_at = now() - interval '1 hour' WHERE id = $1`, [before.id]);
    await befriend(owner, late);
    expect((await as(t.app, owner).post(`/v1/conversations/${convo}/members`, { userIds: [late.id] })).status).toBe(200);
    const after = await send(early, convo, 'Pizza tonight?');
    const hidden = await send(owner, convo, 'Pizza is overrated');
    const unsent = await send(owner, convo, 'pizza typo');
    await as(t.app, owner).post(`/v1/messages/${unsent.id}/unsend`);
    await as(t.app, late).post(`/v1/messages/${hidden.id}/delete-for-me`);
    await send(owner, convo, '100% sure');
    // Another chat with the same word.
    const elsewhere = await direct(owner, stranger);
    await send(owner, elsewhere, 'Pizza elsewhere');

    const lateResults = await as(t.app, late).get(`/v1/conversations/${convo}/search?q=pizza`);
    expect(lateResults.status).toBe(200);
    expect(lateResults.body.items.map((m: any) => m.id)).toEqual([after.id]);

    const earlyResults = await as(t.app, early).get(`/v1/conversations/${convo}/search?q=PIZZA`);
    expect(earlyResults.body.items.map((m: any) => m.id)).toEqual([hidden.id, after.id, before.id]);

    // Wildcards are searched as text.
    expect((await as(t.app, early).get(`/v1/conversations/${convo}/search?q=${encodeURIComponent('%')}`)).body.items).toHaveLength(1);
    expect((await as(t.app, stranger).get(`/v1/conversations/${convo}/search?q=pizza`)).status).toBe(404);
  });
});

describe('Disappearing messages', () => {
  it('group admins change it, a line tells everyone, and new messages expire', async () => {
    const [owner, member, stranger] = [await adult(), await adult(), await adult()];
    const convo = await group(owner, [member]);
    const live = connect(member);

    expect((await as(t.app, stranger).put(`/v1/conversations/${convo}/disappearing`, { seconds: 86400 })).status).toBe(404);
    const denied = await as(t.app, member).put(`/v1/conversations/${convo}/disappearing`, { seconds: 86400 });
    expect(denied.status).toBe(403);
    expect((await as(t.app, owner).put(`/v1/conversations/${convo}/disappearing`, { seconds: 3600 })).status).toBe(400);

    const on = await as(t.app, owner).put(`/v1/conversations/${convo}/disappearing`, { seconds: 86400 });
    expect(on.status).toBe(200);
    expect(on.body.message).toMatchObject({ kind: 'system', system: { type: 'disappearing', seconds: 86400 }, sender: { id: owner.id } });
    expect(live.of('message.created').map((e) => e.data.kind)).toEqual(['system']);
    expect(live.of('conversation.updated')[0]!.data).toEqual({ id: convo, disappearingSeconds: 86400 });
    expect((await as(t.app, member).get(`/v1/conversations/${convo}`)).body.conversation.disappearingSeconds).toBe(86400);

    const pic = await photo(member);
    const m = await send(member, convo, 'Gone tomorrow', { attachments: [{ mediaId: pic.id }] });
    const hours = (new Date(m.expiresAt!).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThan(24.1);
    const job = (await db().query(`SELECT id FROM jobs WHERE kind = 'messages.expire' AND payload->>'messageId' = $1`, [m.id])).rows[0];
    expect(job).toBeTruthy();

    // A day later: the job deletes it and its file.
    await db().query(`UPDATE messages SET expires_at = now() - interval '1 second' WHERE id = $1`, [m.id]);
    await db().query(`UPDATE jobs SET run_at = now() WHERE id = $1`, [job.id]);
    const deps = { db: db(), config: t.ctx.config, storage: t.ctx.storage, realtime: t.ctx.realtime };
    await runJobs(chatJobHandlers(deps));
    expect((await db().query(`SELECT 1 FROM messages WHERE id = $1`, [m.id])).rowCount).toBe(0);
    expect(await fetchMedia(pic.path)).toBe(404);
    expect(live.of('message.deleted').map((e) => e.data.id)).toContain(m.id);
    expect((await list(owner, convo)).some((x) => x.id === m.id)).toBe(false);
    live.remove();

    // Turning it off: later messages stay.
    const off = await as(t.app, owner).put(`/v1/conversations/${convo}/disappearing`, { seconds: null });
    expect(off.body.message.system).toEqual({ type: 'disappearing', seconds: null });
    const kept = await send(member, convo, 'Here to stay');
    expect(kept.expiresAt).toBeUndefined();
    expect(await expireMessages(deps)).toBe(0);
  });

  it('either person in a one-to-one chat can change it', async () => {
    const [a, b] = [await adult(), await adult()];
    const convo = await direct(a, b);
    expect((await as(t.app, b).put(`/v1/conversations/${convo}/disappearing`, { seconds: 604800 })).status).toBe(200);
    // The same setting again adds no line.
    expect((await as(t.app, a).put(`/v1/conversations/${convo}/disappearing`, { seconds: 604800 })).body.message).toBeNull();
    // Expired but not yet swept: already hidden.
    const m = await send(a, convo, 'Blink');
    await db().query(`UPDATE messages SET expires_at = now() - interval '1 second' WHERE id = $1`, [m.id]);
    expect((await list(b, convo)).some((x) => x.id === m.id)).toBe(false);
  });
});
