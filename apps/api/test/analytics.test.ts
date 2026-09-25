import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Client,
  createTestApp,
  makeStaff,
  signup,
  uniq,
  type TestApp,
  type TestUser,
} from './helpers.js';
import { track, purgeOldAnalytics } from '../src/modules/analytics/index.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

const sql = <R extends Record<string, any> = any>(text: string, params: unknown[] = []) =>
  t.ctx.db.query<R>(text, params);
const teenUser = () => signup(t, { birthDate: `${new Date().getUTCFullYear() - 15}-02-02` });
const staff = async (role: 'support' | 'moderator' | 'admin' | 'superadmin') => {
  const u = await signup(t);
  await makeStaff(t, u, role);
  return u;
};
const anonId = () => `${uniq('anon')}abcdefghij`.slice(0, 32);
const EVENT = { name: 'screen_view', properties: { screen: 'feed' } };
const send = (c: Client, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  c.request('POST', '/v1/analytics/events', { body, headers });
const anonSend = (
  body: Record<string, unknown>,
  headers: Record<string, string> = { 'x-analytics-consent': '1' },
) => send(new Client(t, 'bearer'), body, headers);
const consent = async (u: TestUser, granted = true) => {
  const r = await u.client.put('/v1/privacy/consents/analytics', { granted });
  expect(r.status).toBe(200);
};
const eventsFor = async (userId: string, name?: string) =>
  (
    await sql(
      'SELECT * FROM analytics_events WHERE user_id = $1 AND ($2::text IS NULL OR name = $2)',
      [userId, name ?? null],
    )
  ).rows;

describe('event schema', () => {
  it('is public and lists only client events with strict property schemas', async () => {
    const r = await new Client(t).get('/v1/analytics/events/schema');
    expect(r.status).toBe(200);
    const names = r.body.events.map((e: any) => e.name);
    expect(names).toContain('screen_view');
    expect(names).not.toContain('post_created');
    expect(r.body.maxEventsPerRequest).toBe(20);
  });
});

describe('ingestion: consent and Do Not Track', () => {
  it('stores consented anonymous events with the anon id only (no user, no ip, server timestamp)', async () => {
    const id = anonId();
    const before = Date.now();
    const r = await anonSend({
      anonId: id,
      platform: 'ios',
      events: [{ ...EVENT, createdAt: '2001-01-01T00:00:00Z' }],
    });
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ accepted: 1, rejected: [] });
    const rows = (await sql('SELECT * FROM analytics_events WHERE anon_id = $1', [id])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: null,
      name: 'screen_view',
      platform: 'ios',
      source: 'client',
      properties: { screen: 'feed' },
    });
    expect(rows[0].created_at.getTime()).toBeGreaterThanOrEqual(before - 5_000); // client-supplied time is ignored
    expect(Object.keys(rows[0]).sort()).toEqual([
      'anon_id',
      'created_at',
      'id',
      'name',
      'platform',
      'properties',
      'source',
      'user_id',
    ]);
  });

  it('discards anonymous events without the consent header, or with a missing or malformed anon id', async () => {
    const id = anonId();
    for (const [body, headers] of [
      [{ anonId: id, events: [EVENT] }, {}],
      [{ anonId: id, events: [EVENT] }, { 'x-analytics-consent': '0' }],
      [{ events: [EVENT] }, { 'x-analytics-consent': '1' }],
      [{ anonId: 'me@example.com', events: [EVENT] }, { 'x-analytics-consent': '1' }],
    ] as const) {
      const r = await anonSend(body as any, headers as any);
      expect(r.status).toBe(202);
      expect(r.body.accepted).toBe(0);
      expect(r.body.discarded).toBeTruthy();
    }
    expect(
      (await sql('SELECT 1 FROM analytics_events WHERE anon_id = $1', [id])).rows,
    ).toHaveLength(0);
  });

  it('honours Do Not Track and Global Privacy Control even when consent was given', async () => {
    const id = anonId();
    for (const headers of [{ dnt: '1' }, { 'sec-gpc': '1' }] as Array<Record<string, string>>) {
      const r = await anonSend(
        { anonId: id, events: [EVENT] },
        { 'x-analytics-consent': '1', ...headers },
      );
      expect(r.body).toMatchObject({ accepted: 0, discarded: 'do_not_track' });
    }
    const u = await signup(t);
    await consent(u);
    const r = await send(u.client, { events: [EVENT] }, { dnt: '1' });
    expect(r.body).toMatchObject({ accepted: 0, discarded: 'do_not_track' });
    expect(await eventsFor(u.id)).toHaveLength(0);
    expect(
      (await sql('SELECT 1 FROM analytics_events WHERE anon_id = $1', [id])).rows,
    ).toHaveLength(0);
    // DNT: 0 is an explicit "do track" and is not treated as a signal.
    expect((await send(u.client, { events: [EVENT] }, { dnt: '0' })).body.accepted).toBe(1);
  });

  it('signed-in users are tracked only while their analytics consent is granted (revocation takes effect at once)', async () => {
    const u = await signup(t);
    expect((await send(u.client, { events: [EVENT] })).body).toMatchObject({
      accepted: 0,
      discarded: 'no_consent',
    });
    expect(await eventsFor(u.id)).toHaveLength(0);
    await consent(u, true);
    expect((await send(u.client, { events: [EVENT, EVENT] })).body.accepted).toBe(2);
    expect(await eventsFor(u.id)).toHaveLength(2);
    await consent(u, false);
    expect((await send(u.client, { events: [EVENT] })).body).toMatchObject({
      accepted: 0,
      discarded: 'no_consent',
    });
    // Revoking consent also detaches what was already collected from the account.
    expect(await eventsFor(u.id)).toHaveLength(0);
  });

  it("a signed-in user's events never carry the anonymous id, and an anonymous consent header cannot override the account setting", async () => {
    const u = await signup(t);
    const id = anonId();
    const r = await send(u.client, { anonId: id, events: [EVENT] }, { 'x-analytics-consent': '1' });
    expect(r.body.discarded).toBe('no_consent');
    await consent(u);
    await send(u.client, { anonId: id, events: [EVENT] });
    const rows = await eventsFor(u.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].anon_id).toBeNull();
    expect(
      (await sql('SELECT 1 FROM analytics_events WHERE anon_id = $1', [id])).rows,
    ).toHaveLength(0);
  });

  it('teen accounts can never be tracked', async () => {
    const teen = await teenUser();
    const put = await teen.client.put('/v1/privacy/consents/analytics', { granted: true });
    expect(put.status).toBeGreaterThanOrEqual(400);
    // Even if a consent row were forced into the table, ingestion still refuses.
    await sql(
      `INSERT INTO consents (user_id, purpose, granted, scope) VALUES ($1, 'analytics', true, '{}'::jsonb)`,
      [teen.id],
    ).catch(() => undefined);
    expect((await send(teen.client, { events: [EVENT] })).body).toMatchObject({
      accepted: 0,
      discarded: 'no_consent',
    });
    expect(await eventsFor(teen.id)).toHaveLength(0);
  });
});

