import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';
import { countLinks, SPAM_RULES } from '../src/lib/spam.ts';
import { isDisposableEmail } from '../src/lib/disposable-domains.ts';

let t: BuiltApp;
let mod: TestUser;
beforeAll(async () => {
  // Spam checks are off in tests by default; this file turns them on.
  t = await testApp({ SPAM_CHECKS: 'true' });
  mod = await signUp(t.app, { birthDate: '1985-01-01' });
  await t.ctx.db.query(`UPDATE users SET role = 'moderator' WHERE id = $1`, [mod.id]);
});
afterAll(async () => {
  await t.close();
});

const db = () => t.ctx.db;
const signals = async (userId: string) =>
  (
    await db().query<{ kind: string; status: string; target_id: string | null }>(`SELECT kind, status, target_id FROM risk_signals WHERE user_id = $1`, [
      userId,
    ])
  ).rows;
/** Past the new-account window, so pace limits don't get in the way of a test about something else. */
const age = (u: TestUser, days = 30) => db().query(`UPDATE users SET created_at = now() - make_interval(days => $2) WHERE id = $1`, [u.id, days]);
const befriend = (a: TestUser, b: TestUser) => {
  const [x, y] = [a.id, b.id].sort();
  return db().query(`INSERT INTO friendships (user_a, user_b) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [x, y]);
};
const postStatus = async (id: string) => (await db().query(`SELECT moderation_status FROM posts WHERE id = $1`, [id])).rows[0].moderation_status;
const unique = () => randomUUID().slice(0, 8);

/** Sign up from a given address (the API trusts X-Forwarded-For, as behind the load balancer). */
async function signUpFrom(ip: string, extra: Record<string, unknown> = {}) {
  const s = unique();
  const res = await t.app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    headers: { 'x-forwarded-for': ip },
    payload: { email: `s_${s}@example.test`, password: 'correct-horse-battery', username: `s_${s}`, displayName: 'Spam test', ...extra },
  });
  return { status: res.statusCode, body: res.json() as any };
}

let net = 0;
/**
 * A new account from its own network, so the sign-up velocity rules (which this
 * file turns on) don't flag every test account created from localhost.
 */
async function newUser(extra: Record<string, unknown> = {}): Promise<TestUser> {
  net++;
  const r = await signUpFrom(`10.${Math.floor(net / 250) + 1}.${net % 250}.${1 + (net % 7)}`, extra);
  if (r.status !== 201) throw new Error(`signup failed: ${JSON.stringify(r.body)}`);
  return { id: r.body.user.id, token: r.body.token, username: r.body.user.username, email: r.body.user.email, password: 'correct-horse-battery' };
}

describe('sign-up risk scoring', () => {
  it('recognises throwaway email domains, including subdomains', () => {
    expect(isDisposableEmail('someone@mailinator.com')).toBe(true);
    expect(isDisposableEmail('someone@eu.mailinator.com')).toBe(true);
    expect(isDisposableEmail('someone@gmail.com')).toBe(false);
    expect(isDisposableEmail('someone@notmailinator.com')).toBe(false);
  });

  it('records a signal for a throwaway email, and holds that account’s public posts for review', async () => {
    const s = unique();
    const u = await newUser({ email: `x_${s}@yopmail.com` });
    expect((await signals(u.id)).map((x) => x.kind)).toEqual(['disposable_email']);
    const r = await as(t.app, u).post('/v1/posts', { body: 'My first post here', visibility: 'public' });
    expect(r.status).toBe(201);
    expect(r.body.moderation.status).toBe('review');
    const kase = (await db().query(`SELECT signals FROM moderation_cases WHERE target_type = 'post' AND target_id = $1`, [r.body.post.id])).rows[0];
    expect(kase.signals.signals).toContain('risky_account');
    // Friends-only posts aren't held.
    expect((await as(t.app, u).post('/v1/posts', { body: 'Just for friends', visibility: 'friends' })).body.moderation).toBeUndefined();
  });

  it('flags many sign-ups from one address', async () => {
    const ip = '203.0.113.50';
    const ids: string[] = [];
    for (let i = 0; i < SPAM_RULES.signupsPerIpPerHour + 1; i++) {
      const r = await signUpFrom(ip);
      expect(r.status).toBe(201);
      ids.push(r.body.user.id);
    }
    expect(await signals(ids[0]!)).toEqual([]);
    expect((await signals(ids.at(-1)!)).map((x) => x.kind)).toContain('signup_ip_velocity');
  });

  it('flags many sign-ups from one /24 network', async () => {
    const ids: string[] = [];
    for (let i = 1; i <= SPAM_RULES.signupsPerSubnetPerHour + 1; i++) ids.push((await signUpFrom(`198.51.100.${i}`)).body.user.id);
    const last = (await signals(ids.at(-1)!)).map((x) => x.kind);
    expect(last).toContain('signup_subnet_velocity');
    expect(last).not.toContain('signup_ip_velocity');
    // A different /24 isn't affected.
    const elsewhere = await signUpFrom('198.51.101.1');
    expect(await signals(elsewhere.body.user.id)).toEqual([]);
  });

  it('refuses a sign-up that fills the hidden honeypot field', async () => {
    const r = await signUpFrom('203.0.113.99', { website: 'http://cheap-followers.example' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('signup_blocked');
    expect(r.body.error.message).not.toMatch(/bot|spam/i);
  });
});

describe('pace limits for new accounts', () => {
  it('limits posts per hour in the first 24 hours', async () => {
    const u = await newUser();
    for (let i = 0; i < SPAM_RULES.newAccountPostsPerHour; i++)
      expect((await as(t.app, u).post('/v1/posts', { body: `Note ${i} ${unique()}`, visibility: 'private' })).status).toBe(201);
    const r = await as(t.app, u).post('/v1/posts', { body: 'One more', visibility: 'private' });
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('slow_down');
    expect(r.body.error.message).toMatch(/New accounts can share up to 10 posts an hour/);
    expect((await signals(u.id)).map((x) => x.kind)).toEqual(['post_velocity']);
    // Older accounts aren't held to the new-account pace.
    await age(u, 2);
    expect((await as(t.app, u).post('/v1/posts', { body: 'Back again', visibility: 'private' })).status).toBe(201);
  });

  it('limits messages per hour in the first 24 hours', async () => {
    const u = await newUser();
    const friend = await newUser();
    await befriend(u, friend);
    const conv = (await as(t.app, u).post('/v1/conversations', { memberIds: [friend.id] })).body.conversation;
    for (let i = 0; i < SPAM_RULES.newAccountMessagesPerHour; i++)
      expect((await as(t.app, u).post(`/v1/conversations/${conv.id}/messages`, { body: `hi ${i}` })).status).toBe(201);
    const r = await as(t.app, u).post(`/v1/conversations/${conv.id}/messages`, { body: 'one more' });
    expect(r.status).toBe(429);
    expect(r.body.error.message).toMatch(/New accounts can send up to 30 messages an hour/);
    expect((await signals(u.id)).map((x) => x.kind)).toEqual(['message_velocity']);
  });
});

describe('link spam and repeated text', () => {
  it('counts links', () => {
    expect(countLinks('see https://a.example and http://b.example or www.c.example')).toBe(3);
    expect(countLinks('no links here')).toBe(0);
  });

  it('holds the third identical post from one account in an hour for review', async () => {
    const u = await newUser();
    await age(u);
    const text = `Check out my new profile everyone ${unique()}`;
    const first = await as(t.app, u).post('/v1/posts', { body: text });
    // Case and spacing don't make it different.
    const second = await as(t.app, u).post('/v1/posts', { body: text.replace('Check', 'CHECK').replace(/ /g, '  ') });
    expect(first.body.moderation).toBeUndefined();
    expect(second.body.moderation).toBeUndefined();
    const third = await as(t.app, u).post('/v1/posts', { body: text });
    expect(third.body.moderation.status).toBe('review');
    expect(await postStatus(third.body.post.id)).toBe('review');
    const kase = (await db().query(`SELECT source, risk, signals FROM moderation_cases WHERE target_type = 'post' AND target_id = $1`, [third.body.post.id]))
      .rows[0];
    expect(kase).toMatchObject({ source: 'automated', risk: 'review' });
    expect(kase.signals.signals).toEqual(['duplicate_text']);
    expect(kase.signals.spam[0].detail).toMatchObject({ scope: 'account', copiesLastHour: 3 });
  });

  it('holds the same link posted by many accounts', async () => {
    const text = `Win big today at https://prizes-${unique()}.example`;
    const results = [];
    for (let i = 0; i < SPAM_RULES.duplicateLinkPostsAcrossAccounts; i++) {
      const u = await newUser();
      await age(u);
      results.push(await as(t.app, u).post('/v1/posts', { body: text }));
    }
    expect(results.slice(0, -1).every((r) => !r.body.moderation)).toBe(true);
    expect(results.at(-1)!.body.moderation.status).toBe('review');
  });

  it('holds posts with many links from new accounts', async () => {
    const u = await newUser();
    const r = await as(t.app, u).post('/v1/posts', { body: 'Links: https://a.example https://b.example https://c.example' });
    expect(r.body.moderation.status).toBe('review');
    expect((await signals(u.id)).find((s) => s.kind === 'link_spam')?.target_id).toBe(r.body.post.id);
    // Two links are fine, and so are three from an account older than a week.
    expect((await as(t.app, u).post('/v1/posts', { body: 'https://a.example and https://b.example' })).body.moderation).toBeUndefined();
    await age(u, 8);
    expect((await as(t.app, u).post('/v1/posts', { body: 'https://a.example https://b.example https://c.example' })).body.moderation).toBeUndefined();
  });

  it('holds a message with many links to someone who isn’t a friend until a moderator lets it through', async () => {
    const sender = await newUser();
    const stranger = await newUser();
    const conv = (await as(t.app, sender).post('/v1/conversations', { memberIds: [stranger.id] })).body.conversation;
    const r = await as(t.app, sender).post(`/v1/conversations/${conv.id}/messages`, { body: 'Deals https://a.example https://b.example https://c.example' });
    expect(r.status).toBe(201);
    expect(r.body.message.moderation).toBe('review');
    expect(r.body.notice).toMatch(/quick check/);
    // The sender sees it; the recipient doesn't, yet.
    expect((await as(t.app, sender).get(`/v1/conversations/${conv.id}/messages`)).body.items.map((m: any) => m.id)).toContain(r.body.message.id);
    expect((await as(t.app, stranger).get(`/v1/conversations/${conv.id}/messages`)).body.items).toEqual([]);

    const kase = (await db().query(`SELECT id, source, signals FROM moderation_cases WHERE target_type = 'message' AND target_id = $1`, [r.body.message.id]))
      .rows[0];
    expect(kase).toMatchObject({ source: 'automated', signals: { signals: ['link_spam'] } });
    expect((await as(t.app, mod).post(`/v1/admin/moderation/cases/${kase.id}/decide`, { decision: 'no_action' })).status).toBe(200);
    expect((await as(t.app, stranger).get(`/v1/conversations/${conv.id}/messages`)).body.items.map((m: any) => m.id)).toEqual([r.body.message.id]);
    expect((await signals(sender.id)).find((s) => s.kind === 'link_spam')?.status).toBe('cleared');
  });

  it('holds the same message sent into many conversations with people who aren’t friends', async () => {
    const sender = await newUser();
    await age(sender);
    const text = `Hey, follow me for daily tips ${unique()}`;
    const replies = [];
    for (let i = 0; i < SPAM_RULES.duplicateMessageConversations; i++) {
      const other = await newUser();
      const conv = (await as(t.app, sender).post('/v1/conversations', { memberIds: [other.id] })).body.conversation;
      replies.push(await as(t.app, sender).post(`/v1/conversations/${conv.id}/messages`, { body: text }));
    }
    expect(replies.slice(0, -1).every((r) => !r.body.message.moderation)).toBe(true);
    expect(replies.at(-1)!.body.message.moderation).toBe('review');
    // Friends aren't checked: the same text to a friend goes straight through.
    const friend = await newUser();
    await befriend(sender, friend);
    const conv = (await as(t.app, sender).post('/v1/conversations', { memberIds: [friend.id] })).body.conversation;
    expect((await as(t.app, sender).post(`/v1/conversations/${conv.id}/messages`, { body: text })).body.message.moderation).toBeUndefined();
  });
});

