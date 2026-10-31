import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planNoticeHref, planNoticeText } from '@yapilapi/shared';
import { t as tr, tp as trp } from '@yapilapi/shared/i18n';
import { as, signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';
import { sweepFreeNow } from '../src/lib/plans.ts';
import { pushTextFor } from '../src/lib/push.ts';

/**
 * Go out together (lib/plans.ts, modules/plans.ts): docs/product/go-out-together.md. Plans are
 * with friends; the plan's chat follows the answers; the cost split only keeps count.
 */
let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.close();
});

const db = () => t.ctx.db;
const adult = () => signUp(t.app);
const teen = () => signUp(t.app, { birthDate: `${new Date().getUTCFullYear() - 15}-01-01` });
const befriend = async (a: TestUser, b: TestUser) => {
  await as(t.app, a).post(`/v1/users/${b.id}/friend-request`);
  await as(t.app, b).post(`/v1/users/${a.id}/friend-request`);
};
const notes = async (u: TestUser, type?: string) => ((await as(t.app, u).get('/v1/notifications')).body.items as any[]).filter((n) => !type || n.type === type);
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const make = (maker: TestUser, invite: TestUser[], extra: Record<string, unknown> = {}) =>
  as(t.app, maker).post('/v1/plans', { title: 'Suya and a film', startsAt: inHours(3), userIds: invite.map((u) => u.id), ...extra });
const answer = (u: TestUser, id: string, a: 'in' | 'maybe' | 'cant') => as(t.app, u).post(`/v1/plans/${id}/answer`, { answer: a });
const chatIds = async (u: TestUser) => ((await as(t.app, u).get('/v1/conversations')).body.items as any[]).map((c) => c.id);
const members = async (conversationId: string) =>
  (
    await db().query<{ user_id: string }>(`SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND left_at IS NULL ORDER BY user_id`, [
      conversationId,
    ])
  ).rows.map((r) => r.user_id);
const say = (n: any) =>
  planNoticeText(
    n,
    (k, v) => tr(k, 'en', v),
    (k, c, v) => trp(k, c, 'en', v),
  );

/** A plan by `maker` with `friends` invited (all befriended first). */
async function planWith(maker: TestUser, friends: TestUser[]) {
  for (const f of friends) await befriend(maker, f);
  const r = await make(maker, friends);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.plan as { id: string; conversationId: string };
}