describe('ingestion: allowlist', () => {
  it('accepts valid events and reports every rejected one with a reason', async () => {
    const u = await signup(t);
    await consent(u);
    const r = await send(u.client, {
      events: [
        EVENT,
        { name: 'made_up_event', properties: {} },
        { name: 'post_created', properties: { kind: 'text', visibility: 'public' } }, // server-only: forgery attempt
        { name: 'screen_view', properties: { screen: 'feed', email: 'a@b.c' } }, // extra key
        {
          name: 'search_performed',
          properties: { surface: 'global', had_results: true, query: 'private text' },
        }, // free text
        { name: 'web_vital', properties: { metric: 'LCP', value: -5, rating: 'good' } },
        { name: 'app_open', properties: { referrer_kind: 'push' } },
      ],
    });
    expect(r.status).toBe(202);
    expect(r.body.accepted).toBe(2);
    expect(r.body.rejected).toEqual([
      { index: 1, name: 'made_up_event', reason: 'unknown_event' },
      { index: 2, name: 'post_created', reason: 'not_allowed_from_client' },
      { index: 3, name: 'screen_view', reason: 'invalid_properties' },
      { index: 4, name: 'search_performed', reason: 'invalid_properties' },
      { index: 5, name: 'web_vital', reason: 'invalid_properties' },
    ]);
    const rows = await eventsFor(u.id);
    expect(rows.map((x: any) => x.name).sort()).toEqual(['app_open', 'screen_view']);
    expect(JSON.stringify(rows)).not.toContain('private text');
    expect(JSON.stringify(rows)).not.toContain('a@b.c');
  });

  it('rejects malformed bodies and batches over the limit', async () => {
    const u = await signup(t);
    await consent(u);
    expect((await send(u.client, { events: [] })).status).toBe(400);
    expect((await send(u.client, { events: Array.from({ length: 21 }, () => EVENT) })).status).toBe(
      400,
    );
    expect((await send(u.client, { events: 'nope' })).status).toBe(400);
    expect((await send(u.client, { platform: 'server', events: [EVENT] })).status).toBe(400); // clients cannot claim to be the server
    expect((await send(u.client, { events: Array.from({ length: 20 }, () => EVENT) })).status).toBe(
      202,
    );
  });
});