describe('repeated flags', () => {
  async function flagThrice(u: TestUser) {
    const ids: string[] = [];
    for (let i = 0; i < SPAM_RULES.flagsBeforeRestrict; i++) {
      const r = await as(t.app, u).post('/v1/posts', { body: `Offer ${i}: https://a.example https://b.example https://c.example` });
      ids.push(r.body.post.id);
    }
    return ids;
  }

  it('limit the account until a moderator reviews it, and clearing puts everything back', async () => {
    const u = await newUser({ birthDate: '1995-05-05' });
    const stranger = await newUser();
    const flagged = await flagThrice(u);
    expect((await db().query(`SELECT restricted_at FROM users WHERE id = $1`, [u.id])).rows[0].restricted_at).not.toBeNull();
    expect((await as(t.app, u).get('/v1/notifications')).body.items.map((n: any) => n.type)).toContain('account_limited');
    expect((await as(t.app, u).get('/v1/auth/me')).body.user.limited).toBe(true);

    // While limited: new posts are visible only to their author, and no messages to people who aren't friends.
    const held = await as(t.app, u).post('/v1/posts', { body: 'A normal post' });
    expect(held.body.moderation).toMatchObject({ status: 'restricted' });
    expect(held.body.moderation.message).toMatch(/limited/);
    expect((await as(t.app, stranger).get(`/v1/posts/${held.body.post.id}`)).status).toBe(404);
    const dm = await as(t.app, u).post('/v1/conversations', { memberIds: [stranger.id] });
    expect(dm.status).toBe(403);
    expect(dm.body.error.code).toBe('account_restricted');

    // The moderator console lists the account with its signals.
    const list = (await as(t.app, mod).get('/v1/admin/risk/accounts')).body.items;
    const entry = list.find((x: any) => x.user.id === u.id);
    expect(entry.restrictedAt).toBeTruthy();
    expect(entry.signals.map((s: any) => s.kind)).toEqual(expect.arrayContaining(['link_spam', 'auto_restricted', 'held_while_limited']));
    expect(entry.signals.find((s: any) => s.kind === 'link_spam').excerpt).toMatch(/^Offer/);
    // Only moderators can see it.
    expect((await as(t.app, u).get('/v1/admin/risk/accounts')).status).toBe(403);

    const cleared = await as(t.app, mod).post(`/v1/admin/risk/accounts/${u.id}/review`, { action: 'clear', note: 'Real small business' });
    expect(cleared.body).toMatchObject({ restricted: false });
    expect((await db().query(`SELECT restricted_at FROM users WHERE id = $1`, [u.id])).rows[0].restricted_at).toBeNull();
    for (const id of [...flagged, held.body.post.id]) expect(await postStatus(id)).toBe('normal');
    expect((await signals(u.id)).every((s) => s.status === 'cleared')).toBe(true);
    const cases = await db().query(`SELECT status, decision FROM moderation_cases WHERE target_type = 'post' AND target_id = ANY($1::uuid[])`, [flagged]);
    expect(cases.rows.every((c) => c.status === 'decided' && c.decision === 'no_action')).toBe(true);
    expect((await as(t.app, u).get('/v1/notifications')).body.items.find((n: any) => n.type === 'account_review').data.outcome).toBe('cleared');
    expect((await as(t.app, u).post('/v1/conversations', { memberIds: [stranger.id] })).status).toBe(201);
    expect((await as(t.app, mod).get('/v1/admin/risk/accounts')).body.items.some((x: any) => x.user.id === u.id)).toBe(false);
  });

  it('confirming keeps the limit and removes the flagged posts', async () => {
    const u = await newUser();
    const flagged = await flagThrice(u);
    const r = await as(t.app, mod).post(`/v1/admin/risk/accounts/${u.id}/review`, { action: 'confirm' });
    expect(r.body).toMatchObject({ restricted: true });
    for (const id of flagged) expect(await postStatus(id)).toBe('removed');
    expect((await signals(u.id)).every((s) => s.status === 'confirmed')).toBe(true);
    expect((await db().query(`SELECT count(*)::int AS n FROM enforcements WHERE user_id = $1`, [u.id])).rows[0].n).toBe(flagged.length);
    const reviewed = (await as(t.app, mod).get('/v1/admin/risk/accounts?status=reviewed')).body.items;
    expect(reviewed.some((x: any) => x.user.id === u.id)).toBe(true);
    // A moderator can lift the limit later; the removed posts stay removed.
    const lifted = await as(t.app, mod).post(`/v1/admin/risk/accounts/${u.id}/review`, { action: 'clear' });
    expect(lifted.body).toMatchObject({ restricted: false, signals: 0 });
    expect((await db().query(`SELECT restricted_at FROM users WHERE id = $1`, [u.id])).rows[0].restricted_at).toBeNull();
    for (const id of flagged) expect(await postStatus(id)).toBe('removed');
    // Accounts with nothing waiting can't be reviewed again.
    expect((await as(t.app, mod).post(`/v1/admin/risk/accounts/${u.id}/review`, { action: 'clear' })).status).toBe(400);
  });
});