describe('Plans: friends only, answers and the chat', () => {
  it('makes a plan with friends; answers move people in and out of its chat', async () => {
    const ada = await adult();
    const bola = await adult();
    const cleo = await adult();
    const plan = await planWith(ada, [bola, cleo]);
    expect(plan).toMatchObject({ title: 'Suya and a film', status: 'active', viewer: { answer: 'in', maker: true }, counts: { in: 1, pending: 2 } });
    expect(plan.conversationId).toBeTruthy();
    // Only the maker is in the chat until people answer.
    expect(await members(plan.conversationId)).toEqual([ada.id]);

    // Bola is told, sees the plan but not its chat yet.
    const invite = await notes(bola, 'plan_invite');
    expect(invite).toHaveLength(1);
    expect(invite[0]).toMatchObject({ entityType: 'plan', entityId: plan.id, data: { title: 'Suya and a film' } });
    expect(say(invite[0])).toBe(`${invite[0].actor.displayName} invited you: Suya and a film`);
    expect(planNoticeHref(invite[0])).toBe(plan.id);
    expect(pushTextFor('plan_invite', 'Ada', invite[0].data)).toBe('Ada invited you: Suya and a film');
    const seen = (await as(t.app, bola).get(`/v1/plans/${plan.id}`)).body.plan;
    expect(seen.viewer.answer).toBe('pending');
    expect(seen.conversationId).toBeNull();
    expect(seen.costs).toBeNull();
    expect((await as(t.app, bola).get('/v1/plans')).body.upcoming.map((c: any) => c.id)).toEqual([plan.id]);

    // I'm in: in the chat, with a line; the invite notification goes; the maker hears.
    const inR = await answer(bola, plan.id, 'in');
    expect(inR.status).toBe(200);
    expect(inR.body.plan.conversationId).toBe(plan.conversationId);
    expect(await chatIds(bola)).toContain(plan.conversationId);
    const chat = (await as(t.app, bola).get(`/v1/conversations/${plan.conversationId}`)).body.conversation;
    expect(chat).toMatchObject({ kind: 'group', title: 'Suya and a film', planId: plan.id, planOn: true });
    expect(await notes(bola, 'plan_invite')).toHaveLength(0);
    const told = await notes(ada, 'plan_answer');
    expect(told).toHaveLength(1);
    expect(say(told[0])).toBe(`${told[0].actor.displayName} is in: Suya and a film`);

    // Maybe: in the chat too. Then the maker's notification groups the answers.
    await answer(cleo, plan.id, 'maybe');
    expect((await members(plan.conversationId)).sort()).toEqual([ada.id, bola.id, cleo.id].sort());
    const grouped = await notes(ada, 'plan_answer');
    expect(grouped).toHaveLength(1);
    expect(grouped[0].data.count).toBe(2);
    expect(say(grouped[0])).toBe(`${grouped[0].actor.displayName} and 1 other answered: Suya and a film`);

    // Can't: out of the chat, with a line; the plan stays visible to change your mind.
    await answer(bola, plan.id, 'cant');
    expect(await chatIds(bola)).not.toContain(plan.conversationId);
    expect((await members(plan.conversationId)).sort()).toEqual([ada.id, cleo.id].sort());
    const lines = await db().query(`SELECT sender_id, meta FROM messages WHERE conversation_id = $1 AND kind = 'system' ORDER BY created_at`, [
      plan.conversationId,
    ]);
    expect(lines.rows.map((r) => [r.sender_id, r.meta.action])).toEqual([
      [ada.id, 'added'],
      [ada.id, 'added'],
      [bola.id, 'left'],
    ]);
    const after = (await as(t.app, bola).get(`/v1/plans/${plan.id}`)).body.plan;
    expect(after).toMatchObject({ viewer: { answer: 'cant' }, conversationId: null, counts: { in: 1, maybe: 1, cant: 1, pending: 0 } });
    expect((await answer(bola, plan.id, 'in')).body.plan.conversationId).toBe(plan.conversationId);

    // The maker is always in.
    expect((await answer(ada, plan.id, 'cant')).body.error.code).toBe('plan_maker');
  });

  it('the chat follows the plan: its own add, rename and leave are refused while the plan is on', async () => {
    const ada = await adult();
    const bola = await adult();
    const dayo = await adult();
    const plan = await planWith(ada, [bola]);
    await befriend(ada, dayo);
    await answer(bola, plan.id, 'in');
    expect((await as(t.app, bola).post(`/v1/conversations/${plan.conversationId}/leave`)).body.error.code).toBe('plan_chat');
    expect((await as(t.app, ada).post(`/v1/conversations/${plan.conversationId}/members`, { userIds: [dayo.id] })).body.error.code).toBe('plan_chat');
    expect((await as(t.app, ada).patch(`/v1/conversations/${plan.conversationId}`, { title: 'Other' })).body.error.code).toBe('plan_chat');
    // Polls are ordinary chat polls: anyone in the chat can start one to pick a time or a place.
    const poll = await as(t.app, bola).post(`/v1/conversations/${plan.conversationId}/polls`, { question: 'When?', options: ['8pm', '9pm'] });
    expect(poll.status, JSON.stringify(poll.body)).toBe(201);
  });

  it('only friends can be invited, nobody else sees the plan, and squads bring their members', async () => {
    const ada = await adult();
    const bola = await adult();
    const stranger = await adult();
    await befriend(ada, bola);
    const r = await make(ada, [stranger]);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('plan_invite_not_allowed');
    const plan = (await make(ada, [bola])).body.plan;
    expect((await as(t.app, stranger).get(`/v1/plans/${plan.id}`)).status).toBe(404);
    expect((await answer(stranger, plan.id, 'in')).status).toBe(404);
    expect((await as(t.app, stranger).get('/v1/plans')).body.upcoming).toEqual([]);
    // Invitees who aren't in yet can't invite; people who are, invite their own friends.
    const cleo = await adult();
    await befriend(bola, cleo);
    expect((await as(t.app, bola).post(`/v1/plans/${plan.id}/invites`, { userIds: [cleo.id] })).status).toBe(403);
    await answer(bola, plan.id, 'in');
    const inv = await as(t.app, bola).post(`/v1/plans/${plan.id}/invites`, { userIds: [cleo.id] });
    expect(inv.status, JSON.stringify(inv.body)).toBe(200);
    expect(inv.body.invited).toBe(1);
    // Candidates are friends not in the plan yet.
    const cands = (await as(t.app, ada).get(`/v1/plans/candidates?planId=${plan.id}`)).body.items.map((u: any) => u.id);
    expect(cands).not.toContain(bola.id);

    // A squad: its members are invited.
    const s1 = await adult();
    const s2 = await adult();
    for (const s of [s1, s2]) await befriend(ada, s);
    const squad = (await as(t.app, ada).post('/v1/squads', { name: 'Crew', userIds: [s1.id, s2.id] })).body.squad;
    for (const s of [s1, s2]) await as(t.app, s).post(`/v1/squads/${squad.id}/accept`);
    const sq = await make(ada, [], { squadId: squad.id });
    expect(sq.status, JSON.stringify(sq.body)).toBe(201);
    expect(sq.body.plan.squad).toEqual({ id: squad.id, name: 'Crew' });
    expect(sq.body.plan.counts).toMatchObject({ in: 1, pending: 2 });
    // Not a squad you're in: not found.
    expect((await make(stranger, [], { squadId: squad.id })).status).toBe(404);
  });

  it('respects blocks and the minor-safety rule', async () => {
    const ada = await adult();
    const bola = await adult();
    const cleo = await adult();
    await befriend(ada, bola);
    await befriend(ada, cleo);
    await as(t.app, cleo).post(`/v1/users/${bola.id}/block`);
    // Bola and Cleo can't be in one chat.
    const r = await make(ada, [bola, cleo]);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('blocked_in_group');

    // An adult and a teen who are friends can plan; another adult who isn't the teen's friend can't join them.
    const kid = await teen();
    const dad = await adult();
    await befriend(dad, kid);
    await befriend(dad, ada);
    const p = await make(dad, [kid]);
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    const withAda = await as(t.app, dad).post(`/v1/plans/${p.body.plan.id}/invites`, { userIds: [ada.id] });
    expect(withAda.status).toBe(403);
    expect(withAda.body.error.code).toBe('minor_protection');
  });

  it('the maker edits or cancels; everyone still in hears', async () => {
    const ada = await adult();
    const bola = await adult();
    const plan = await planWith(ada, [bola]);
    await answer(bola, plan.id, 'in');
    expect((await as(t.app, bola).patch(`/v1/plans/${plan.id}`, { title: 'Mine now' })).status).toBe(403);
    const later = inHours(5);
    const e = await as(t.app, ada).patch(`/v1/plans/${plan.id}`, { startsAt: later, place: { kind: 'text', name: 'Terra Kulture' } });
    expect(e.status, JSON.stringify(e.body)).toBe(200);
    expect(e.body.plan.place).toEqual({ kind: 'text', id: null, name: 'Terra Kulture' });
    expect(new Date(e.body.plan.startsAt).getTime()).toBe(new Date(later).getTime());
    expect(await notes(bola, 'plan_changed')).toHaveLength(1);
    expect((await as(t.app, ada).patch(`/v1/plans/${plan.id}`, { startsAt: inHours(24 * 200) })).body.error.code).toBe('plan_time');

    const c = await as(t.app, ada).post(`/v1/plans/${plan.id}/cancel`);
    expect(c.body.plan.status).toBe('cancelled');
    const cancelled = await notes(bola, 'plan_cancelled');
    expect(say(cancelled[0])).toBe(`${cancelled[0].actor.displayName} cancelled: Suya and a film`);
    expect((await answer(bola, plan.id, 'maybe')).body.error.code).toBe('plan_cancelled');
    const line = await db().query(`SELECT meta FROM messages WHERE conversation_id = $1 AND meta->>'type' = 'plan' ORDER BY created_at`, [plan.conversationId]);
    expect(line.rows.map((r) => r.meta.action)).toEqual(['changed', 'cancelled']);
    // Once cancelled, the chat is an ordinary group: people can leave it.
    expect((await as(t.app, bola).post(`/v1/conversations/${plan.conversationId}/leave`)).status).toBe(200);
  });

  it('a place from Wander shows only to people who can see it', async () => {
    const ada = await adult();
    const bola = await adult();
    await befriend(ada, bola);
    const ev = await db().query<{ id: string }>(
      `INSERT INTO events (host_id, title, starts_at, visibility) VALUES ($1, 'Rooftop night', now() + interval '1 day', 'private') RETURNING id`,
      [ada.id],
    );
    const p = await make(ada, [bola], { place: { kind: 'event', id: ev.rows[0]!.id } });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    expect(p.body.plan.place).toEqual({ kind: 'event', id: ev.rows[0]!.id, name: 'Rooftop night' });
    expect((await as(t.app, bola).get(`/v1/plans/${p.body.plan.id}`)).body.plan.place).toBeNull();
    // Someone else's private event can't be used at all.
    expect((await make(bola, [ada], { place: { kind: 'event', id: ev.rows[0]!.id } })).status).toBe(404);
  });
});