describe('server-side events', () => {
  it('track() records allowed server events only for consenting users and never throws', async () => {
    const yes = await signup(t);
    const no = await signup(t);
    await consent(yes);
    expect(await track(t.ctx, 'appeal_created', {}, { userId: yes.id })).toBe(true);
    expect(await track(t.ctx, 'appeal_created', {}, { userId: no.id })).toBe(false);
    expect(await track(t.ctx, 'screen_view', { screen: 'feed' }, { userId: yes.id })).toBe(false); // client event: not a server event
    expect(
      await track(t.ctx, 'report_created', { reason: 'not-a-reason' }, { userId: yes.id }),
    ).toBe(false);
    expect(
      await track(t.ctx, 'appeal_created', {}, { userId: '00000000-0000-0000-0000-000000000000' }),
    ).toBe(false);
    const rows = await eventsFor(yes.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'server', platform: 'server', anon_id: null });
    expect(await eventsFor(no.id)).toHaveLength(0);
  });

  it('creating a post and reporting content are tracked with categories only, and only with consent', async () => {
    const yes = await signup(t);
    const no = await signup(t);
    const other = await signup(t);
    await consent(yes);
    const body = `A perfectly ordinary post ${uniq('p')}`;
    const p1 = await yes.client.post('/v1/posts', { body, visibility: 'public' });
    const p2 = await no.client.post('/v1/posts', { body: `${body} two`, visibility: 'public' });
    expect(p1.status).toBe(201);
    expect(p2.status).toBe(201);
    const ev = await eventsFor(yes.id, 'post_created');
    expect(ev).toHaveLength(1);
    expect(ev[0].properties.visibility).toBe('public');
    expect(JSON.stringify(ev[0].properties)).not.toContain('ordinary');
    expect(await eventsFor(no.id, 'post_created')).toHaveLength(0);

    await consent(other);
    const rep = await other.client.post('/v1/reports', {
      targetType: 'post',
      targetId: p1.body.id,
      reason: 'spam',
    });
    expect(rep.status).toBeLessThan(300);
    const re = await eventsFor(other.id, 'report_created');
    expect(re).toHaveLength(1);
    expect(re[0].properties).toEqual({ reason: 'spam' });
  });

  it('a failing tracking write inside a transaction cannot poison the caller', async () => {
    const u = await signup(t);
    await consent(u);
    const { withTransaction } = await import('@yapilapi/database');
    const ok = await withTransaction(t.ctx.db, async (tx) => {
      await track(t.ctx, 'appeal_created', {}, { userId: u.id, db: tx });
      await tx.query('SELECT 1'); // still usable
      return true;
    });
    expect(ok).toBe(true);
    expect(await eventsFor(u.id, 'appeal_created')).toHaveLength(1);
  });
});

