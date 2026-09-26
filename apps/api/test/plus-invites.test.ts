import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tx } from '@yapilapi/database';
import { signDevWebhook } from '../src/lib/payments.ts';
import { qualifyReferral } from '../src/lib/invites.ts';
import { as, signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';

let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.ctx.db.query(`DELETE FROM feature_flags WHERE key = 'ADS'`);
  await t.close();
});

const ADULT = '1990-04-02';
const DAY = 86_400_000;
const key = () => `k_${Math.random().toString(36).slice(2)}${Date.now()}`;

async function pay(orderId: string, amountCents: number, eventId = `evt_${orderId}`) {
  const ref = (await t.ctx.db.query(`SELECT provider_ref FROM payments WHERE order_id = $1`, [orderId])).rows[0].provider_ref;
  const payload = JSON.stringify({ id: eventId, type: 'payment.succeeded', providerRef: ref, amountCents });
  const res = await t.app.inject({
    method: 'POST',
    url: '/v1/payments/webhook/dev',
    payload,
    headers: { 'content-type': 'application/json', 'x-signature': signDevWebhook(t.ctx.config.PAYMENTS_WEBHOOK_SECRET, payload) },
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function buyPlus(u: TestUser) {
  const r = await as(t.app, u).post('/v1/plus/checkout', { idempotencyKey: key() });
  expect(r.status).toBe(201);
  await pay(r.body.payment.orderId, r.body.priceCents);
  return r.body.payment.orderId as string;
}

async function verifyEmail(u: TestUser) {
  const outbox = (await t.app.inject({ url: '/dev/outbox' })).json().items;
  const mail = outbox.findLast((m: { to: string; subject: string }) => m.to === u.email && m.subject.includes('Confirm'));
  const token = new URL(mail.text.match(/https?:\/\/\S+/)[0]).searchParams.get('token');
  expect((await as(t.app, null).post('/v1/auth/verify-email', { token })).status).toBe(200);
}

async function video(owner: TestUser, durationMs: number) {
  const { rows } = await t.ctx.db.query(
    `INSERT INTO media (owner_id, kind, url, mime, status, duration_ms) VALUES ($1,'video','http://localhost:4000/media/test.mp4','video/mp4','ready',$2) RETURNING id, url`,
    [owner.id, durationMs],
  );
  return { id: rows[0].id as string, url: rows[0].url as string, kind: 'video' };
}

describe('YAPILAPI Plus', () => {
  it('is bought through checkout, turns on when the payment is confirmed, and extends by 30 days', async () => {
    const u = await signUp(t.app);
    const info = await as(t.app, u).get('/v1/plus');
    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({ priceCents: 499, currency: 'USD', days: 30, autoRenews: false, status: { active: false, until: null } });
    expect(info.body.benefits.map((b: any) => b.id)).toEqual(['no_ads', 'long_reels', 'big_uploads', 'badge']);
    // Anyone can see the price and benefits.
    expect((await as(t.app, null).get('/v1/plus')).body.status).toBeNull();

    const checkout = await as(t.app, u).post('/v1/plus/checkout', { idempotencyKey: key() });
    expect(checkout.status).toBe(201);
    expect(checkout.body.payment).toMatchObject({ provider: 'dev' });
    expect(checkout.body.payment.clientSecret).toBeTruthy();
    const orderId = checkout.body.payment.orderId;
    // Nothing until the provider confirms.
    expect((await as(t.app, u).get('/v1/plus')).body.status.active).toBe(false);

    await pay(orderId, 499);
    const on = await as(t.app, u).get('/v1/plus');
    expect(on.body.status.active).toBe(true);
    const until = new Date(on.body.status.until).getTime();
    expect(Math.abs(until - (Date.now() + 30 * DAY))).toBeLessThan(60_000);
    expect(on.body.history).toHaveLength(1);
    expect(on.body.history[0]).toMatchObject({ source: 'purchase', days: 30 });
    expect((await as(t.app, u).get(`/v1/orders/${orderId}`)).body.order.status).toBe('paid');

    // A replayed webhook grants nothing more.
    await pay(orderId, 499);
    await pay(orderId, 499, `evt_replay_${orderId}`);
    expect((await as(t.app, u).get('/v1/plus')).body.status.until).toBe(on.body.status.until);

    // The badge shows on the profile and in /me.
    const self = (await as(t.app, u).get('/v1/auth/me')).body.user;
    expect(self.plus).toBe(true);
    expect(self.plusUntil).toBe(on.body.status.until);
    expect((await as(t.app, null).get(`/v1/users/${u.username}`)).body.profile.plus).toBe(true);
    const post = (await as(t.app, u).post('/v1/posts', { body: 'Plus post' })).body.post;
    expect(post.author.plus).toBe(true);
    const other = await signUp(t.app);
    expect((await as(t.app, null).get(`/v1/users/${other.username}`)).body.profile.plus).toBeUndefined();

    // Buying again extends from the current end date.
    await buyPlus(u);
    const extended = await as(t.app, u).get('/v1/plus');
    expect(new Date(extended.body.status.until).getTime() - until).toBe(30 * DAY);
    expect(extended.body.history).toHaveLength(2);

    // A wrong amount never grants Plus.
    const bad = await as(t.app, other).post('/v1/plus/checkout', { idempotencyKey: key() });
    await pay(bad.body.payment.orderId, 1);
    expect((await as(t.app, other).get('/v1/plus')).body.status.active).toBe(false);
  });

  it('ends on its own and cannot be stacked for more than a year', async () => {
    const u = await signUp(t.app);
    await t.ctx.db.query(`UPDATE profiles SET plus_until = now() - interval '1 minute' WHERE user_id = $1`, [u.id]);
    expect((await as(t.app, u).get('/v1/plus')).body.status).toMatchObject({ active: false, until: null });
    expect((await as(t.app, u).get('/v1/auth/me')).body.user.plus).toBeUndefined();
    await t.ctx.db.query(`UPDATE profiles SET plus_until = now() + interval '340 days' WHERE user_id = $1`, [u.id]);
    expect((await as(t.app, u).get('/v1/plus')).body.status.canExtend).toBe(false);
    expect((await as(t.app, u).post('/v1/plus/checkout', { idempotencyKey: key() })).status).toBe(409);
  });

  it('never serves sponsored posts to Plus members', async () => {
    await t.ctx.db.query(`INSERT INTO feature_flags (key, enabled) VALUES ('ADS', true) ON CONFLICT (key) DO UPDATE SET enabled = true`);
    const shop = await signUp(t.app, { birthDate: ADULT });
    const regular = await signUp(t.app, { birthDate: ADULT });
    const member = await signUp(t.app, { birthDate: ADULT });
    const post = (await as(t.app, shop).post('/v1/posts', { body: 'Handmade bowls, new batch' })).body.post;
    // A topic only this test's viewers follow, so campaigns from other suites never compete.
    const topic = `plusads${Math.random().toString(36).slice(2, 8)}`;
    await t.ctx.db.query(
      `INSERT INTO ad_campaigns (advertiser_id, post_id, name, status, topics, cpm_cents, budget_millicents, approved_at) VALUES ($1,$2,'Bowls','active',$3,1000,500000, now())`,
      [shop.id, post.id, [topic]],
    );
    for (const v of [regular, member]) {
      await as(t.app, v).put('/v1/me/consents', { purpose: 'advertising', granted: true });
      await as(t.app, v).put('/v1/me/interests', { topics: [topic] });
    }
    await buyPlus(member);

    expect((await as(t.app, regular).get('/v1/ads/next')).body.ad?.post.id).toBe(post.id);
    expect((await as(t.app, member).get('/v1/ads/next')).body.ad).toBeNull();
    const shown = await t.ctx.db.query(`SELECT count(*)::int AS n FROM ad_events WHERE user_id = $1`, [member.id]);
    expect(shown.rows[0].n).toBe(0);
  });

  it('allows reels up to 10 minutes and larger uploads for Plus members', async () => {
    const regular = await signUp(t.app);
    const member = await signUp(t.app);
    await buyPlus(member);
    const five = (u: TestUser) => video(u, 5 * 60_000);

    const refused = await as(t.app, regular).post('/v1/posts', { format: 'reel', media: [await five(regular)] });
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toMatch(/3 minutes/);
    expect((await as(t.app, member).post('/v1/posts', { format: 'reel', body: 'Long take', media: [await five(member)] })).status).toBe(201);
    expect((await as(t.app, member).post('/v1/posts', { format: 'reel', media: [await video(member, 11 * 60_000)] })).status).toBe(400);

    const big = { filename: 'long.mp4', mime: 'video/mp4', size: 300 * 1024 * 1024 };
    expect((await as(t.app, regular).post('/v1/uploads', big)).status).toBe(413);
    expect((await as(t.app, member).post('/v1/uploads', big)).status).toBe(201);
    expect((await as(t.app, member).post('/v1/uploads', { ...big, size: 600 * 1024 * 1024 })).status).toBe(413);
  });
});

describe('invites', () => {
  it('gives everyone a stable code and makes the new person and the inviter follow each other', async () => {
    const inviter = await signUp(t.app, { birthDate: ADULT });
    const mine = await as(t.app, inviter).get('/v1/invites');
    expect(mine.status).toBe(200);
    const code = mine.body.code;
    expect(code).toMatch(/^[a-z0-9]{8}$/);
    expect(mine.body.link).toBe(`${t.ctx.config.WEB_ORIGIN.split(',')[0]}/join/${code}`);
    expect(mine.body).toMatchObject({ joined: 0, confirmed: 0, toNextReward: 3, reward: { perPeople: 3, days: 30, earned: 0 } });
    expect((await as(t.app, inviter).get('/v1/invites')).body.code).toBe(code);

    // The join page can show who invited you without signing in.
    const preview = await as(t.app, null).get(`/v1/invites/${code.toUpperCase()}`);
    expect(preview.status).toBe(200);
    expect(preview.body.inviter).toMatchObject({ id: inviter.id, username: inviter.username });
    expect((await as(t.app, null).get('/v1/invites/zzzzzzzz')).status).toBe(404);

    // A code that doesn't exist is a field error, and no account is created.
    const wrong = await as(t.app, null).post('/v1/auth/register', {
      email: `wrong_${Date.now()}@example.test`,
      password: 'correct-horse-battery',
      username: `wrong_${Date.now().toString(36)}`,
      displayName: 'Wrong code',
      inviteCode: 'zzzzzzzz',
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.details.fields.inviteCode).toBeTruthy();

    const friend = await signUp(t.app, { birthDate: ADULT, inviteCode: code });
    const followsFriend = await t.ctx.db.query(`SELECT 1 FROM follows WHERE follower_id = $1 AND followee_id = $2`, [inviter.id, friend.id]);
    const friendFollows = await t.ctx.db.query(`SELECT 1 FROM follows WHERE follower_id = $1 AND followee_id = $2`, [friend.id, inviter.id]);
    expect(followsFriend.rowCount).toBe(1);
    expect(friendFollows.rowCount).toBe(1);

    const notes = (await as(t.app, inviter).get('/v1/notifications')).body.items;
    expect(notes.find((n: any) => n.type === 'invite_joined')?.actor.id).toBe(friend.id);

    const after = (await as(t.app, inviter).get('/v1/invites')).body;
    expect(after.joined).toBe(1);
    expect(after.confirmed).toBe(0);
    expect(after.people[0]).toMatchObject({ user: { id: friend.id }, confirmed: false });

    // One referral per account.
    const other = await signUp(t.app, { birthDate: ADULT });
    const otherCode = (await as(t.app, other).get('/v1/invites')).body.code;
    expect((await as(t.app, friend).post('/v1/invites/accept', { code: otherCode })).status).toBe(409);
  });

  it('grants the inviter 30 days of Plus for every 3 people who confirm their email, once', async () => {
    const inviter = await signUp(t.app, { birthDate: ADULT });
    const code = (await as(t.app, inviter).get('/v1/invites')).body.code;
    const friends: TestUser[] = [];
    for (let i = 0; i < 3; i++) friends.push(await signUp(t.app, { birthDate: ADULT, inviteCode: code }));

    // Joining alone doesn't count; confirming the email does.
    await verifyEmail(friends[0]!);
    await verifyEmail(friends[1]!);
    let status = await as(t.app, inviter).get('/v1/invites');
    expect(status.body).toMatchObject({ joined: 3, confirmed: 2, toNextReward: 1 });
    expect((await as(t.app, inviter).get('/v1/plus')).body.status.active).toBe(false);

    await verifyEmail(friends[2]!);
    status = await as(t.app, inviter).get('/v1/invites');
    expect(status.body).toMatchObject({ confirmed: 3, toNextReward: 3, reward: { earned: 1 } });
    const plus = (await as(t.app, inviter).get('/v1/plus')).body;
    expect(plus.status.active).toBe(true);
    expect(plus.history).toEqual([expect.objectContaining({ source: 'referral', days: 30 })]);
    const notes = (await as(t.app, inviter).get('/v1/notifications')).body.items;
    expect(notes.some((n: any) => n.type === 'plus_referral_reward')).toBe(true);

    // Checking again grants nothing more.
    await tx(t.ctx.db, (c) => qualifyReferral(c, t.ctx.realtime, friends[2]!.id));
    const grants = await t.ctx.db.query(`SELECT count(*)::int AS n FROM plus_grants WHERE user_id = $1`, [inviter.id]);
    expect(grants.rows[0].n).toBe(1);

    // Another address of an inbox that already counted doesn't count again.
    const alias = await signUp(t.app, { birthDate: ADULT, inviteCode: code, email: friends[0]!.email.replace('@', '+again@') });
    await verifyEmail(alias);
    expect((await as(t.app, inviter).get('/v1/invites')).body).toMatchObject({ joined: 4, confirmed: 3 });
  });

  it('rejects your own invite code, including another address of your own inbox', async () => {
    const u = await signUp(t.app, { birthDate: ADULT });
    const code = (await as(t.app, u).get('/v1/invites')).body.code;

    const alias = await as(t.app, null).post('/v1/auth/register', {
      email: u.email.replace('@', '+second@'),
      password: 'correct-horse-battery',
      username: `alias_${Date.now().toString(36)}`,
      displayName: 'Second me',
      inviteCode: code,
    });
    expect(alias.status).toBe(400);
    expect(alias.body.error.message).toMatch(/own invite code/);

    const self = await as(t.app, u).post('/v1/invites/accept', { code });
    expect(self.status).toBe(400);
    expect(self.body.error.message).toMatch(/own invite code/);
    expect((await t.ctx.db.query(`SELECT 1 FROM referrals WHERE invitee_id = $1`, [u.id])).rowCount).toBe(0);

    // A code from an account newer than yours doesn't work either (no inviting each other in a circle).
    const newer = await signUp(t.app, { birthDate: ADULT, inviteCode: code });
    const newerCode = (await as(t.app, newer).get('/v1/invites')).body.code;
    expect((await as(t.app, u).post('/v1/invites/accept', { code: newerCode })).status).toBe(400);

    // An account that joined without a code can still enter one soon after.
    const late = await signUp(t.app, { birthDate: ADULT });
    expect((await as(t.app, late).get('/v1/invites')).body.canEnterCode).toBe(true);
    const accepted = await as(t.app, late).post('/v1/invites/accept', { code: code.toUpperCase() });
    expect(accepted.status).toBe(200);
    expect(accepted.body.inviter.id).toBe(u.id);
    expect((await as(t.app, late).get('/v1/invites')).body.canEnterCode).toBe(false);
    expect((await as(t.app, u).get('/v1/invites')).body.joined).toBe(2);
    // Too late: codes can only be entered in the first days after joining.
    const old = await signUp(t.app, { birthDate: ADULT });
    await t.ctx.db.query(`UPDATE users SET created_at = now() - interval '30 days' WHERE id = $1`, [old.id]);
    expect((await as(t.app, old).get('/v1/invites')).body.canEnterCode).toBe(false);
    expect((await as(t.app, old).post('/v1/invites/accept', { code })).status).toBe(409);
  });
});
