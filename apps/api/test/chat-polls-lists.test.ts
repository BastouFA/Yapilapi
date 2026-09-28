import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chatJobHandlers } from '../src/lib/chat.ts';
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
const inMinutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();

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
  const r = await as(t.app, owner).post('/v1/conversations', { memberIds: others.map((o) => o.id), title: 'Trip' });
  expect(r.status).toBe(201);
  return r.body.conversation.id;
}

async function poll(u: TestUser, conversationId: string, extra: Record<string, unknown> = {}) {
  const r = await as(t.app, u).post(`/v1/conversations/${conversationId}/polls`, {
    question: 'Where do we eat?',
    options: ['Mama Put', 'Suya spot', 'Home'],
    ...extra,
  });
  expect(r.status).toBe(201);
  return r.body.message as { id: string; poll: any; expiresAt?: string };
}

async function checklist(u: TestUser, conversationId: string, items: string[] = ['Tickets', 'Snacks']) {
  const r = await as(t.app, u).post(`/v1/conversations/${conversationId}/lists`, { title: 'Beach day', items });
  expect(r.status).toBe(201);
  return r.body.message as { id: string; list: any };
}

const vote = (u: TestUser, messageId: string, optionIds: string[]) => as(t.app, u).put(`/v1/messages/${messageId}/poll/vote`, { optionIds });
const messages = async (u: TestUser, conversationId: string) => (await as(t.app, u).get(`/v1/conversations/${conversationId}/messages`)).body.items as any[];
const handlers = () => chatJobHandlers({ db: db(), config: t.ctx.config, storage: t.ctx.storage, realtime: t.ctx.realtime });

/** Make the queued jobs of a kind (for this payload key and value) due now, and run them. */
async function runDue(kind: string, key: string, value: string) {
  await db().query(`UPDATE jobs SET run_at = now() WHERE kind = $1 AND payload->>$2 = $3 AND status = 'queued'`, [kind, key, value]);
  for (let i = 0; i < 10; i++) if (!(await runJobs(handlers(), 20))) return;
}