describe('Cost split', () => {
  it('adds expenses, works out who owes whom, and marks paid back', async () => {
    const ada = await adult();
    const bola = await adult();
    const cleo = await adult();
    const plan = await planWith(ada, [bola, cleo]);
    await answer(bola, plan.id, 'in');
    // Cleo hasn't answered: she can't add or be in a split.
    expect(
      (await as(t.app, cleo).post(`/v1/plans/${plan.id}/expenses`, { title: 'x', amountCents: 100, currency: 'NGN', paidBy: cleo.id, splitWith: [cleo.id] }))
        .status,
    ).toBe(403);
    const split = await as(t.app, ada).post(`/v1/plans/${plan.id}/expenses`, {
      title: 'Tickets',
      amountCents: 600_000,
      currency: 'NGN',
      paidBy: ada.id,
      splitWith: [ada.id, bola.id, cleo.id],
    });
    expect(split.status).toBe(400);
    await answer(cleo, plan.id, 'maybe');

    const a = await as(t.app, ada).post(`/v1/plans/${plan.id}/expenses`, {
      title: 'Tickets',
      amountCents: 600_000,
      currency: 'NGN',
      paidBy: ada.id,
      splitWith: [ada.id, bola.id, cleo.id],
    });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const b = await as(t.app, bola).post(`/v1/plans/${plan.id}/expenses`, {
      title: 'Suya',
      amountCents: 300_001,
      currency: 'ngn',
      paidBy: bola.id,
      splitWith: [ada.id, bola.id, cleo.id],
    });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    const costs = b.body.plan.costs;
    expect(costs.expenses).toHaveLength(2);
    // Shares add up, the odd cent goes to one person.
    expect(costs.expenses[1].shares.reduce((n: number, s: any) => n + s.shareCents, 0)).toBe(300_001);
    // Tickets: 200,000 each. Suya: 100,000 each and the odd cent to the first chosen (Ada). So Ada is
    // owed 600,000 − 200,000 − 100,001 = 299,999, Bola 1, and Cleo owes 300,000: two payments.
    expect(costs.debts).toEqual([
      { from: cleo.id, to: ada.id, amountCents: 299_999, currency: 'NGN' },
      { from: cleo.id, to: bola.id, amountCents: 1, currency: 'NGN' },
    ]);

    // Cleo pays Ada back what she owes her; only Cleo or Ada can mark it, and not more than owed.
    const owesAda = costs.debts.find((d: any) => d.from === cleo.id && d.to === ada.id);
    expect(owesAda).toBeTruthy();
    expect(
      (await as(t.app, bola).post(`/v1/plans/${plan.id}/paid-back`, { from: cleo.id, to: ada.id, amountCents: owesAda.amountCents, currency: 'NGN' })).body
        .error.code,
    ).toBe('plan_paid_back');
    expect(
      (await as(t.app, cleo).post(`/v1/plans/${plan.id}/paid-back`, { from: cleo.id, to: ada.id, amountCents: owesAda.amountCents + 1, currency: 'NGN' })).body
        .error.code,
    ).toBe('plan_not_owed');
    const paid = await as(t.app, ada).post(`/v1/plans/${plan.id}/paid-back`, { from: cleo.id, to: ada.id, amountCents: owesAda.amountCents, currency: 'NGN' });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(paid.body.plan.costs.debts.find((d: any) => d.from === cleo.id && d.to === ada.id)).toBeUndefined();
    // Undo: only whoever marked it.
    const sid = paid.body.plan.costs.settlements[0].id;
    expect((await as(t.app, cleo).del(`/v1/plans/${plan.id}/paid-back/${sid}`)).status).toBe(404);
    expect((await as(t.app, ada).del(`/v1/plans/${plan.id}/paid-back/${sid}`)).body.plan.costs.settlements).toEqual([]);

    // Removing: the person who added it or the maker; not anyone else.
    const suya = costs.expenses[1].id;
    expect((await as(t.app, cleo).del(`/v1/plans/${plan.id}/expenses/${suya}`)).status).toBe(404);
    expect((await as(t.app, ada).del(`/v1/plans/${plan.id}/expenses/${suya}`)).body.plan.costs.expenses).toHaveLength(1);
    // People outside the plan see nothing.
    expect((await as(t.app, await adult()).get(`/v1/plans/${plan.id}`)).status).toBe(404);
  });
});