describe('retention', () => {
  it('deletes raw events older than the retention period and keeps recent ones', async () => {
    const id = anonId();
    await sql(
      `INSERT INTO analytics_events (name, properties, anon_id, platform, source, created_at) VALUES ('screen_view','{"screen":"feed"}',$1,'web','client', now() - interval '400 days'), ('screen_view','{"screen":"feed"}',$1,'web','client', now() - interval '1 day')`,
      [id],
    );
    const removed = await purgeOldAnalytics(t.ctx, 365);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(
      (await sql('SELECT 1 FROM analytics_events WHERE anon_id = $1', [id])).rows,
    ).toHaveLength(1);
    expect(await purgeOldAnalytics(t.ctx, 365)).toBe(0);
  });
});

describe('staff analytics authorization', () => {
  const paths = [
    'acquisition',
    'engagement',
    'retention',
    'msa',
    'creators',
    'commerce',
    'safety',
    'technical',
  ].map((p) => `/v1/admin/analytics/${p}`);

  it('is closed to anonymous users, ordinary users, support, moderators and staff without MFA; open to admin and superadmin', async () => {
    const user = await signup(t);
    const noMfa = await signup(t);
    await sql(`UPDATE users SET platform_role = 'admin' WHERE id = $1`, [noMfa.id]);
    const support = await staff('support');
    const mod = await staff('moderator');
    const admin = await staff('admin');
    const sa = await staff('superadmin');
    for (const path of paths) {
      expect((await new Client(t).get(path)).status, `anon ${path}`).toBe(401);
      expect((await user.client.get(path)).status, `user ${path}`).toBe(403);
      expect((await noMfa.client.get(path)).status, `no-mfa ${path}`).toBe(403);
      expect((await support.client.get(path)).status, `support ${path}`).toBe(403);
      expect((await mod.client.get(path)).status, `moderator ${path}`).toBe(403);
      const a = await admin.client.get(path);
      expect(a.status, `admin ${path}`).toBe(200);
      expect(a.body.available, path).not.toBe(false); // the section actually ran
      expect((await sa.client.get(path)).status, `superadmin ${path}`).toBe(200);
    }
  });

  it('validates its query parameters', async () => {
    const admin = await staff('admin');
    expect((await admin.client.get('/v1/admin/analytics/engagement', { days: '0' })).status).toBe(
      400,
    );
    expect(
      (await admin.client.get('/v1/admin/analytics/engagement', { days: '9999' })).status,
    ).toBe(400);
    expect((await admin.client.get('/v1/admin/analytics/msa', { weeks: '50' })).status).toBe(400);
  });
});

describe('technical and acquisition aggregates', () => {
  it('computes web vitals p75 from consented events, suppressing small groups, and exposes no identifiers', async () => {
    const admin = await staff('admin');
    const id = anonId();
    const vital = (value: number) => ({
      name: 'web_vital',
      properties: { metric: 'TTFB', value, rating: 'good' },
    });
    await anonSend({ anonId: id, platform: 'web', events: [vital(100), vital(200)] });
    let r = await admin.client.get('/v1/admin/analytics/technical');
    let row = r.body.webVitalsP75.find((x: any) => x.metric === 'TTFB' && x.platform === 'web');
    expect(row).toMatchObject({ samples: null, p75: null }); // 2 samples: suppressed
    await anonSend({ anonId: id, platform: 'web', events: [vital(300), vital(400), vital(500)] });
    r = await admin.client.get('/v1/admin/analytics/technical');
    row = r.body.webVitalsP75.find((x: any) => x.metric === 'TTFB' && x.platform === 'web');
    expect(row.samples).toBe(5);
    expect(row.p75).toBe(400);
    expect(JSON.stringify(r.body)).not.toContain(id);
  });

  it('reports signups and onboarding without individual rows', async () => {
    const admin = await staff('admin');
    await signup(t);
    const r = await admin.client.get('/v1/admin/analytics/acquisition', { days: '7' });
    expect(r.status).toBe(200);
    expect(r.body.periodDays).toBe(7);
    expect(Array.isArray(r.body.signupsPerDay)).toBe(true);
    expect(JSON.stringify(r.body)).not.toMatch(/@example|username|email/i);
    const e = await admin.client.get('/v1/admin/analytics/engagement');
    expect(e.body.definition).toMatch(/write action/);
    const ret = await admin.client.get('/v1/admin/analytics/retention', { weeks: '4' });
    expect(ret.body.cohorts.length).toBeGreaterThan(0);
    expect(ret.body.cohorts[ret.body.cohorts.length - 1].weeks[0].week).toBe(0);
  });
});