describe('Polls', () => {
  it('shows as a message; only members can make one, see it or vote', async () => {
    const [a, b, stranger] = [await adult(), await adult(), await adult()];
    const convo = await direct(a, b);
    const live = connect(b);
    const outsider = connect(stranger);

    expect((await as(t.app, stranger).post(`/v1/conversations/${convo}/polls`, { question: 'Hm?', options: ['x', 'y'] })).status).toBe(404);
    const tooFew = await as(t.app, a).post(`/v1/conversations/${convo}/polls`, { question: 'Hm?', options: ['x'] });
    expect(tooFew.status).toBe(400);
    const same = await as(t.app, a).post(`/v1/conversations/${convo}/polls`, { question: 'Hm?', options: ['Yes', 'yes'] });
    expect(same.status).toBe(400);
    const soon = await as(t.app, a).post(`/v1/conversations/${convo}/polls`, { question: 'Hm?', options: ['x', 'y'], endsAt: inMinutes(1) });
    expect(soon.body.error.code).toBe('poll_end_time');

    const m = await poll(a, convo);
    expect(m.poll).toMatchObject({ question: 'Where do we eat?', multiple: false, anonymous: false, ended: false, voterCount: 0 });
    expect(m.poll.options.map((o: any) => o.text)).toEqual(['Mama Put', 'Suya spot', 'Home']);
    expect(live.of('message.created').map((e) => e.data.id)).toContain(m.id);
    expect(outsider.events).toEqual([]);

    // It reads like a message elsewhere: the preview is the question, marked as a poll.
    const fromB = (await messages(b, convo)).find((x) => x.id === m.id);
    expect(fromB.body).toBe('Where do we eat?');
    expect(fromB.poll.options).toHaveLength(3);
    const reply = await as(t.app, b).post(`/v1/conversations/${convo}/messages`, { body: 'Suya obviously', replyToId: m.id });
    expect(reply.body.message.replyTo).toMatchObject({ id: m.id, body: 'Where do we eat?', kind: 'poll' });

    expect((await vote(stranger, m.id, [m.poll.options[0].id])).status).toBe(404);
    // The question can't be edited after people answered it.
    expect((await as(t.app, a).patch(`/v1/messages/${m.id}`, { body: 'Changed' })).body.error.code).toBe('not_editable');

    // Someone who left the chat can't vote anymore.
    await as(t.app, b).post(`/v1/conversations/${convo}/leave`);
    expect((await vote(b, m.id, [m.poll.options[0].id])).status).toBe(404);
    live.remove();
    outsider.remove();
  });

  it('single choice: one option, change it until the poll ends, take it back', async () => {
    const [a, b, c] = [await adult(), await adult(), await adult()];
    const convo = await group(a, [b, c]);
    const m = await poll(a, convo);
    const [x, y] = m.poll.options.map((o: any) => o.id);

    const first = await vote(b, m.id, [x]);
    expect(first.status).toBe(200);
    expect(first.body.poll.options[0]).toMatchObject({ votes: 1, mine: true, voters: [expect.objectContaining({ id: b.id })] });
    const two = await vote(b, m.id, [x, y]);
    expect(two.status).toBe(400);
    expect(two.body.error.code).toBe('single_choice');
    expect((await vote(b, m.id, ['00000000-0000-4000-8000-000000000000'])).body.error.code).toBe('unknown_option');

    const changed = await vote(b, m.id, [y]);
    expect(changed.body.poll.options.map((o: any) => [o.votes, o.mine])).toEqual([
      [0, false],
      [1, true],
      [0, false],
    ]);
    await vote(c, m.id, [y]);
    // Everyone sees who voted for what (it isn't anonymous), and their own choice.
    const seenByA = (await messages(a, convo)).find((z) => z.id === m.id).poll;
    expect(seenByA.voterCount).toBe(2);
    expect(seenByA.options[1].voters.map((v: any) => v.id).sort()).toEqual([b.id, c.id].sort());
    expect(seenByA.options.some((o: any) => o.mine)).toBe(false);

    const back = await vote(c, m.id, []);
    expect(back.body.poll.voterCount).toBe(1);
    expect(back.body.poll.options[1]).toMatchObject({ votes: 1, mine: false });

    // Only the person who made it can end it early; then nobody can vote.
    expect((await as(t.app, b).post(`/v1/messages/${m.id}/poll/end`)).body.error.code).toBe('not_poll_creator');
    const ended = await as(t.app, a).post(`/v1/messages/${m.id}/poll/end`);
    expect(ended.body.poll).toMatchObject({ ended: true, endedAt: expect.any(String) });
    const late = await vote(c, m.id, [x]);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('poll_ended');
  });

  it('multiple choice and anonymous voting', async () => {
    const [a, b, c] = [await adult(), await adult(), await adult()];
    const convo = await group(a, [b, c]);
    const m = await poll(a, convo, { multiple: true, anonymous: true });
    const [x, y, z] = m.poll.options.map((o: any) => o.id);

    const r = await vote(b, m.id, [x, y]);
    expect(r.status).toBe(200);
    expect(r.body.poll.options.map((o: any) => o.mine)).toEqual([true, true, false]);
    await vote(c, m.id, [y, z]);
    // Counts for everyone, and no names for anyone, not even the person who made it.
    for (const u of [a, b, c]) {
      const p = (await messages(u, convo)).find((q) => q.id === m.id).poll;
      expect(p.anonymous).toBe(true);
      expect(p.voterCount).toBe(2);
      expect(p.options.map((o: any) => o.votes)).toEqual([1, 2, 1]);
      expect(p.options.every((o: any) => o.voters === undefined)).toBe(true);
    }
    // The realtime update doesn't name anyone either.
    const live = connect(a);
    await vote(b, m.id, [z]);
    const update = live.of('poll.updated').at(-1)!;
    expect(update.data.poll.options.map((o: any) => o.votes)).toEqual([0, 1, 2]);
    expect(JSON.stringify(update.data)).not.toContain(b.id);
    live.remove();
  });

  it('adding options: the creator, or anyone when allowed; up to 10, no duplicates', async () => {
    const [a, b] = [await adult(), await adult()];
    const convo = await group(a, [b]);
    const closed = await poll(a, convo);
    const refused = await as(t.app, b).post(`/v1/messages/${closed.id}/poll/options`, { text: 'Pizza' });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('options_closed');
    expect((await as(t.app, a).post(`/v1/messages/${closed.id}/poll/options`, { text: 'Pizza' })).status).toBe(200);

    const open = await poll(a, convo, { allowAddOptions: true });
    const added = await as(t.app, b).post(`/v1/messages/${open.id}/poll/options`, { text: 'Jollof place' });
    expect(added.status).toBe(200);
    expect(added.body.poll.options.at(-1)).toMatchObject({ text: 'Jollof place', addedBy: b.id, votes: 0 });
    expect((await as(t.app, b).post(`/v1/messages/${open.id}/poll/options`, { text: 'jollof place' })).body.error.code).toBe('option_exists');
    for (let i = 0; i < 6; i++) expect((await as(t.app, b).post(`/v1/messages/${open.id}/poll/options`, { text: `Place ${i}` })).status).toBe(200);
    const full = await as(t.app, b).post(`/v1/messages/${open.id}/poll/options`, { text: 'One more' });
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe('poll_full');
  });

  it('ends by itself at its time, through the job', async () => {
    const [a, b] = [await adult(), await adult()];
    const convo = await direct(a, b);
    const m = await poll(a, convo, { endsAt: inMinutes(60) });
    expect(m.poll.endsAt).toBeTruthy();
    const live = connect(b);
    await db().query(`UPDATE chat_polls SET ends_at = now() - interval '1 second' WHERE message_id = $1`, [m.id]);
    await runDue('chat.poll.end', 'messageId', m.id);
    expect((await db().query(`SELECT ended_at FROM chat_polls WHERE message_id = $1`, [m.id])).rows[0].ended_at).toBeTruthy();
    expect(live.of('poll.updated').at(-1)?.data).toMatchObject({ id: m.id, poll: { ended: true } });
    expect((await vote(b, m.id, [m.poll.options[0].id])).body.error.code).toBe('poll_ended');
    live.remove();
  });

  it('sends live results only to members, each with their own choice, and not to people who blocked the creator', async () => {
    const [a, b, c, blocker, stranger] = [await adult(), await adult(), await adult(), await adult(), await adult()];
    const convo = await group(a, [b, c, blocker]);
    const m = await poll(a, convo);
    await db().query(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [blocker.id, a.id]);
    const [lb, lc, lblocker, lstranger] = [connect(b), connect(c), connect(blocker), connect(stranger)];

    await vote(b, m.id, [m.poll.options[0].id]);
    expect(lb.of('poll.updated').at(-1)!.data.poll.options[0]).toMatchObject({ votes: 1, mine: true });
    expect(lc.of('poll.updated').at(-1)!.data.poll.options[0]).toMatchObject({ votes: 1, mine: false });
    expect(lblocker.of('poll.updated')).toEqual([]);
    expect(lstranger.events).toEqual([]);
    // Votes don't send notifications.
    expect((await db().query(`SELECT 1 FROM notifications WHERE user_id = $1 AND actor_id = $2`, [a.id, b.id])).rowCount).toBe(0);
    // And someone who blocked the creator can't act on the poll.
    expect((await vote(blocker, m.id, [m.poll.options[0].id])).status).toBe(404);
    for (const l of [lb, lc, lblocker, lstranger]) l.remove();
  });

  it('in a one-to-one chat, a block stops polls and votes both ways', async () => {
    const [a, b] = [await adult(), await adult()];
    const convo = await direct(a, b);
    const m = await poll(a, convo);
    await db().query(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1,$2)`, [a.id, b.id]);
    expect((await vote(b, m.id, [m.poll.options[0].id])).status).toBe(403);
    expect((await as(t.app, b).post(`/v1/conversations/${convo}/polls`, { question: 'Hm?', options: ['x', 'y'] })).status).toBe(403);
  });

  it('follows the group-safety rule for people under 18', async () => {
    const [owner, other, teen] = [await adult(), await adult(), await signUp(t.app, { birthDate: '2012-05-01' })];
    await befriend(other, teen);
    const convo = await group(owner, [other, teen]);
    expect((await poll(owner, convo)).poll).toBeTruthy();
    // They are no longer friends: the adult can't put new polls or lists in front of the teen.
    const [x, y] = [other.id, teen.id].sort();
    await db().query(`DELETE FROM friendships WHERE user_a = $1 AND user_b = $2`, [x, y]);
    const refused = await as(t.app, other).post(`/v1/conversations/${convo}/polls`, { question: 'Hm?', options: ['x', 'y'] });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('minor_protection');
    expect((await as(t.app, other).post(`/v1/conversations/${convo}/lists`, { title: 'Stuff' })).body.error?.code).toBe('minor_protection');
  });

  it('can be pinned, and unsending removes the poll and its votes', async () => {
    const [a, b] = [await adult(), await adult()];
    const convo = await direct(a, b);
    const m = await poll(a, convo);
    await vote(b, m.id, [m.poll.options[0].id]);
    const pinned = await as(t.app, b).put(`/v1/messages/${m.id}/pin`);
    expect(pinned.status).toBe(200);
    expect(pinned.body.items[0].message).toMatchObject({ id: m.id, body: 'Where do we eat?', kind: 'poll' });

    const live = connect(b);
    const unsent = await as(t.app, a).post(`/v1/messages/${m.id}/unsend`);
    expect(unsent.body.message).toMatchObject({ id: m.id, unsent: true, body: '' });
    expect(unsent.body.message.poll).toBeUndefined();
    expect(live.of('message.unsent').map((e) => e.data.id)).toContain(m.id);
    expect((await db().query(`SELECT 1 FROM chat_polls WHERE message_id = $1`, [m.id])).rowCount).toBe(0);
    expect((await db().query(`SELECT 1 FROM chat_poll_votes WHERE message_id = $1`, [m.id])).rowCount).toBe(0);
    expect((await vote(b, m.id, [m.poll.options[0].id])).status).toBe(404);
    expect((await as(t.app, b).get(`/v1/conversations/${convo}/pins`)).body.items).toEqual([]);
    live.remove();
  });

  it('disappears with its message in a disappearing chat', async () => {
    const [a, b] = [await adult(), await adult()];
    const convo = await direct(a, b);
    await as(t.app, a).put(`/v1/conversations/${convo}/disappearing`, { seconds: 86400 });
    const m = await poll(a, convo);
    const l = await checklist(a, convo);
    expect(m.expiresAt).toBeTruthy();
    await vote(b, m.id, [m.poll.options[1].id]);
    // A reminder can't be set for after it disappears.
    const late = await as(t.app, b).post(`/v1/messages/${m.id}/reminders`, { at: inMinutes(2 * 24 * 60) });
    expect(late.body.error.code).toBe('reminder_after_expiry');
    const ok = await as(t.app, b).post(`/v1/messages/${m.id}/reminders`, { at: inMinutes(60) });
    expect(ok.status).toBe(201);

    const live = connect(b);
    await db().query(`UPDATE messages SET expires_at = now() - interval '1 second' WHERE id = ANY($1::uuid[])`, [[m.id, l.id]]);
    // Past its time it is gone at once, before the job deletes it.
    expect((await vote(b, m.id, [m.poll.options[0].id])).status).toBe(404);
    expect((await as(t.app, b).post(`/v1/messages/${l.id}/list/items`, { text: 'x' })).status).toBe(404);
    await runDue('messages.expire', 'messageId', m.id);
    for (const table of ['chat_polls', 'chat_poll_votes', 'chat_lists', 'chat_list_items', 'chat_reminders'])
      expect((await db().query(`SELECT 1 FROM ${table} WHERE message_id = ANY($1::uuid[])`, [[m.id, l.id]])).rowCount).toBe(0);
    expect(live.of('message.deleted').map((e) => e.data.id)).toEqual(expect.arrayContaining([m.id, l.id]));
    live.remove();
  });
});

describe('Shared lists', () => {
  it('members add, tick (showing who), reorder, and remove their own items, live', async () => {
    const [a, b, c, stranger] = [await adult(), await adult(), await adult(), await adult()];
    const convo = await group(a, [b, c]);
    const m = await checklist(a, convo);
    expect(m.list).toMatchObject({ title: 'Beach day', max: 100, createdBy: a.id });
    expect(m.list.items.map((i: any) => i.text)).toEqual(['Tickets', 'Snacks']);
    const lc = connect(c);
    const outsider = connect(stranger);

    const added = await as(t.app, b).post(`/v1/messages/${m.id}/list/items`, { text: 'Sunscreen' });
    expect(added.status).toBe(201);
    const sunscreen = added.body.list.items.at(-1);
    expect(sunscreen).toMatchObject({ text: 'Sunscreen', done: false, addedBy: expect.objectContaining({ id: b.id }) });
    expect(lc.of('list.updated').at(-1)!.data.list.items).toHaveLength(3);

    const tickets = m.list.items[0].id;
    const ticked = await as(t.app, c).patch(`/v1/messages/${m.id}/list/items/${tickets}`, { done: true });
    expect(ticked.body.list.items[0]).toMatchObject({ done: true, doneBy: expect.objectContaining({ id: c.id }), doneAt: expect.any(String) });
    const unticked = await as(t.app, b).patch(`/v1/messages/${m.id}/list/items/${tickets}`, { done: false });
    expect(unticked.body.list.items[0]).toMatchObject({ done: false, doneBy: null });

    // Reorder: every item, in the new order.
    const ids = added.body.list.items.map((i: any) => i.id);
    const reordered = await as(t.app, c).put(`/v1/messages/${m.id}/list/order`, { itemIds: [ids[2], ids[0], ids[1]] });
    expect(reordered.body.list.items.map((i: any) => i.text)).toEqual(['Sunscreen', 'Tickets', 'Snacks']);
    const stale = await as(t.app, c).put(`/v1/messages/${m.id}/list/order`, { itemIds: [ids[0], ids[1]] });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('list_changed');

    // Your own items, yes; other people's, no (unless you made the list).
    const notMine = await as(t.app, c).del(`/v1/messages/${m.id}/list/items/${sunscreen.id}`);
    expect(notMine.status).toBe(403);
    expect(notMine.body.error.code).toBe('not_your_item');
    expect((await as(t.app, b).del(`/v1/messages/${m.id}/list/items/${sunscreen.id}`)).body.list.items).toHaveLength(2);
    expect((await as(t.app, a).del(`/v1/messages/${m.id}/list/items/${ids[1]}`)).status).toBe(200);

    // Outsiders can't see or change it, and get none of the updates.
    expect((await as(t.app, stranger).post(`/v1/messages/${m.id}/list/items`, { text: 'Me too' })).status).toBe(404);
    expect((await as(t.app, stranger).patch(`/v1/messages/${m.id}/list/items/${tickets}`, { done: true })).status).toBe(404);
    expect(outsider.events).toEqual([]);
    lc.remove();
    outsider.remove();
  });

  it('holds up to 100 items, and unsending removes it', async () => {
    const [a, b] = [await adult(), await adult()];
    const convo = await direct(a, b);
    const m = await checklist(
      a,
      convo,
      Array.from({ length: 100 }, (_, i) => `Item ${i + 1}`),
    );
    expect(m.list.items).toHaveLength(100);
    const full = await as(t.app, b).post(`/v1/messages/${m.id}/list/items`, { text: 'One more' });
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe('list_full');
    expect(
      (await as(t.app, a).post(`/v1/conversations/${convo}/lists`, { title: 'Too long', items: Array.from({ length: 101 }, (_, i) => `x${i}`) })).status,
    ).toBe(400);

    await as(t.app, a).post(`/v1/messages/${m.id}/unsend`);
    expect((await db().query(`SELECT 1 FROM chat_list_items WHERE message_id = $1`, [m.id])).rowCount).toBe(0);
    expect((await as(t.app, b).post(`/v1/messages/${m.id}/list/items`, { text: 'x' })).status).toBe(404);
    expect((await messages(b, convo)).find((x) => x.id === m.id).list).toBeUndefined();
  });

  it('hides items from people you blocked', async () => {
    const [a, b, c] = [await adult(), await adult(), await adult()];
    const convo = await group(a, [b, c]);
    const m = await checklist(a, convo, ['Water']);
    await as(t.app, b).post(`/v1/messages/${m.id}/list/items`, { text: 'Speaker' });
    await as(t.app, b).patch(`/v1/messages/${m.id}/list/items/${m.list.items[0].id}`, { done: true });
    await db().query(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1,$2)`, [c.id, b.id]);
    const seen = (await messages(c, convo)).find((x) => x.id === m.id).list;
    expect(seen.items.map((i: any) => i.text)).toEqual(['Water']);
    expect(seen.items[0]).toMatchObject({ done: true, doneBy: null });
  });
});