describe("I'm free", () => {
  it('friends see it (not others, not blocked people), it ends by itself', async () => {
    const ada = await adult();
    const bola = await adult();
    const stranger = await adult();
    const cleo = await adult();
    await befriend(ada, bola);
    await befriend(ada, cleo);
    const set = await as(t.app, ada).put('/v1/me/free', { until: inHours(2), note: 'Up for food in Yaba' });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.free.note).toBe('Up for food in Yaba');
    expect((await as(t.app, ada).get('/v1/free')).body.mine).toMatchObject({ note: 'Up for food in Yaba' });
    expect((await as(t.app, bola).get('/v1/free')).body.friends.map((f: any) => f.user.id)).toEqual([ada.id]);
    expect((await as(t.app, stranger).get('/v1/free')).body.friends).toEqual([]);
    await as(t.app, cleo).post(`/v1/users/${ada.id}/block`);
    expect((await as(t.app, cleo).get('/v1/free')).body.friends).toEqual([]);
    // Too long or too short.
    expect((await as(t.app, ada).put('/v1/me/free', { until: inHours(30) })).body.error.code).toBe('free_until');
    // Ends by itself.
    await db().query(`UPDATE free_now SET until = now() - interval '1 minute' WHERE user_id = $1`, [ada.id]);
    expect((await as(t.app, bola).get('/v1/free')).body.friends).toEqual([]);
    expect(await sweepFreeNow(db())).toBeGreaterThanOrEqual(1);
    expect((await as(t.app, ada).get('/v1/free')).body.mine).toBeNull();
    // Taken back.
    await as(t.app, ada).put('/v1/me/free', { until: inHours(1) });
    expect((await as(t.app, ada).del('/v1/me/free')).body.free).toBeNull();
    expect((await as(t.app, bola).get('/v1/free')).body.friends).toEqual([]);
  });
});