describe('Meaningful Social Actions', () => {
  const mkConversation = async (a: string, b: string) => {
    const c = (
      await sql(`INSERT INTO conversations (kind, direct_key) VALUES ('direct', $1) RETURNING id`, [
        uniq('dk'),
      ])
    ).rows[0].id as string;
    await sql(
      `INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1,$2), ($1,$3)`,
      [c, a, b],
    );
    return c;
  };
  const say = (
    conv: string,
    sender: string,
    ago = '0 days',
    extra: Partial<{ kind: string; status: string; deleted: boolean }> = {},
    n = 1,
  ) =>
    sql(
      `INSERT INTO messages (conversation_id, sender_id, kind, body, moderation_status, deleted_at, created_at)
       SELECT $1, $2, $3, 'hello', $4, CASE WHEN $5::boolean THEN now() ELSE NULL END, now() - $6::interval FROM generate_series(1, $7)`,
      [
        conv,
        sender,
        extra.kind ?? 'text',
        extra.status ?? 'approved',
        extra.deleted ?? false,
        ago,
        n,
      ],
    );
  const msa = async (admin: TestUser, weeks = 1) =>
    (await admin.client.get('/v1/admin/analytics/msa', { weeks: String(weeks) })).body;

  it('counts capped, moderated, genuinely social actions and applies small-cell suppression', async () => {
    await sql('TRUNCATE messages, comments, event_attendees, events, posts, conversations CASCADE');
    const admin = await staff('admin');
    const partner = await signup(t);
    const habitual: TestUser[] = [];
    for (let i = 0; i < 3; i++) {
      const u = await signup(t);
      habitual.push(u);
      const conv = await mkConversation(u.id, partner.id);
      await say(conv, u.id, '0 days', {}, 2);
      await say(conv, u.id, '1 day', {}, 1);
    }
    // Only 3 people: every cell is suppressed.
    let r = await msa(admin);
    expect(r.windows[0]).toMatchObject({ participants: null, mwp: null, mwpShare: null });
    expect(r.windows[0].actionsByType.message).toBe(9);

    for (let i = 0; i < 2; i++) {
      const u = await signup(t);
      habitual.push(u);
      const conv = await mkConversation(u.id, partner.id);
      await say(conv, u.id, '0 days', {}, 2);
      await say(conv, u.id, '2 days', {}, 1);
    }
    // A very busy single day: 50 messages are capped to 10 and one day is not "weekly participation".
    const spammer = await signup(t);
    await say(await mkConversation(spammer.id, partner.id), spammer.id, '0 days', {}, 50);

    // Things that are NOT meaningful social actions:
    const noise = await signup(t);
    const noiseConv = await mkConversation(noise.id, partner.id);
    await say(noiseConv, noise.id, '0 days', { kind: 'system' }, 3);
    await say(noiseConv, noise.id, '1 day', { status: 'removed' }, 3);
    await say(noiseConv, noise.id, '2 days', { deleted: true }, 3);
    const solo = (
      await sql(`INSERT INTO conversations (kind, direct_key) VALUES ('direct', $1) RETURNING id`, [
        uniq('dk'),
      ])
    ).rows[0].id as string;
    await sql(`INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1,$2)`, [
      solo,
      noise.id,
    ]);
    await say(solo, noise.id, '0 days', {}, 3); // talking to yourself
    await sql(`INSERT INTO follows (follower_id, followee_id) VALUES ($1,$2)`, [
      noise.id,
      partner.id,
    ]);

    // Posts and comments: partner has one public and one private post; commenter comments 4 times (< cell size).
    const pub = (
      await sql(
        `INSERT INTO posts (author_id, kind, body, visibility) VALUES ($1,'text','public post','public') RETURNING id`,
        [partner.id],
      )
    ).rows[0].id as string;
    await sql(
      `INSERT INTO posts (author_id, kind, body, visibility) VALUES ($1,'text','private post','private')`,
      [partner.id],
    );
    const commenter = await signup(t);
    await sql(
      `INSERT INTO comments (post_id, author_id, body) SELECT $1, $2, 'nice' FROM generate_series(1, 4)`,
      [pub, commenter.id],
    );
    await sql(`INSERT INTO comments (post_id, author_id, body) VALUES ($1, $2, 'my own post')`, [
      pub,
      partner.id,
    ]); // own post: not social
    await sql(`INSERT INTO reactions (user_id, target_type, target_id) VALUES ($1, 'post', $2)`, [
      noise.id,
      pub,
    ]);
    // Old activity belongs to the previous window only.
    const old = await signup(t);
    await say(await mkConversation(old.id, partner.id), old.id, '10 days', {}, 3);

    r = await msa(admin, 2);
    const now = r.windows[0];
    // messages: 5 habitual x 3 + spammer capped at 10 = 25
    expect(now.actionsByType.message).toBe(25);
    expect(now.actionsByType.comment).toBeNull(); // 4 < 5: suppressed
    expect(now.actionsByType.post).toBeNull(); // 1 public post: suppressed
    expect(now.actionsByType.plan).toBe(0);
    // participants: 5 habitual + spammer + commenter + partner (public post) = 8. MWP: only the 5 habitual.
    expect(now.participants).toBe(8);
    expect(now.mwp).toBe(5);
    expect(now.mwpShare).toBe(0.625);
    expect(r.windows[1].participants).toBeNull(); // the old user alone: suppressed
    expect(r.definition.dailyCapPerUserPerType).toEqual({
      message: 10,
      comment: 10,
      post: 5,
      plan: 5,
    });
    expect(r.definition.notMsa).toEqual(expect.arrayContaining(['reactions', 'follows', 'saves']));
    expect(JSON.stringify(r)).not.toContain(partner.id);
  });

  it("counts plans: RSVPs to other people's events and hosting published events, never drafts", async () => {
    await sql('TRUNCATE messages, comments, event_attendees, events, posts, conversations CASCADE');
    const admin = await staff('admin');
    const host = await signup(t);
    const guests: TestUser[] = [];
    for (let i = 0; i < 6; i++) guests.push(await signup(t));
    const ev = (
      await sql(
        `INSERT INTO events (title, host_id, starts_at, status, published_at) VALUES ('Picnic', $1, now() + interval '3 days', 'published', now()) RETURNING id`,
        [host.id],
      )
    ).rows[0].id as string;
    const draft = (
      await sql(
        `INSERT INTO events (title, host_id, starts_at, status) VALUES ('Secret draft', $1, now() + interval '3 days', 'draft') RETURNING id`,
        [host.id],
      )
    ).rows[0].id as string;
    for (const g of guests)
      await sql(`INSERT INTO event_attendees (event_id, user_id, status) VALUES ($1,$2,'going')`, [
        ev,
        g.id,
      ]);
    await sql(
      `INSERT INTO event_attendees (event_id, user_id, status) VALUES ($1,$2,'interested')`,
      [draft, host.id],
    ); // interested is not a plan
    await sql(`INSERT INTO event_attendees (event_id, user_id, status) VALUES ($1,$2,'going')`, [
      ev,
      host.id,
    ]); // host RSVP to own event: not social
    const r = await msa(admin);
    expect(r.windows[0].actionsByType.plan).toBe(7); // 6 RSVPs + 1 hosted published event
    expect(r.windows[0].mwp).toBe(0); // nobody has >= 3 actions on 2 days
  });
});
