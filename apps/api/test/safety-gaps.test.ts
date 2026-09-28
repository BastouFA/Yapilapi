import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuiltApp } from '../src/app.ts';
import { RETENTION, runRetention } from '../src/lib/retention.ts';
import { as, signUp, testApp, type TestUser } from './helpers.ts';

/**
 * Gaps found by the legal review (docs/legal/review-pack.md, "Findings"): lives and audio rooms
 * follow the minor-safety rules, appeals go to a different reviewer, reporters hear what happened,
 * and records that had no retention period get one.
 */

let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
  await t.ctx.db.query(`INSERT INTO feature_flags (key, enabled) VALUES ('LIVE', true) ON CONFLICT (key) DO UPDATE SET enabled = true`);
});
afterAll(async () => {
  await t.ctx.db.query(`DELETE FROM feature_flags WHERE key = 'LIVE'`);
  await t.close();
});

const db = () => t.ctx.db;
const ADULT = '1990-04-02';
const TEEN = `${new Date().getUTCFullYear() - 15}-03-01`;
const adult = () => signUp(t.app, { birthDate: ADULT });
const teen = () => signUp(t.app, { birthDate: TEEN });
const key = () => randomUUID();

async function befriend(a: TestUser, b: TestUser) {
  const [x, y] = [a.id, b.id].sort();
  await db().query(`INSERT INTO friendships (user_a, user_b) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [x, y]);
}
async function follow(follower: TestUser, followee: TestUser) {
  await db().query(`INSERT INTO follows (follower_id, followee_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [follower.id, followee.id]);
}
async function asRole(role: 'moderator' | 'admin') {
  const u = await adult();
  await db().query(`UPDATE users SET role = $2 WHERE id = $1`, [u.id, role]);
  return u;
}
const count = async (sql: string, params: unknown[] = []) => Number((await db().query(sql, params)).rows[0].count);
const chatBodies = async (u: TestUser, liveId: string) =>
  ((await as(t.app, u).get(`/v1/live/${liveId}/chat`)).body.items as { body: string }[]).map((m) => m.body);

describe('lives and people under 18', () => {
  it("keeps a teen's live to their friends and followers under 18", async () => {
    const host = await teen();
    const friend = await adult();
    const stranger = await adult();
    const fan = await teen();
    const outsider = await teen();
    await befriend(host, friend);
    // A teen's account is private: these follows are ones the teen approved.
    await follow(stranger, host);
    await follow(fan, host);

    // "Everyone" becomes followers: a teen's live is never for everyone.
    const made = await as(t.app, host).post('/v1/live', { title: 'Practice session', visibility: 'public' });
    expect(made.status).toBe(201);
    const live = made.body.live;
    expect(live.visibility).toBe('followers');
    expect((await as(t.app, host).post(`/v1/live/${live.id}/start`)).status).toBe(200);

    // Followers who can't see it aren't told it started.
    const told = async (u: TestUser) =>
      count(`SELECT count(*) FROM notifications WHERE user_id = $1 AND type = 'live_started' AND entity_id = $2`, [u.id, live.id]);
    expect(await told(fan)).toBe(1);
    expect(await told(stranger)).toBe(0);

    // An adult who isn't a friend can't find, open, join or chat in it, even following the teen.
    const listed = async (u: TestUser) => ((await as(t.app, u).get('/v1/live')).body.items as { id: string }[]).some((l) => l.id === live.id);
    expect(await listed(stranger)).toBe(false);
    expect((await as(t.app, stranger).get(`/v1/live/${live.id}`)).status).toBe(404);
    expect((await as(t.app, stranger).post(`/v1/live/${live.id}/join`)).status).toBe(404);
    expect((await as(t.app, stranger).post(`/v1/live/${live.id}/chat`, { body: 'hello' })).status).toBe(404);
    // Nor can a teen who doesn't follow them.
    expect(await listed(outsider)).toBe(false);

    // Friends and followers under 18 can.
    expect(await listed(friend)).toBe(true);
    expect(await listed(fan)).toBe(true);
    expect((await as(t.app, friend).post(`/v1/live/${live.id}/join`)).status).toBe(200);
    expect((await as(t.app, fan).post(`/v1/live/${live.id}/join`)).status).toBe(200);

    // The host can't give a role to an adult who isn't a friend (and so can't let them in that way).
    const role = await as(t.app, host).post(`/v1/live/${live.id}/roles`, { userId: stranger.id, role: 'moderator' });
    expect(role.status).toBe(403);
    expect(role.body.error.code).toBe('minor_protection');
    expect((await as(t.app, host).post(`/v1/live/${live.id}/roles`, { userId: friend.id, role: 'moderator' })).status).toBe(200);

    // A friends-only teen live isn't shown to followers who aren't friends.
    const close = (await as(t.app, host).post('/v1/live', { title: 'Friends only', visibility: 'friends' })).body.live;
    expect((await as(t.app, fan).get(`/v1/live/${close.id}`)).status).toBe(404);
    expect((await as(t.app, friend).get(`/v1/live/${close.id}`)).status).toBe(200);
  });

  it('keeps live chat between adults and under-18s to friends, as for messages', async () => {
    const host = await adult();
    const viewer = await adult();
    const kid = await teen();
    const live = (await as(t.app, host).post('/v1/live', { title: 'Open studio' })).body.live;
    await as(t.app, host).post(`/v1/live/${live.id}/start`);
    for (const u of [viewer, kid]) expect((await as(t.app, u).post(`/v1/live/${live.id}/join`)).status).toBe(200);

    // A connected phone of the teen's, to see what reaches them live.
    const events: { type: string; data: any }[] = [];
    const remove = t.ctx.realtime.add(kid.id, { readyState: 1, send: (raw: string) => void events.push(JSON.parse(raw)) });
    try {
      expect((await as(t.app, viewer).post(`/v1/live/${live.id}/chat`, { body: 'From a stranger' })).status).toBe(201);
      expect((await as(t.app, host).post(`/v1/live/${live.id}/chat`, { body: 'From the host' })).status).toBe(201);
      expect((await as(t.app, kid).post(`/v1/live/${live.id}/chat`, { body: 'From the teen' })).status).toBe(201);
    } finally {
      remove();
    }
    const live_ = events.filter((e) => e.type === 'live.chat').map((e) => e.data.message.body);
    expect(live_).toEqual(expect.arrayContaining(['From the host', 'From the teen']));
    expect(live_).not.toContain('From a stranger');

    // Listed chat follows the same rule both ways; the host sees everything to moderate it.
    expect(await chatBodies(kid, live.id)).toEqual(['From the host', 'From the teen']);
    expect(await chatBodies(viewer, live.id)).toEqual(['From a stranger', 'From the host']);
    expect(await chatBodies(host, live.id)).toEqual(['From a stranger', 'From the host', 'From the teen']);

    // Once they're friends, they see each other's messages.
    await befriend(viewer, kid);
    expect(await chatBodies(kid, live.id)).toEqual(['From a stranger', 'From the host', 'From the teen']);
  });

  it("doesn't take gifts for a live the sender can't see", async () => {
    const host = await adult();
    const stranger = await adult();
    const live = (await as(t.app, host).post('/v1/live', { title: 'Friends night', visibility: 'friends' })).body.live;
    await as(t.app, host).post(`/v1/live/${live.id}/start`);
    const gift = await as(t.app, stranger).post(`/v1/users/${host.id}/tips`, { amountCents: 300, liveId: live.id, idempotencyKey: key() });
    expect(gift.status).toBe(404);
  });
});

describe('audio rooms and people under 18', () => {
  it("doesn't let under-18 moderators start or host a room", async () => {
    const owner = await adult();
    const kid = await teen();
    const slug = `safety-${Date.now().toString(36)}`;
    expect((await as(t.app, owner).post('/v1/communities', { name: 'Safety rooms', slug, topics: ['music'] })).status).toBe(201);
    expect((await as(t.app, kid).post(`/v1/communities/${slug}/join`)).status).toBe(200);
    await db().query(`UPDATE community_members SET role = 'moderator' WHERE user_id = $1`, [kid.id]);

    expect((await as(t.app, kid).get(`/v1/communities/${slug}/rooms`)).body.canStart).toBe(false);
    const refused = await as(t.app, kid).post(`/v1/communities/${slug}/rooms`, { title: 'Late night chat' });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('minor_protection');

    // In an adult's room, they join as a listener and go on stage only when invited.
    const room = (await as(t.app, owner).post(`/v1/communities/${slug}/rooms`, { title: 'Evening' })).body.room.id;
    const joined = await as(t.app, kid).post(`/v1/rooms/${room}/join`);
    expect(joined.status).toBe(200);
    expect(joined.body.canHost).toBe(false);
    expect((await as(t.app, kid).post(`/v1/rooms/${room}/speak`, { accept: true })).status).toBe(403);
  });
});

describe('appeals', () => {
  it('go to a different reviewer, and wait for one', async () => {
    const author = await adult();
    const reporter = await adult();
    const first = await asRole('moderator');
    const second = await asRole('moderator');
    const post = (await as(t.app, author).post('/v1/posts', { body: 'A post someone reported' })).body.post;
    expect((await as(t.app, reporter).post('/v1/reports', { targetType: 'post', targetId: post.id, reason: 'harassment' })).status).toBe(201);
    const mc = (await db().query(`SELECT id FROM moderation_cases WHERE target_id = $1`, [post.id])).rows[0];
    expect((await as(t.app, first).post(`/v1/admin/moderation/cases/${mc.id}/decide`, { decision: 'remove' })).status).toBe(200);
    expect((await as(t.app, author).post('/v1/appeals', { caseId: mc.id, statement: 'It was a joke between friends.' })).status).toBe(201);

    // The moderator who decided can't decide the appeal: the console says it needs someone else.
    const own = (await as(t.app, first).get('/v1/admin/moderation/cases?status=appealed')).body.items.find((c: any) => c.id === mc.id);
    expect(own).toMatchObject({ needs_other_reviewer: true, appeal_statement: 'It was a joke between friends.' });
    const refused = await as(t.app, first).post(`/v1/admin/moderation/cases/${mc.id}/decide`, { decision: 'no_action' });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('different_reviewer_needed');
    expect((await db().query(`SELECT status FROM moderation_cases WHERE id = $1`, [mc.id])).rows[0].status).toBe('appealed');

    // Another moderator can, and the appeal records the outcome.
    const theirs = (await as(t.app, second).get('/v1/admin/moderation/cases?status=appealed')).body.items.find((c: any) => c.id === mc.id);
    expect(theirs.needs_other_reviewer).toBe(false);
    expect((await as(t.app, second).post(`/v1/admin/moderation/cases/${mc.id}/decide`, { decision: 'no_action' })).status).toBe(200);
    const appeal = (await db().query(`SELECT status, reviewer_id, original_reviewer_id FROM appeals WHERE case_id = $1`, [mc.id])).rows[0];
    expect(appeal).toEqual({ status: 'overturned', reviewer_id: second.id, original_reviewer_id: first.id });
  });
});

describe('telling reporters the outcome', () => {
  const outcomes = async (u: TestUser) =>
    (await as(t.app, u).get('/v1/notifications?limit=50')).body.items.filter((n: any) => n.type === 'report_outcome') as any[];

  it('says what happened in plain words, without the enforcement on the other person', async () => {
    const author = await adult();
    const one = await adult();
    const two = await adult();
    const mod = await asRole('moderator');
    const admin = await asRole('admin');

    const post = (await as(t.app, author).post('/v1/posts', { body: 'Reported by two people' })).body.post;
    for (const u of [one, two]) expect((await as(t.app, u).post('/v1/reports', { targetType: 'post', targetId: post.id, reason: 'spam' })).status).toBe(201);
    const mc = (await db().query(`SELECT id FROM moderation_cases WHERE target_id = $1`, [post.id])).rows[0];
    expect((await as(t.app, mod).post(`/v1/admin/moderation/cases/${mc.id}/decide`, { decision: 'remove' })).status).toBe(200);
    for (const u of [one, two]) {
      const [n] = await outcomes(u);
      expect(n).toMatchObject({ type: 'report_outcome', actor: null, data: { targetType: 'post', outcome: 'removed' } });
      expect(n.data.decision).toBeUndefined();
    }
    expect(await outcomes(author)).toEqual([]);

    // An account that was suspended: the reporter hears that we took action, not what.
    const profile = await adult();
    expect((await as(t.app, one).post('/v1/reports', { targetType: 'user', targetId: profile.id, reason: 'harassment' })).status).toBe(201);
    const account = (await db().query(`SELECT id FROM moderation_cases WHERE target_id = $1`, [profile.id])).rows[0];
    expect((await as(t.app, admin).post(`/v1/admin/moderation/cases/${account.id}/decide`, { decision: 'suspend_user' })).status).toBe(200);
    expect((await outcomes(one)).find((n) => n.data.targetType === 'user').data).toEqual({ targetType: 'user', outcome: 'actioned' });

    // Nothing wrong.
    const fine = (await as(t.app, author).post('/v1/posts', { body: 'A fine post' })).body.post;
    await as(t.app, two).post('/v1/reports', { targetType: 'post', targetId: fine.id, reason: 'spam' });
    const cleared = (await db().query(`SELECT id FROM moderation_cases WHERE target_id = $1`, [fine.id])).rows[0];
    await as(t.app, mod).post(`/v1/admin/moderation/cases/${cleared.id}/decide`, { decision: 'no_action' });
    expect((await outcomes(two)).find((n) => n.entityId === fine.id).data.outcome).toBe('no_violation');

    // They're safety notices: the moderation category, which people can turn off.
    const row = (await db().query(`SELECT category FROM notifications WHERE user_id = $1 AND type = 'report_outcome' LIMIT 1`, [two.id])).rows[0];
    expect(row.category).toBe('moderation');
  });
});

describe('retention periods', () => {
  it('deletes records past their period and keeps recent ones', async () => {
    const u = await adult();
    const other = await adult();
    const ago = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000);
    const past = (d: number) => d + 5;

    // Payment records: an old tip (order, payment, refund, tip), an old paid download (kept: the buyer keeps access), a recent order.
    const years = RETENTION.financialRecordsYears;
    const old = ago(years * 366 + 5);
    const order = async (at: Date, status = 'paid') =>
      (
        await db().query(
          `INSERT INTO orders (buyer_id, total_cents, currency, idempotency_key, status, created_at) VALUES ($1, 500, 'USD', $2, $3, $4) RETURNING id`,
          [u.id, key(), status, at],
        )
      ).rows[0].id as string;
    const oldTip = await order(old);
    const payment = (
      await db().query(
        `INSERT INTO payments (order_id, provider, provider_ref, status, amount_cents, currency) VALUES ($1,'dev',$2,'succeeded',500,'USD') RETURNING id`,
        [oldTip, key()],
      )
    ).rows[0].id;
    await db().query(`INSERT INTO refunds (payment_id, amount_cents) VALUES ($1, 100)`, [payment]);
    await db().query(`INSERT INTO tips (from_id, to_id, order_id, created_at) VALUES ($1,$2,$3,$4)`, [u.id, other.id, oldTip, old]);
    const download = (
      await db().query(`INSERT INTO products (seller_id, kind, title, price_cents) VALUES ($1,'digital','[Dev data] Old ebook',500) RETURNING id`, [other.id])
    ).rows[0].id;
    const oldDownload = await order(old);
    await db().query(`INSERT INTO order_items (order_id, product_id, quantity, unit_cents) VALUES ($1,$2,1,500)`, [oldDownload, download]);
    const recent = await order(ago(30));
    await db().query(
      `INSERT INTO payouts (user_id, amount_cents, currency, status, created_at) VALUES ($1, 500, 'USD', 'paid', $2), ($1, 500, 'USD', 'paid', now())`,
      [other.id, old],
    );

    // Safety records: a report and its case closed long ago, and one closed recently.
    const target = randomUUID();
    await db().query(`INSERT INTO reports (reporter_id, target_type, target_id, reason, status, closed_at) VALUES ($1,'post',$2,'spam','closed',$3)`, [
      u.id,
      target,
      ago(past(RETENTION.safetyRecordsDays)),
    ]);
    await db().query(`INSERT INTO reports (reporter_id, target_type, target_id, reason, status, closed_at) VALUES ($1,'post',$2,'spam','closed',now())`, [
      u.id,
      randomUUID(),
    ]);
    const oldCase = (
      await db().query(
        `INSERT INTO moderation_cases (target_type, target_id, subject_user_id, source, risk, status, decision, decided_at) VALUES ('post',$1,$2,'report','review','final','remove',$3) RETURNING id`,
        [target, other.id, ago(past(RETENTION.safetyRecordsDays))],
      )
    ).rows[0].id;
    await db().query(`INSERT INTO appeals (case_id, user_id, statement, status) VALUES ($1,$2,'[Dev data] Please look again','upheld')`, [oldCase, other.id]);
    await db().query(`INSERT INTO enforcements (case_id, user_id, action, created_at) VALUES ($1,$2,'remove',$3)`, [
      oldCase,
      other.id,
      ago(past(RETENTION.safetyRecordsDays)),
    ]);

    // A chat with an old call, an old watch together session and an old finished game (with its card).
    const convo = (await db().query(`INSERT INTO conversations (kind, created_by) VALUES ('direct', $1) RETURNING id`, [u.id])).rows[0].id;
    await db().query(
      `INSERT INTO calls (conversation_id, caller_id, kind, status, created_at, ended_at) VALUES ($1,$2,'audio','ended',$3,$3), ($1,$2,'video','ended',now(),now())`,
      [convo, u.id, ago(past(RETENTION.callHistoryDays))],
    );
    await db().query(`INSERT INTO watch_sessions (conversation_id, started_by, status, ended_at) VALUES ($1,$2,'ended',$3)`, [
      convo,
      u.id,
      ago(past(RETENTION.watchSessionsDays)),
    ]);
    const card = (await db().query(`INSERT INTO messages (conversation_id, sender_id, body) VALUES ($1,$2,'') RETURNING id`, [convo, u.id])).rows[0].id;
    await db().query(
      `INSERT INTO chat_games (message_id, conversation_id, kind, created_by, players, state, status, ended_at) VALUES ($1,$2,'noughts',$3,$4,'{}','draw',$5)`,
      [card, convo, u.id, [u.id, other.id], ago(past(RETENTION.endedGamesDays))],
    );

    // Account history and visits.
    await db().query(
      `INSERT INTO username_history (user_id, old_username, new_username, held_until) VALUES ($1,'dev_old_name','dev_new_name',$2), ($1,'dev_recent','dev_now',now())`,
      [u.id, ago(RETENTION.usernameHistoryDaysAfterHold + 5)],
    );
    await db().query(`INSERT INTO known_sign_ins (user_id, fingerprint, last_seen_at) VALUES ($1,'old-device',$2), ($1,'this-device',now())`, [
      u.id,
      ago(past(RETENTION.signInDevicesDays)),
    ]);
    await db().query(
      `INSERT INTO pulse_visits (user_id, last_seen_at) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at`,
      [u.id, ago(past(RETENTION.visitsDays))],
    );
    const biz = (
      await db().query(`INSERT INTO businesses (owner_id, name, slug) VALUES ($1,'[Dev data] Shop',$2) RETURNING id`, [
        other.id,
        `dev-shop-${key().slice(0, 8)}`,
      ])
    ).rows[0].id;
    await db().query(
      `INSERT INTO business_views (business_id, kind, target_id, viewer_id, day) VALUES ($1,'business',$1,$2,$3::date), ($1,'business',$1,$2,current_date)`,
      [biz, u.id, ago(past(RETENTION.visitsDays))],
    );
    const post = (await as(t.app, other).post('/v1/posts', { body: 'Something to promote' })).body.post;
    await db().query(`INSERT INTO post_views (post_id, viewer_id, viewed_at) VALUES ($1,$2,$3)`, [post.id, u.id, ago(past(RETENTION.visitsDays))]);
    const campaign = (
      await db().query(`INSERT INTO ad_campaigns (advertiser_id, post_id, name) VALUES ($1,$2,'[Dev data] Campaign') RETURNING id`, [other.id, post.id])
    ).rows[0].id;
    await db().query(
      `INSERT INTO ad_events (campaign_id, user_id, kind, created_at) VALUES ($1,$2,'impression',$3), ($1,$2,'hide',$3), ($1,$2,'click',now())`,
      [campaign, u.id, ago(past(RETENTION.visitsDays))],
    );

    const r = await runRetention({ db: db(), storage: t.ctx.storage, config: t.ctx.config });
    expect(r.errors).toEqual([]);

    // Payment records.
    expect(await count(`SELECT count(*) FROM orders WHERE id = $1`, [oldTip])).toBe(0);
    expect(await count(`SELECT count(*) FROM payments WHERE id = $1`, [payment])).toBe(0);
    expect(await count(`SELECT count(*) FROM tips WHERE order_id = $1`, [oldTip])).toBe(0);
    expect(await count(`SELECT count(*) FROM orders WHERE id = $1`, [oldDownload])).toBe(1);
    expect(await count(`SELECT count(*) FROM orders WHERE id = $1`, [recent])).toBe(1);
    expect(await count(`SELECT count(*) FROM payouts WHERE user_id = $1`, [other.id])).toBe(1);

    // Safety records.
    expect(await count(`SELECT count(*) FROM reports WHERE reporter_id = $1`, [u.id])).toBe(1);
    expect(await count(`SELECT count(*) FROM moderation_cases WHERE id = $1`, [oldCase])).toBe(0);
    expect(await count(`SELECT count(*) FROM appeals WHERE case_id = $1`, [oldCase])).toBe(0);
    expect(await count(`SELECT count(*) FROM enforcements WHERE user_id = $1`, [other.id])).toBe(0);

    // Chat history.
    expect(await count(`SELECT count(*) FROM calls WHERE conversation_id = $1`, [convo])).toBe(1);
    expect(await count(`SELECT count(*) FROM watch_sessions WHERE conversation_id = $1`, [convo])).toBe(0);
    expect(await count(`SELECT count(*) FROM chat_games WHERE conversation_id = $1`, [convo])).toBe(0);
    expect(await count(`SELECT count(*) FROM messages WHERE id = $1 AND deleted_at IS NOT NULL`, [card])).toBe(1);

    // Account history and visits.
    expect((await db().query(`SELECT old_username FROM username_history WHERE user_id = $1`, [u.id])).rows).toEqual([{ old_username: 'dev_recent' }]);
    // (Signing up remembered the test's own device too.)
    const devices = (await db().query(`SELECT fingerprint FROM known_sign_ins WHERE user_id = $1`, [u.id])).rows.map((x) => x.fingerprint);
    expect(devices).toContain('this-device');
    expect(devices).not.toContain('old-device');
    expect(await count(`SELECT count(*) FROM pulse_visits WHERE user_id = $1`, [u.id])).toBe(0);
    expect(await count(`SELECT count(*) FROM business_views WHERE business_id = $1`, [biz])).toBe(1);
    expect(await count(`SELECT count(*) FROM post_views WHERE post_id = $1`, [post.id])).toBe(0);
    expect((await db().query(`SELECT kind FROM ad_events WHERE campaign_id = $1 ORDER BY kind`, [campaign])).rows.map((x) => x.kind)).toEqual([
      'click',
      'hide',
    ]);
  });

  it('keeps payment records for the configured number of years', async () => {
    const longer = await testApp({ FINANCIAL_RECORDS_YEARS: '10' });
    try {
      const u = await signUp(longer.app, { birthDate: ADULT });
      const { rows } = await longer.ctx.db.query(
        `INSERT INTO orders (buyer_id, total_cents, currency, idempotency_key, status, created_at) VALUES ($1, 100, 'USD', $2, 'paid', now() - interval '8 years') RETURNING id`,
        [u.id, key()],
      );
      const r = await runRetention({ db: longer.ctx.db, storage: longer.ctx.storage, config: longer.ctx.config });
      expect(r.errors).toEqual([]);
      expect(Number((await longer.ctx.db.query(`SELECT count(*) FROM orders WHERE id = $1`, [rows[0].id])).rows[0].count)).toBe(1);
    } finally {
      await longer.close();
    }
  });
});