describe('Data export and account deletion', () => {
  it('exports your side, and deleting an account hands its plans on', async () => {
    const ada = await adult();
    const bola = await adult();
    const cleo = await adult();
    const plan = await planWith(ada, [bola, cleo]);
    await answer(bola, plan.id, 'in');
    await as(t.app, ada).post(`/v1/plans/${plan.id}/expenses`, {
      title: 'Taxi',
      amountCents: 4000,
      currency: 'EUR',
      paidBy: ada.id,
      splitWith: [ada.id, bola.id],
    });
    await as(t.app, ada).put('/v1/me/free', { until: inHours(2), note: 'Free' });
    const lone = await planWith(ada, [await adult()]);

    const exported = (await as(t.app, bola).get('/v1/me/export')).body.goOut;
    expect(exported.plans).toEqual([expect.objectContaining({ id: plan.id, your_answer: 'in', you_made_it: false })]);
    expect(exported.expenses).toEqual([expect.objectContaining({ title: 'Taxi', amount_cents: 4000, you_paid: false, your_share_cents: 2000 })]);
    expect(JSON.stringify(exported)).not.toContain(ada.id);
    expect((await as(t.app, ada).get('/v1/me/export')).body.goOut.freeNow).toEqual([expect.objectContaining({ note: 'Free' })]);

    expect((await as(t.app, ada).del('/v1/me', { password: ada.password })).status).toBe(200);
    expect((await db().query(`SELECT 1 FROM free_now WHERE user_id = $1`, [ada.id])).rowCount).toBe(0);
    // Bola, the first one in, now has the plan; Ada is out of it; the plan nobody else was in is gone.
    const p = (await as(t.app, bola).get(`/v1/plans/${plan.id}`)).body.plan;
    expect(p.viewer.maker).toBe(true);
    expect((await db().query(`SELECT answer FROM plan_people WHERE plan_id = $1 AND user_id = $2`, [plan.id, ada.id])).rows[0].answer).toBe('cant');
    expect(p.costs.expenses[0].title).toBe('');
    expect((await db().query(`SELECT 1 FROM plans WHERE id = $1`, [lone.id])).rowCount).toBe(0);
  });
});