describe('Reminders', () => {
  it('"Remind me" is private and arrives as a notification at its time, through the job', async () => {
    const [a, b] = [await adult(), await adult()];
    const convo = await direct(a, b);
    const msg = (await as(t.app, a).post(`/v1/conversations/${convo}/messages`, { body: 'Bring the charger' })).body.message;

    expect((await as(t.app, b).post(`/v1/messages/${msg.id}/reminders`, { at: new Date(Date.now() + 10_000).toISOString() })).body.error.code).toBe(
      'reminder_time',
    );
    const liveA = connect(a);
    const set = await as(t.app, b).post(`/v1/messages/${msg.id}/reminders`, { at: inMinutes(30) });
    expect(set.status).toBe(201);
    expect(set.body.reminder).toMatchObject({ messageId: msg.id, scope: 'me', message: expect.objectContaining({ body: 'Bring the charger' }) });
    // Only b sees it: on the message, and in the chat's list of reminders.
    expect((await messages(b, convo)).find((x) => x.id === msg.id).reminder).toMatchObject({ id: set.body.reminder.id });
    expect((await messages(a, convo)).find((x) => x.id === msg.id).reminder).toBeUndefined();
    expect((await as(t.app, b).get(`/v1/conversations/${convo}/reminders`)).body.items).toHaveLength(1);
    expect((await as(t.app, a).get(`/v1/conversations/${convo}/reminders`)).body.items).toHaveLength(0);
    // Nobody else can cancel it.
    expect((await as(t.app, a).del(`/v1/reminders/${set.body.reminder.id}`)).status).toBe(404);

    const liveB = connect(b);
    await db().query(`UPDATE chat_reminders SET remind_at = now() - interval '1 second' WHERE id = $1`, [set.body.reminder.id]);
    await runDue('chat.reminder', 'reminderId', set.body.reminder.id);
    const n = (await db().query(`SELECT type, entity_type, entity_id, data FROM notifications WHERE user_id = $1 AND type = 'chat_reminder'`, [b.id])).rows;
    expect(n).toEqual([{ type: 'chat_reminder', entity_type: 'conversation', entity_id: convo, data: { messageId: msg.id } }]);
    expect(liveB.of('notification.created')).toHaveLength(1);
    expect(liveB.of('message.reminder').at(-1)!.data).toMatchObject({ id: msg.id, reminder: null });
    expect(liveA.events.filter((e) => e.type !== 'typing')).toEqual([]);
    expect((await db().query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'chat_reminder'`, [a.id])).rowCount).toBe(0);
    // Sent once.
    await runDue('chat.reminder', 'reminderId', set.body.reminder.id);
    expect((await db().query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'chat_reminder'`, [b.id])).rowCount).toBe(1);
    liveA.remove();
    liveB.remove();
  });

  it('can be cancelled, and nothing arrives for an unsent message or after leaving', async () => {
    const [a, b, c] = [await adult(), await adult(), await adult()];
    const convo = await group(a, [b, c]);
    const one = (await as(t.app, a).post(`/v1/conversations/${convo}/messages`, { body: 'Meet at 6' })).body.message;
    const two = (await as(t.app, a).post(`/v1/conversations/${convo}/messages`, { body: 'Meet at 7' })).body.message;

    const cancelled = (await as(t.app, b).post(`/v1/messages/${one.id}/reminders`, { at: inMinutes(5) })).body.reminder;
    expect((await as(t.app, b).del(`/v1/reminders/${cancelled.id}`)).status).toBe(200);
    expect((await as(t.app, b).get(`/v1/conversations/${convo}/reminders`)).body.items).toEqual([]);

    const onUnsent = (await as(t.app, b).post(`/v1/messages/${two.id}/reminders`, { at: inMinutes(5) })).body.reminder;
    await as(t.app, a).post(`/v1/messages/${two.id}/unsend`);
    expect((await db().query(`SELECT 1 FROM chat_reminders WHERE id = $1`, [onUnsent.id])).rowCount).toBe(0);

    const afterLeaving = (await as(t.app, c).post(`/v1/messages/${one.id}/reminders`, { at: inMinutes(5) })).body.reminder;
    await as(t.app, c).post(`/v1/conversations/${convo}/leave`);
    await db().query(`UPDATE chat_reminders SET remind_at = now() - interval '1 second' WHERE id = $1`, [afterLeaving.id]);
    await runDue('chat.reminder', 'reminderId', afterLeaving.id);
    expect((await db().query(`SELECT 1 FROM notifications WHERE user_id = ANY($1::uuid[]) AND type = 'chat_reminder'`, [[b.id, c.id]])).rowCount).toBe(0);
  });

  it('"Remind the group" is for group admins, and posts a line in the chat at its time', async () => {
    const [admin, b, stranger] = [await adult(), await adult(), await adult()];
    const convo = await group(admin, [b]);
    const msg = (await as(t.app, b).post(`/v1/conversations/${convo}/messages`, { body: 'Bus leaves at 8' })).body.message;

    const notAdmin = await as(t.app, b).post(`/v1/messages/${msg.id}/reminders`, { at: inMinutes(10), scope: 'group' });
    expect(notAdmin.status).toBe(403);
    expect(notAdmin.body.error.code).toBe('admins_only');
    expect((await as(t.app, stranger).post(`/v1/messages/${msg.id}/reminders`, { at: inMinutes(10) })).status).toBe(404);
    const [x, y] = [await adult(), await adult()];
    const dm = await direct(x, y);
    const dmMsg = (await as(t.app, x).post(`/v1/conversations/${dm}/messages`, { body: 'hi' })).body.message;
    expect((await as(t.app, x).post(`/v1/messages/${dmMsg.id}/reminders`, { at: inMinutes(10), scope: 'group' })).body.error.code).toBe('groups_only');

    const set = await as(t.app, admin).post(`/v1/messages/${msg.id}/reminders`, { at: inMinutes(10), scope: 'group' });
    expect(set.status).toBe(201);
    expect(set.body.reminder.scope).toBe('group');
    const [lb, ls] = [connect(b), connect(stranger)];
    await db().query(`UPDATE chat_reminders SET remind_at = now() - interval '1 second' WHERE id = $1`, [set.body.reminder.id]);
    await runDue('chat.reminder', 'reminderId', set.body.reminder.id);

    const line = lb.of('message.created').at(-1)!.data;
    expect(line).toMatchObject({
      kind: 'system',
      system: { type: 'reminder', messageId: msg.id, message: { body: 'Bus leaves at 8' } },
      sender: { id: admin.id },
    });
    expect(ls.events).toEqual([]);
    const inChat = (await messages(b, convo)).find((m) => m.id === line.id);
    expect(inChat.system).toMatchObject({ type: 'reminder', messageId: msg.id, message: expect.objectContaining({ id: msg.id, body: 'Bus leaves at 8' }) });
    // A group line, not a notification.
    expect((await db().query(`SELECT 1 FROM notifications WHERE type = 'chat_reminder' AND user_id = ANY($1::uuid[])`, [[admin.id, b.id]])).rowCount).toBe(0);
    lb.remove();
    ls.remove();
  });
});
