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
import { expireEnforcements } from '../src/modules/safety/index.js';
import { getDeletionHooks } from '../src/lib/hooks.js';
import { screenProfileIdentity } from '../src/modules/safety/index.js';

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
const post = async (
  u: TestUser,
  body = `A perfectly ordinary post ${uniq('p')}`,
  extra: Record<string, unknown> = {},
) => {
  const r = await u.client.post('/v1/posts', { body, visibility: 'public', ...extra });
  if (r.status !== 201) throw new Error(`post failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id as string;
};
const report = (
  u: TestUser,
  targetType: string,
  targetId: string,
  reason = 'harassment',
  details?: string,
) =>
  u.client.post('/v1/reports', { targetType, targetId, reason, ...(details ? { details } : {}) });
const caseFor = async (targetId: string) =>
  (
    await sql(
      `SELECT * FROM moderation_cases WHERE target_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [targetId],
    )
  ).rows[0];
const decide = (
  s: TestUser,
  caseId: string,
  decision: string,
  extra: Record<string, unknown> = {},
) =>
  s.client.post(`/v1/staff/moderation/cases/${caseId}/decision`, {
    decision,
    reason: 'Violates the harassment policy',
    ...extra,
  });
const befriend = async (a: TestUser, b: TestUser) => {
  await a.client.post('/v1/friends/requests', { username: b.username });
  await b.client.post(`/v1/friends/requests/${a.id}/accept`);
};
const login = (u: TestUser) =>
  new Client(t, 'bearer').request('POST', '/v1/auth/login', {
    body: { email: u.email, password: u.password, deliver: 'token' },
  });

describe('creating reports', () => {
  it('requires authentication and valid input', async () => {
    const anon = new Client(t);
    expect(
      (
        await anon.post('/v1/reports', {
          targetType: 'post',
          targetId: crypto.randomUUID(),
          reason: 'spam',
        })
      ).status,
    ).toBe(401);
    const u = await signup(t);
    expect((await report(u, 'post', 'not-a-uuid')).status).toBe(400);
    expect((await report(u, 'post', crypto.randomUUID(), 'not_a_reason')).status).toBe(400);
    expect((await report(u, 'nonsense', crypto.randomUUID())).status).toBe(400);
  });

  it('opens a case for the first report and attaches later reports to it (deduped per reporter+target+reason)', async () => {
    const author = await signup(t);
    const [r1, r2, r3] = [await signup(t), await signup(t), await signup(t)];
    const p = await post(author);
    const first = await report(r1, 'post', p, 'harassment', 'This is targeted at me');
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ status: 'open', duplicate: false });
    const dup = await report(r1, 'post', p, 'harassment');
    expect(dup.status).toBe(200);
    expect(dup.body).toMatchObject({ id: first.body.id, duplicate: true });
    await report(r2, 'post', p, 'harassment');
    await report(r3, 'post', p, 'spam');
    const cases = (await sql('SELECT * FROM moderation_cases WHERE target_id = $1', [p])).rows;
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      target_type: 'post',
      subject_user_id: author.id,
      source: 'user_report',
      state: 'review',
      report_count: 3,
    });
    expect(cases[0].categories).toEqual(expect.arrayContaining(['harassment', 'spam']));
    expect(cases[0].risk_level).toBe('high'); // >= 3 distinct reporters bumps the risk
    expect(cases[0].content_snapshot.text).toContain('ordinary post');
    expect(
      (await sql('SELECT count(*)::int AS n FROM report_cases WHERE case_id = $1', [cases[0].id]))
        .rows[0].n,
    ).toBe(3);
  });

  it('refuses to report your own content and hides content the reporter cannot see', async () => {
    const author = await signup(t);
    const other = await signup(t);
    const own = await post(author);
    expect((await report(author, 'post', own)).status).toBe(422);
    expect((await report(author, 'user', author.id)).status).toBe(422);
    const followersOnly = await post(author, 'friends only thing', { visibility: 'followers' });
    expect((await report(other, 'post', followersOnly)).status).toBe(404);
    expect(await caseFor(followersOnly)).toBeUndefined();
    // once the reporter can see it, they can report it
    await other.client.put(`/v1/users/${author.username}/follow`);
    expect((await report(other, 'post', followersOnly)).status).toBe(201);
    // a blocked reporter cannot see the author's content either
    const blocked = await signup(t);
    await author.client.put(`/v1/users/${blocked.username}/block`);
    expect((await report(blocked, 'post', own)).status).toBe(404);
    expect((await report(blocked, 'user', author.id)).status).toBe(404);
  });

  it('supports every reportable target type and enforces visibility for each', async () => {
    const owner = await signup(t);
    const viewer = await signup(t);
    const outsider = await signup(t);
    await befriend(owner, viewer);

    // user
    expect((await report(viewer, 'user', owner.id)).status).toBe(201);
    // comment
    const p = await post(owner);
    const c = (await viewer.client.post(`/v1/posts/${p}/comments`, { body: 'nice' })).body.id;
    const commenter = await signup(t);
    expect((await report(commenter, 'comment', c)).status).toBe(201);
    expect((await report(owner, 'comment', c)).status).toBe(201); // post author may report a comment on their post
    // moment (friends visibility by default)
    const m = await owner.client.post('/v1/moments', {
      kind: 'text',
      body: 'hi friends',
      visibility: 'friends',
    });
    expect(m.status).toBe(201);
    expect((await report(outsider, 'moment', m.body.id)).status).toBe(404);
    expect((await report(viewer, 'moment', m.body.id)).status).toBe(201);
    // message: only conversation members
    const conv = (await owner.client.post('/v1/conversations/direct', { userId: viewer.id })).body
      .id;
    const msg = await owner.client.post(`/v1/conversations/${conv}/messages`, {
      body: 'private words',
    });
    expect(msg.status).toBe(201);
    expect((await report(outsider, 'message', msg.body.id)).status).toBe(404);
    expect((await report(viewer, 'message', msg.body.id)).status).toBe(201);
    const mc = await caseFor(msg.body.id);
    expect(mc.content_snapshot.text).toBe('private words');
    // community
    const slug = `${uniq('c')}x`;
    const com = (
      await sql(
        `INSERT INTO communities (slug, name, visibility, created_by) VALUES ($1,$2,'secret',$3) RETURNING id`,
        [slug, `Secret ${slug}`, owner.id],
      )
    ).rows[0].id;
    expect((await report(outsider, 'community', com)).status).toBe(404);
    // event
    const ev = (
      await sql(
        `INSERT INTO events (title, host_id, starts_at, visibility, status) VALUES ('Secret party', $1, now() + interval '2 days', 'private', 'published') RETURNING id`,
        [owner.id],
      )
    ).rows[0].id;
    expect((await report(outsider, 'event', ev)).status).toBe(404);
    const pubEv = (
      await sql(
        `INSERT INTO events (title, host_id, starts_at, visibility, status) VALUES ('Public meetup', $1, now() + interval '2 days', 'public', 'published') RETURNING id`,
        [owner.id],
      )
    ).rows[0].id;
    expect((await report(outsider, 'event', pubEv, 'scam')).status).toBe(201);
    // place, business, product, review, live session
    const place = (
      await sql(
        `INSERT INTO places (name, kind, latitude, longitude, created_by) VALUES ('Fake Cafe','restaurant', 1, 1, $1) RETURNING id`,
        [owner.id],
      )
    ).rows[0].id;
    expect((await report(outsider, 'place', place, 'other')).status).toBe(201);
    const biz = (
      await sql(
        `INSERT INTO businesses (owner_id, slug, name) VALUES ($1,$2,'Shady Shop') RETURNING id`,
        [owner.id, `${uniq('b')}xx`],
      )
    ).rows[0].id;
    expect((await report(outsider, 'business', biz, 'scam')).status).toBe(201);
    const prod = (
      await sql(
        `INSERT INTO products (business_id, kind, title, price_cents, currency) VALUES ($1,'physical','Magic beans', 100, 'USD') RETURNING id`,
        [biz],
      )
    ).rows[0].id;
    expect((await report(outsider, 'product', prod, 'scam')).status).toBe(201);
    const rev = (
      await sql(
        `INSERT INTO reviews (author_id, target_type, target_id, rating, body) VALUES ($1,'place',$2,1,'awful') RETURNING id`,
        [owner.id, place],
      )
    ).rows[0].id;
    expect((await report(outsider, 'review', rev)).status).toBe(201);
    const live = (
      await sql(
        `INSERT INTO live_sessions (host_id, title, status, visibility) VALUES ($1,'Live now','live','private') RETURNING id`,
        [owner.id],
      )
    ).rows[0].id;
    expect((await report(outsider, 'live_session', live)).status).toBe(404);
    // ownership resolved for non-user targets
    expect((await caseFor(biz)).subject_user_id).toBe(owner.id);
    expect((await caseFor(prod)).subject_user_id).toBe(owner.id);
  });

  it('escalates minor_safety reports to critical priority automatically', async () => {
    const author = await signup(t);
    const reporter = await signup(t);
    const p = await post(author);
    expect((await report(reporter, 'post', p, 'minor_safety')).status).toBe(201);
    expect(await caseFor(p)).toMatchObject({ risk_level: 'critical', state: 'escalated' });
    // a later low-risk report on a critical case does not lower it
    await report(await signup(t), 'post', p, 'spam');
    expect(await caseFor(p)).toMatchObject({ risk_level: 'critical', report_count: 2 });
  });

  it('sends support resources to the subject of a self-harm report without revealing the reporter', async () => {
    const author = await signup(t);
    const reporter = await signup(t);
    const p = await post(author);
    await report(reporter, 'post', p, 'self_harm');
    const { rows } = await sql(
      `SELECT kind, actor_id, data FROM notifications WHERE user_id = $1 AND kind = 'safety_support'`,
      [author.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBeNull();
    expect(JSON.stringify(rows[0].data)).not.toContain(reporter.id);
    // a second self-harm report on the same open case does not spam them
    await report(await signup(t), 'post', p, 'self_harm');
    expect(
      (
        await sql(`SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'safety_support'`, [
          author.id,
        ])
      ).rowCount,
    ).toBe(1);
  });

  it('lists my reports with a coarse outcome and never leaks the enforcement', async () => {
    const author = await signup(t);
    const reporter = await signup(t);
    const mod = await staff('moderator');
    const p = await post(author);
    await report(reporter, 'post', p, 'spam');
    let mine = await reporter.client.get('/v1/reports/mine');
    expect(mine.status).toBe(200);
    expect(mine.body.items[0]).toMatchObject({
      targetId: p,
      reason: 'spam',
      status: 'open',
      outcome: 'received',
    });
    const c = await caseFor(p);
    await mod.client.post(`/v1/staff/moderation/cases/${c.id}/claim`);
    mine = await reporter.client.get('/v1/reports/mine');
    expect(mine.body.items[0].outcome).toBe('under_review');
    await decide(mod, c.id, 'remove');
    mine = await reporter.client.get('/v1/reports/mine');
    expect(mine.body.items[0]).toMatchObject({ status: 'actioned', outcome: 'action_taken' });
    expect(JSON.stringify(mine.body)).not.toMatch(/enforcement|strike|suspend/i);
    // another user's reports are not visible
    expect((await author.client.get('/v1/reports/mine')).body.items).toHaveLength(0);
    // reporter got a generic update notification
    expect(
      (
        await sql(`SELECT data FROM notifications WHERE user_id = $1 AND kind = 'report_update'`, [
          reporter.id,
        ])
      ).rows[0].data,
    ).toEqual({ outcome: 'action_taken' });
  });

  it('rate limits report creation', async () => {
    const limited = await createTestApp({ RATE_LIMIT_ENABLED: 'true' });
    try {
      const u = await signup(limited);
      const author = await signup(limited);
      const p = (
        await author.client.post('/v1/posts', { body: 'rate limit target', visibility: 'public' })
      ).body.id;
      const statuses: number[] = [];
      for (let i = 0; i < 22; i++)
        statuses.push(
          (
            await u.client.post('/v1/reports', {
              targetType: 'post',
              targetId: p,
              reason: i % 2 ? 'spam' : 'other',
            })
          ).status,
        );
      expect(statuses.slice(0, 2)).toEqual([201, 201]);
      expect(statuses.at(-1)).toBe(429);
    } finally {
      await limited.close();
    }
  });
});

describe('staff authorization matrix', () => {
  it('rejects anonymous users, ordinary users, and staff without MFA from the moderation console', async () => {
    const anon = new Client(t);
    const user = await signup(t);
    const noMfa = await signup(t);
    await sql(`UPDATE users SET platform_role = 'moderator' WHERE id = $1`, [noMfa.id]);
    const mod = await staff('moderator');
    const paths = [
      '/v1/staff/moderation/cases',
      '/v1/staff/moderation/queue-stats',
      '/v1/staff/moderation/appeals',
    ];
    for (const path of paths) {
      expect((await anon.get(path)).status).toBe(401);
      expect((await user.client.get(path)).status).toBe(403);
      const r = await noMfa.client.get(path);
      expect(r.status).toBe(403);
      expect(r.body.error.message).toMatch(/multi-factor/i);
      expect((await mod.client.get(path)).status).toBe(200);
    }
    expect(
      (
        await user.client.post(`/v1/staff/moderation/cases/${crypto.randomUUID()}/decision`, {
          decision: 'remove',
          reason: 'nope nope',
        })
      ).status,
    ).toBe(403);
  });

  it('support can read cases through the admin API but cannot use the moderation console', async () => {
    const support = await staff('support');
    const admin = await staff('admin');
    const author = await signup(t);
    const p = await post(author);
    await report(await signup(t), 'post', p, 'harassment');
    const c = await caseFor(p);
    expect((await support.client.get('/v1/staff/moderation/cases')).status).toBe(403);
    expect(
      (
        await support.client.post(`/v1/staff/moderation/cases/${c.id}/decision`, {
          decision: 'remove',
          reason: 'Because I said so',
        })
      ).status,
    ).toBe(403);
    const list = await support.client.get('/v1/admin/cases');
    expect(list.status).toBe(200);
    const detailSupport = await support.client.get(`/v1/admin/cases/${c.id}`);
    expect(detailSupport.status).toBe(200);
    expect(detailSupport.body.reports[0].reporterId).toBeUndefined(); // support does not see who reported
    const detailAdmin = await admin.client.get(`/v1/admin/cases/${c.id}`);
    expect(detailAdmin.body.reports[0].reporterId).toBeTruthy();
    expect((await support.client.get('/v1/admin/reports')).body.items[0].reporterId).toBeNull();
  });
});

describe('case queue', () => {
  it('orders by risk then age, filters, and paginates with a keyset cursor', async () => {
    await sql(`UPDATE moderation_cases SET state = 'resolved' WHERE state <> 'resolved'`); // isolate this test's queue
    const mod = await staff('moderator');
    const author = await signup(t);
    const mk = async (reason: string) => {
      const p = await post(author);
      await report(await signup(t), 'post', p, reason);
      return (await caseFor(p)).id as string;
    };
    const low1 = await mk('spam');
    const high = await mk('violence');
    const low2 = await mk('spam');
    const crit = await mk('minor_safety');
    const med = await mk('harassment');
    await sql(`UPDATE moderation_cases SET created_at = now() - interval '2 days' WHERE id = $1`, [
      low2,
    ]);
    const list = await mod.client.get('/v1/staff/moderation/cases');
    expect(list.body.items.map((i: any) => i.id)).toEqual([crit, high, med, low2, low1]);
    expect(list.body.items[0].pipeline).toMatchObject({ current: 'escalate' });
    // pagination
    const p1 = await mod.client.get('/v1/staff/moderation/cases', { limit: '2' });
    expect(p1.body.items.map((i: any) => i.id)).toEqual([crit, high]);
    const p2 = await mod.client.get('/v1/staff/moderation/cases', {
      limit: '2',
      cursor: p1.body.nextCursor,
    });
    expect(p2.body.items.map((i: any) => i.id)).toEqual([med, low2]);
    const p3 = await mod.client.get('/v1/staff/moderation/cases', {
      limit: '2',
      cursor: p2.body.nextCursor,
    });
    expect(p3.body.items.map((i: any) => i.id)).toEqual([low1]);
    expect(p3.body.nextCursor).toBeNull();
    // filters
    expect(
      (await mod.client.get('/v1/staff/moderation/cases', { risk: 'high' })).body.items.map(
        (i: any) => i.id,
      ),
    ).toEqual([high]);
    expect(
      (await mod.client.get('/v1/staff/moderation/cases', { state: 'escalated' })).body.items.map(
        (i: any) => i.id,
      ),
    ).toEqual([crit]);
    expect(
      (await mod.client.get('/v1/staff/moderation/cases', { category: 'spam' })).body.items,
    ).toHaveLength(2);
    await mod.client.post(`/v1/staff/moderation/cases/${med}/claim`);
    expect(
      (await mod.client.get('/v1/staff/moderation/cases', { assigned: 'me' })).body.items.map(
        (i: any) => i.id,
      ),
    ).toEqual([med]);
    expect(
      (await mod.client.get('/v1/staff/moderation/cases', { assigned: 'none' })).body.items,
    ).toHaveLength(4);
    expect((await mod.client.get('/v1/staff/moderation/cases', { limit: '500' })).status).toBe(400);
    expect(
      (await mod.client.get('/v1/staff/moderation/cases', { cursor: 'garbage!!' })).status,
    ).toBe(400);
    const stats = await mod.client.get('/v1/staff/moderation/queue-stats');
    expect(stats.body.queue.reduce((s: number, q: any) => s + q.count, 0)).toBe(5);
  });

  it('shows the case detail with snapshot, signals, current content, timeline and ladder preview', async () => {
    const mod = await staff('moderator');
    const author = await signup(t);
    const p = await post(author, 'Original text of the reported post');
    await report(await signup(t), 'post', p, 'harassment', 'please look');
    const c = await caseFor(p);
    await author.client.patch(`/v1/posts/${p}`, { body: 'Edited afterwards' });
    const d = await mod.client.get(`/v1/staff/moderation/cases/${c.id}`);
    expect(d.status).toBe(200);
    expect(d.body.snapshot.text).toBe('Original text of the reported post'); // evidence survives edits
    expect(d.body.currentContent.text).toBe('Edited afterwards');
    expect(d.body.reports[0]).toMatchObject({ reason: 'harassment', details: 'please look' });
    expect(d.body.timeline[0].event).toBe('case_opened');
    expect(d.body.subjectSummary).toMatchObject({ id: author.id, activeStrikePoints: 0 });
    expect(d.body.ladderPreview).toMatchObject({ action: 'warning', totalPoints: 1 });
    expect(d.body.pipeline.path).toEqual(['content', 'analysis', 'risk', 'review']);
    expect((await mod.client.get(`/v1/staff/moderation/cases/${crypto.randomUUID()}`)).status).toBe(
      404,
    );
    expect(
      (
        await sql(
          `SELECT 1 FROM audit_logs WHERE action = 'moderation.case_viewed' AND target_id = $1`,
          [c.id],
        )
      ).rowCount,
    ).toBe(1);
  });
});

describe('claiming and escalation', () => {
  it('lets one moderator claim a case; others get a conflict; admins can take over', async () => {
    const [m1, m2, admin] = [
      await staff('moderator'),
      await staff('moderator'),
      await staff('admin'),
    ];
    const p = await post(await signup(t));
    await report(await signup(t), 'post', p, 'harassment');
    const c = await caseFor(p);
    expect((await m1.client.post(`/v1/staff/moderation/cases/${c.id}/claim`)).status).toBe(200);
    expect((await m2.client.post(`/v1/staff/moderation/cases/${c.id}/claim`)).status).toBe(409);
    expect((await decide(m2, c.id, 'remove')).status).toBe(409);
    expect((await m2.client.post(`/v1/staff/moderation/cases/${c.id}/release`)).status).toBe(403);
    expect((await m1.client.post(`/v1/staff/moderation/cases/${c.id}/release`)).status).toBe(200);
    expect((await m2.client.post(`/v1/staff/moderation/cases/${c.id}/claim`)).status).toBe(200);
    expect((await admin.client.post(`/v1/staff/moderation/cases/${c.id}/claim`)).status).toBe(200);
    expect(
      (await sql('SELECT assigned_to FROM moderation_cases WHERE id = $1', [c.id])).rows[0]
        .assigned_to,
    ).toBe(admin.id);
  });

  it('escalated cases are admin-only for claiming and deciding', async () => {
    const mod = await staff('moderator');
    const admin = await staff('admin');
    const p = await post(await signup(t));
    await report(await signup(t), 'post', p, 'harassment');
    const c = await caseFor(p);
    expect(
      (
        await mod.client.post(`/v1/staff/moderation/cases/${c.id}/escalate`, {
          note: 'looks coordinated',
        })
      ).status,
    ).toBe(200);
    expect(await caseFor(p)).toMatchObject({ state: 'escalated', assigned_to: null });
    expect((await mod.client.post(`/v1/staff/moderation/cases/${c.id}/claim`)).status).toBe(403);
    expect((await decide(mod, c.id, 'remove')).status).toBe(403);
    expect((await decide(admin, c.id, 'remove')).status).toBe(200);
  });
});

describe('decisions and their real effects', () => {
  it('remove: hides the post, records a strike, notifies the author, audits, and closes the case', async () => {
    const mod = await staff('moderator');
    const author = await signup(t);
    const viewer = await signup(t);
    const p = await post(author);
    expect((await viewer.client.get(`/v1/posts/${p}`)).status).toBe(200);
    await report(viewer, 'post', p, 'harassment');
    const c = await caseFor(p);
    const res = await decide(mod, c.id, 'remove', { note: 'internal: repeat offender' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      decision: 'remove',
      state: 'resolved',
      contentEffects: 1,
      strike: { pointsAdded: 1, totalPoints: 1, ladderAction: 'warning' },
    });
    expect((await viewer.client.get(`/v1/posts/${p}`)).status).toBe(404);
    expect((await author.client.get(`/v1/posts/${p}`)).status).toBe(404); // removed content is hidden from its author too
    expect(
      (await sql('SELECT moderation_status FROM posts WHERE id = $1', [p])).rows[0]
        .moderation_status,
    ).toBe('removed');
    const enf = (await sql('SELECT * FROM enforcements WHERE user_id = $1', [author.id])).rows;
    expect(enf).toHaveLength(1);
    expect(enf[0]).toMatchObject({
      kind: 'content_removed',
      strike_points: 1,
      case_id: c.id,
      created_by: mod.id,
    });
    expect(await caseFor(p)).toMatchObject({
      state: 'resolved',
      decision: 'remove',
      decided_by: mod.id,
    });
    const note = (
      await sql(
        `SELECT data FROM notifications WHERE user_id = $1 AND kind = 'moderation_decision'`,
        [author.id],
      )
    ).rows[0];
    expect(note.data).toMatchObject({
      decision: 'remove',
      reason: 'Violates the harassment policy',
      appealable: true,
    });
    expect(JSON.stringify(note.data)).not.toContain('repeat offender'); // internal notes never reach the user
    const log = (
      await sql(
        `SELECT actor_id, actor_type, metadata FROM audit_logs WHERE action = 'moderation.decision' AND target_id = $1`,
        [c.id],
      )
    ).rows;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actor_id: mod.id, actor_type: 'staff' });
    // deciding twice is a conflict
    expect((await decide(mod, c.id, 'no_action')).status).toBe(409);
  });

  it('remove on comments, moments and messages sets moderation_status', async () => {
    const mod = await staff('moderator');
    const author = await signup(t);
    const friend = await signup(t);
    await befriend(author, friend);
    const p = await post(author);
    const comment = (
      await friend.client.post(`/v1/posts/${p}/comments`, { body: 'a rude comment' })
    ).body.id;
    const moment = (
      await author.client.post('/v1/moments', {
        kind: 'text',
        body: 'bad moment',
        visibility: 'friends',
      })
    ).body.id;
    const conv = (await author.client.post('/v1/conversations/direct', { userId: friend.id })).body
      .id;
    const message = (
      await author.client.post(`/v1/conversations/${conv}/messages`, { body: 'bad message' })
    ).body.id;
    const commenter2 = await signup(t);
    await report(commenter2, 'comment', comment);
    await report(friend, 'moment', moment);
    await report(friend, 'message', message);
    for (const [type, id, table] of [
      ['comment', comment, 'comments'],
      ['moment', moment, 'moments'],
      ['message', message, 'messages'],
    ] as const) {
      const c = await caseFor(id);
      expect((await decide(mod, c.id, 'remove')).status).toBe(200);
      expect(
        (await sql(`SELECT moderation_status FROM ${table} WHERE id = $1`, [id])).rows[0]
          .moderation_status,
      ).toBe('removed');
      expect(c.target_type).toBe(type);
    }
    expect((await friend.client.get(`/v1/moments/${moment}`)).status).toBe(404);
  });

  it('limit_reach restricts visibility, label keeps content with a label, no_action releases an automated restriction', async () => {
    const mod = await staff('moderator');
    const author = await signup(t);
    const viewer = await signup(t);
    const p1 = await post(author);
    await report(viewer, 'post', p1, 'misinformation');
    expect((await decide(mod, (await caseFor(p1)).id, 'limit_reach')).status).toBe(200);
    expect((await viewer.client.get(`/v1/posts/${p1}`)).status).toBe(404);
    expect(
      (await sql('SELECT moderation_status FROM posts WHERE id = $1', [p1])).rows[0]
        .moderation_status,
    ).toBe('restricted');
    expect(
      (await sql(`SELECT kind FROM enforcements WHERE user_id = $1`, [author.id])).rows.map(
        (r: any) => r.kind,
      ),
    ).toContain('limit_reach');

    const p2 = await post(author);
    await report(viewer, 'post', p2, 'misinformation');
    expect((await decide(mod, (await caseFor(p2)).id, 'label')).status).toBe(200);
    expect((await viewer.client.get(`/v1/posts/${p2}`)).status).toBe(200);
    expect(
      (await sql('SELECT metadata FROM posts WHERE id = $1', [p2])).rows[0].metadata.moderationLabel
        .reason,
    ).toBeTruthy();

    // an automated restriction is released by "no action"
    const p3 = await post(author, 'Guaranteed profit! risk-free returns for everyone');
    expect(
      (await sql('SELECT moderation_status FROM posts WHERE id = $1', [p3])).rows[0]
        .moderation_status,
    ).toBe('pending_review');
    const before = (
      await sql('SELECT count(*)::int AS n FROM enforcements WHERE user_id = $1', [author.id])
    ).rows[0].n;
    expect((await decide(mod, (await caseFor(p3)).id, 'no_action')).status).toBe(200);
    expect(
      (await sql('SELECT moderation_status FROM posts WHERE id = $1', [p3])).rows[0]
        .moderation_status,
    ).toBe('approved');
    expect(
      (await sql('SELECT count(*)::int AS n FROM enforcements WHERE user_id = $1', [author.id]))
        .rows[0].n,
    ).toBe(before);
    expect((await viewer.client.get(`/v1/posts/${p3}`)).status).toBe(200);
  });

  it('validates decisions', async () => {
    const mod = await staff('moderator');
    const target = await signup(t);
    await report(await signup(t), 'user', target.id, 'impersonation');
    const c = await caseFor(target.id);
    expect((await decide(mod, c.id, 'remove')).status).toBe(400); // use suspend/ban for accounts
    expect((await decide(mod, c.id, 'explode')).status).toBe(400);
    expect(
      (await mod.client.post(`/v1/staff/moderation/cases/${c.id}/decision`, { decision: 'label' }))
        .status,
    ).toBe(400); // reason is required
    expect((await decide(mod, crypto.randomUUID(), 'label')).status).toBe(404);
  });

  it('suspend_user locks the account out immediately: sessions revoked, login refused, status changed, appeal email sent', async () => {
    const mod = await staff('moderator');
    const victim = await signup(t, { mode: 'bearer' });
    const other = await signup(t);
    expect((await victim.client.get('/v1/auth/me')).status).toBe(200);
    const p = await post(victim);
    await report(other, 'post', p, 'hate');
    const c = await caseFor(p);
    const res = await decide(mod, c.id, 'suspend_user', { durationDays: 3 });
    expect(res.status).toBe(200);
    expect((await victim.client.get('/v1/auth/me')).status).toBe(401); // session revoked
    expect((await sql('SELECT status FROM users WHERE id = $1', [victim.id])).rows[0].status).toBe(
      'suspended',
    );
    expect(
      (
        await sql(
          'SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL',
          [victim.id],
        )
      ).rows[0].n,
    ).toBe(0);
    const l = await login(victim);
    expect(l.status).toBe(403);
    const enf = (
      await sql(`SELECT * FROM enforcements WHERE user_id = $1 AND kind = 'suspension'`, [
        victim.id,
      ])
    ).rows[0];
    expect(enf.ends_at.getTime()).toBeGreaterThan(Date.now() + 2.9 * 86400_000);
    expect(enf.metadata.previousStatus).toBe('active');
    expect(t.email.last(victim.email)?.text).toMatch(/appeal\?token=/);
    expect(
      (
        await sql(`SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'account_suspended'`, [
          victim.id,
        ])
      ).rowCount,
    ).toBe(1);
    // a suspended user's content is hidden as well
    expect((await other.client.get(`/v1/posts/${p}`)).status).toBe(404);
  });

  it('ban_user is admin-only, permanent, and staff cannot be acted on by equal or lower ranks', async () => {
    const mod = await staff('moderator');
    const admin = await staff('admin');
    const victim = await signup(t);
    const p = await post(victim);
    await report(await signup(t), 'post', p, 'illegal');
    const c = await caseFor(p);
    expect((await decide(mod, c.id, 'ban_user')).status).toBe(403);
    expect((await decide(admin, c.id, 'ban_user')).status).toBe(200);
    const enf = (
      await sql(`SELECT * FROM enforcements WHERE user_id = $1 AND kind = 'ban'`, [victim.id])
    ).rows[0];
    expect(enf.ends_at).toBeNull();
    expect((await login(victim)).status).toBe(403);

    // staff cannot suspend a staff member of equal/higher rank
    const peer = await staff('moderator');
    const pp = await post(peer);
    await report(await signup(t), 'post', pp, 'harassment');
    expect((await decide(mod, (await caseFor(pp)).id, 'suspend_user')).status).toBe(403);
    expect((await decide(admin, (await caseFor(pp)).id, 'suspend_user')).status).toBe(200);
    // nobody decides a case about themselves
    const own = await post(mod);
    await report(await signup(t), 'post', own, 'harassment');
    expect((await decide(mod, (await caseFor(own)).id, 'remove')).status).toBe(403);
  });

  it('applies the strike ladder: warning, then limited reach, then a suspension', async () => {
    const mod = await staff('moderator');
    const offender = await signup(t);
    const results: any[] = [];
    for (let i = 0; i < 3; i++) {
      const p = await post(offender);
      await report(await signup(t), 'post', p, 'harassment');
      results.push((await decide(mod, (await caseFor(p)).id, 'remove')).body);
    }
    expect(results.map((r) => r.strike.ladderAction)).toEqual([
      'warning',
      'limit_reach',
      'suspension',
    ]);
    expect(results.map((r) => r.strike.totalPoints)).toEqual([1, 2, 3]);
    expect(
      (await sql('SELECT status FROM users WHERE id = $1', [offender.id])).rows[0].status,
    ).toBe('suspended');
    const kinds = (
      await sql(
        'SELECT kind, strike_points FROM enforcements WHERE user_id = $1 ORDER BY created_at',
        [offender.id],
      )
    ).rows;
    expect(kinds.map((k: any) => k.kind)).toEqual([
      'content_removed',
      'content_removed',
      'limit_reach',
      'content_removed',
      'suspension',
    ]);
    // the enforcement history shows through the user-facing API (after reinstatement)
    await sql(
      `UPDATE enforcements SET ends_at = now() - interval '1 minute' WHERE user_id = $1 AND kind = 'suspension'`,
      [offender.id],
    );
    expect((await expireEnforcements(t.ctx)).reinstated).toBeGreaterThanOrEqual(1);
    const back = await login(offender);
    expect(back.status).toBe(200);
    const hist = (await back.body.token)
      ? await (async () => {
          const c = new Client(t, 'bearer');
          c.token = back.body.token;
          return c.get('/v1/safety/enforcements');
        })()
      : null;
    expect(hist?.status).toBe(200);
    expect(hist!.body.items.length).toBe(5);
    expect(hist!.body.items.find((i: any) => i.kind === 'suspension')).toMatchObject({
      active: false,
    });
  });

  it('a decision on a critical threat skips the ladder (zero tolerance category)', async () => {
    const mod = await staff('admin');
    const author = await signup(t);
    const p = await post(author, 'I will kill you tomorrow');
    const c = await caseFor(p);
    expect(c.state).toBe('escalated');
    const res = await decide(mod, c.id, 'remove');
    expect(res.body.strike).toMatchObject({ ladderAction: 'suspension', ladderDays: 14 });
  });
});

describe('appeals', () => {
  async function removedPost() {
    const mod = await staff('moderator');
    const author = await signup(t);
    const viewer = await signup(t);
    const p = await post(author);
    await report(viewer, 'post', p, 'harassment');
    const c = await caseFor(p);
    await decide(mod, c.id, 'remove');
    return { mod, author, viewer, p, caseId: c.id as string };
  }

  it('lets the affected user appeal once; others cannot see or appeal the case', async () => {
    const { author, viewer, caseId, p } = await removedPost();
    expect(
      (await viewer.client.post('/v1/appeals', { caseId, statement: 'not mine' })).status,
    ).toBe(404);
    expect((await new Client(t).post('/v1/appeals', { caseId, statement: 'anon' })).status).toBe(
      401,
    );
    expect((await author.client.post('/v1/appeals', { caseId })).status).toBe(400);
    const a = await author.client.post('/v1/appeals', {
      caseId,
      statement: 'This was a joke between friends, please review.',
    });
    expect(a.status).toBe(201);
    expect(await caseFor(p)).toMatchObject({ state: 'appealed' });
    expect((await author.client.post('/v1/appeals', { caseId, statement: 'again' })).status).toBe(
      409,
    );
    const mine = await author.client.get('/v1/appeals/mine');
    expect(mine.body.items[0]).toMatchObject({ caseId, status: 'open' });
    const hist = await author.client.get('/v1/safety/enforcements');
    expect(hist.body.items[0]).toMatchObject({
      kind: 'content_removed',
      appeal: { status: 'open', canAppeal: false },
    });
  });

  it('enforces the appeal window and refuses appeals of no_action decisions', async () => {
    const { author, caseId } = await removedPost();
    await sql(`UPDATE moderation_cases SET decided_at = now() - interval '15 days' WHERE id = $1`, [
      caseId,
    ]);
    const late = await author.client.post('/v1/appeals', { caseId, statement: 'too late' });
    expect(late.status).toBe(422);
    const hist = await author.client.get('/v1/safety/enforcements');
    expect(hist.body.items[0].appeal.canAppeal).toBe(false);

    const mod = await staff('moderator');
    const a2 = await signup(t);
    const p = await post(a2);
    await report(await signup(t), 'post', p, 'spam');
    await decide(mod, (await caseFor(p)).id, 'no_action');
    expect(
      (
        await a2.client.post('/v1/appeals', {
          caseId: (await caseFor(p)).id,
          statement: 'nothing to appeal',
        })
      ).status,
    ).toBe(404);
  });

  it('requires a different reviewer than the original decider (also enforced by the database)', async () => {
    const { mod, author, caseId } = await removedPost();
    const other = await staff('moderator');
    const admin = await staff('admin');
    const a = await author.client.post('/v1/appeals', {
      caseId,
      statement: 'Please look again, thank you.',
    });
    const same = await mod.client.post(`/v1/staff/moderation/appeals/${a.body.id}/review`, {
      outcome: 'overturned',
      note: 'I changed my mind',
    });
    expect(same.status).toBe(403);
    expect(same.body.error.message).toMatch(/different staff member/);
    expect(
      (await sql('SELECT status FROM appeals WHERE id = $1', [a.body.id])).rows[0].status,
    ).toBe('open');
    // the DB constraint is a second line of defence
    await expect(
      sql(`UPDATE appeals SET reviewer_id = $2, status = 'upheld' WHERE id = $1`, [
        a.body.id,
        mod.id,
      ]),
    ).rejects.toThrow(/appeal_reviewer_not_original_decider/);
    // an appellant cannot review their own appeal even if they were staff
    const listed = await other.client.get('/v1/staff/moderation/appeals');
    expect(
      listed.body.items.some((i: any) => i.id === a.body.id && i.originalDeciderId === mod.id),
    ).toBe(true);
    expect(
      (
        await other.client.post(`/v1/staff/moderation/appeals/${a.body.id}/review`, {
          outcome: 'upheld',
          note: 'x',
        })
      ).status,
    ).toBe(400); // note too short
    const ok = await admin.client.post(`/v1/staff/moderation/appeals/${a.body.id}/review`, {
      outcome: 'upheld',
      note: 'Decision stands.',
    });
    expect(ok.status).toBe(200);
    expect(
      (
        await admin.client.post(`/v1/staff/moderation/appeals/${a.body.id}/review`, {
          outcome: 'overturned',
          note: 'Too late now',
        })
      ).status,
    ).toBe(409);
  });

  it('upheld appeals keep the decision and resolve the case; the user is told', async () => {
    const { author, caseId, p } = await removedPost();
    const reviewer = await staff('moderator');
    const a = await author.client.post('/v1/appeals', {
      caseId,
      statement: 'Please look again, thank you.',
    });
    expect(
      (
        await reviewer.client.post(`/v1/staff/moderation/appeals/${a.body.id}/review`, {
          outcome: 'upheld',
          note: 'Reviewed: violation confirmed.',
        })
      ).status,
    ).toBe(200);
    expect(await caseFor(p)).toMatchObject({ state: 'resolved', decision: 'remove' });
    expect(
      (await sql('SELECT moderation_status FROM posts WHERE id = $1', [p])).rows[0]
        .moderation_status,
    ).toBe('removed');
    expect(
      (
        await sql(
          `SELECT data FROM notifications WHERE user_id = $1 AND kind = 'moderation_appeal_result'`,
          [author.id],
        )
      ).rows[0].data,
    ).toMatchObject({ outcome: 'upheld' });
    expect((await author.client.get('/v1/appeals/mine')).body.items[0].status).toBe('upheld');
  });

  it('overturned appeals restore the content and revoke the enforcement (strikes no longer count)', async () => {
    const { author, viewer, caseId, p } = await removedPost();
    const reviewer = await staff('moderator');
    const a = await author.client.post('/v1/appeals', {
      caseId,
      statement: 'This was quoting a news headline.',
    });
    const r = await reviewer.client.post(`/v1/staff/moderation/appeals/${a.body.id}/review`, {
      outcome: 'overturned',
      note: 'Context was missed.',
    });
    expect(r.status).toBe(200);
    expect(r.body.restored).toBe(1);
    expect((await viewer.client.get(`/v1/posts/${p}`)).status).toBe(200);
    expect(
      (await sql('SELECT revoked_at FROM enforcements WHERE case_id = $1', [caseId])).rows.every(
        (e: any) => e.revoked_at,
      ),
    ).toBe(true);
    const detail = await reviewer.client.get(`/v1/staff/moderation/cases/${caseId}`);
    expect(detail.body.subjectSummary.activeStrikePoints).toBe(0);
    expect(detail.body.timeline.map((e: any) => e.event)).toEqual(
      expect.arrayContaining(['decided', 'appeal_opened', 'appeal_overturned']),
    );
    const hist = await author.client.get('/v1/safety/enforcements');
    expect(hist.body.items[0]).toMatchObject({ active: false, revoked: true });
  });

  it('a suspended user appeals with the token from their email, and an overturn reinstates them', async () => {
    const mod = await staff('moderator');
    const reviewer = await staff('moderator');
    const victim = await signup(t);
    const p = await post(victim);
    await report(await signup(t), 'post', p, 'hate');
    const c = await caseFor(p);
    await decide(mod, c.id, 'suspend_user', { durationDays: 7 });
    expect((await login(victim)).status).toBe(403);
    const token = /token=([\w-]+)/.exec(t.email.last(victim.email)!.text)![1]!;
    expect(
      (await new Client(t).post('/v1/appeals', { token: 'x'.repeat(43), statement: 'wrong token' }))
        .status,
    ).toBe(401);
    const a = await new Client(t).post('/v1/appeals', {
      token,
      statement: 'I was suspended by mistake, my account was shared.',
    });
    expect(a.status).toBe(201);
    expect(
      (
        await reviewer.client.post(`/v1/staff/moderation/appeals/${a.body.id}/review`, {
          outcome: 'overturned',
          note: 'Mistaken identity.',
        })
      ).status,
    ).toBe(200);
    expect((await sql('SELECT status FROM users WHERE id = $1', [victim.id])).rows[0].status).toBe(
      'active',
    );
    expect((await login(victim)).status).toBe(200);
    expect(
      (await sql('SELECT moderation_status FROM posts WHERE id = $1', [p])).rows[0]
        .moderation_status,
    ).toBe('approved');
  });

  it('only admins review appeals of bans', async () => {
    const admin = await staff('admin');
    const mod = await staff('moderator');
    const victim = await signup(t);
    const p = await post(victim);
    await report(await signup(t), 'post', p, 'illegal');
    await decide(admin, (await caseFor(p)).id, 'ban_user');
    const token = /token=([\w-]+)/.exec(t.email.last(victim.email)!.text)![1]!;
    const a = await new Client(t).post('/v1/appeals', {
      token,
      statement: 'Please reconsider my ban, it was an error.',
    });
    expect(
      (
        await mod.client.post(`/v1/staff/moderation/appeals/${a.body.id}/review`, {
          outcome: 'upheld',
          note: 'moderator cannot',
        })
      ).status,
    ).toBe(403);
    const otherAdmin = await staff('admin');
    expect(
      (
        await otherAdmin.client.post(`/v1/staff/moderation/appeals/${a.body.id}/review`, {
          outcome: 'upheld',
          note: 'Ban confirmed.',
        })
      ).status,
    ).toBe(200);
  });
});

describe('automated signals', () => {
  it('opens cases for risky content (with an evidence snapshot) and sends self-harm authors support resources', async () => {
    const author = await signup(t);
    const p = await post(author, 'I want to end my life');
    const c = await caseFor(p);
    expect(c).toMatchObject({ source: 'automated', state: 'review' });
    expect(c.categories).toContain('self_harm');
    expect(c.content_snapshot.text).toBe('I want to end my life');
    expect(
      (
        await sql(`SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'safety_support'`, [
          author.id,
        ])
      ).rowCount,
    ).toBe(1);
  });

  it('restricts a burst of identical copy-paste posts as spam without touching normal posting', async () => {
    const spammer = await signup(t);
    const normal = await signup(t);
    for (let i = 0; i < 6; i++)
      await post(normal, `Different thought number ${i} about the day, quite unique ${uniq('x')}`);
    expect(
      (
        await sql(`SELECT count(*)::int AS n FROM moderation_cases WHERE subject_user_id = $1`, [
          normal.id,
        ])
      ).rows[0].n,
    ).toBe(0);
    const text = 'Buy the cheapest followers and likes today at my amazing store, limited offer!';
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push(await post(spammer, text));
    const statuses = (
      await sql(
        'SELECT id, moderation_status FROM posts WHERE author_id = $1 ORDER BY created_at, id',
        [spammer.id],
      )
    ).rows;
    expect(statuses.slice(0, 4).every((r: any) => r.moderation_status === 'approved')).toBe(true);
    expect(statuses.at(-1).moderation_status).toBe('restricted');
    const c = (
      await sql(
        `SELECT * FROM moderation_cases WHERE subject_user_id = $1 AND 'spam' = ANY(categories) ORDER BY created_at DESC`,
        [spammer.id],
      )
    ).rows;
    expect(c.length).toBeGreaterThanOrEqual(1);
    expect(c[0].signals.spam.reasons).toContain('duplicate_content');
    expect(
      (await sql(`SELECT 1 FROM safety_signals WHERE user_id = $1`, [spammer.id])).rowCount,
    ).toBeGreaterThanOrEqual(1);
  });
});

describe('support resources', () => {
  it('returns curated, region-aware resources marked as needing regional review, publicly', async () => {
    const anon = new Client(t);
    const us = await anon.get('/v1/safety/resources', { region: 'us' });
    expect(us.status).toBe(200);
    expect(us.body).toMatchObject({
      resolvedRegion: 'US',
      reviewStatus: 'needs_regional_review',
      emergency: { number: '911' },
    });
    expect(us.body.resources.some((r: any) => r.phone === '988')).toBe(true);
    const ng = await anon.get('/v1/safety/resources', { region: 'NG' });
    expect(ng.body.resolvedRegion).toBeNull();
    expect(ng.body.resources).toEqual([]);
    expect(ng.body.directories.some((d: any) => d.url === 'https://findahelpline.com')).toBe(true);
    expect((await anon.get('/v1/safety/resources')).status).toBe(200);
    expect((await anon.get('/v1/safety/resources', { region: 'USA' })).status).toBe(400);
  });
});

describe('guardian links (minor safety)', () => {
  it('teen invites, adult accepts, guardian sees settings and enforcement summary but never content', async () => {
    const teen = await teenUser();
    const guardian = await signup(t);
    const stranger = await signup(t);
    const friend = await teenUser();
    await befriend(teen, friend);
    const conv = (await teen.client.post('/v1/conversations/direct', { userId: friend.id })).body
      .id;
    await teen.client.post(`/v1/conversations/${conv}/messages`, { body: 'secret teen chat' });

    expect(
      (await guardian.client.post('/v1/safety/guardians', { guardianUsername: teen.username }))
        .status,
    ).toBe(403); // adults cannot invite
    expect(
      (await teen.client.post('/v1/safety/guardians', { guardianUsername: friend.username }))
        .status,
    ).toBe(400); // guardian must be adult
    expect(
      (await teen.client.post('/v1/safety/guardians', { guardianUsername: guardian.username }))
        .status,
    ).toBe(201);
    expect(
      (await teen.client.post('/v1/safety/guardians', { guardianUsername: guardian.username }))
        .status,
    ).toBe(409);
    // pending links give no access
    expect(
      (await guardian.client.get(`/v1/safety/guardian/minors/${teen.id}/summary`)).status,
    ).toBe(404);
    expect((await stranger.client.post(`/v1/safety/guardians/${teen.id}/accept`)).status).toBe(404);
    expect((await guardian.client.post(`/v1/safety/guardians/${teen.id}/accept`)).status).toBe(200);
    const s = await guardian.client.get(`/v1/safety/guardian/minors/${teen.id}/summary`);
    expect(s.status).toBe(200);
    expect(s.body.settings).toMatchObject({
      whoCanMessage: 'friends',
      discoverable: false,
      sensitiveContent: 'hide',
      privateAccount: true,
    });
    expect(s.body.notIncluded).toEqual(expect.arrayContaining(['messages']));
    expect(JSON.stringify(s.body)).not.toContain('secret teen chat');
    expect(
      (await stranger.client.get(`/v1/safety/guardian/minors/${teen.id}/summary`)).status,
    ).toBe(404);
    const links = await guardian.client.get('/v1/safety/guardians');
    expect(links.body.asGuardian[0]).toMatchObject({ status: 'active', minor: { id: teen.id } });
    expect((await teen.client.get('/v1/safety/guardians')).body.asMinor[0].guardian.id).toBe(
      guardian.id,
    );
    // a guardian cannot read the teen's conversation through the messaging API
    expect((await guardian.client.get(`/v1/conversations/${conv}`)).status).toBe(404);
    // either side can end the link
    expect((await teen.client.del(`/v1/safety/guardians/${guardian.id}`)).status).toBe(204);
    expect(
      (await guardian.client.get(`/v1/safety/guardian/minors/${teen.id}/summary`)).status,
    ).toBe(404);
    expect((await teen.client.del(`/v1/safety/guardians/${guardian.id}`)).status).toBe(404);
  });

  it('limits a teen to three guardians and only the invited adult can accept', async () => {
    const teen = await teenUser();
    const gs = [await signup(t), await signup(t), await signup(t), await signup(t)];
    for (const g of gs.slice(0, 3))
      expect(
        (await teen.client.post('/v1/safety/guardians', { guardianUsername: g.username })).status,
      ).toBe(201);
    expect(
      (await teen.client.post('/v1/safety/guardians', { guardianUsername: gs[3]!.username }))
        .status,
    ).toBe(422);
    expect((await gs[3]!.client.post(`/v1/safety/guardians/${teen.id}/accept`)).status).toBe(404);
  });
});

describe('enforcement expiry', () => {
  it('reinstates accounts once a time-limited suspension ends and leaves manually suspended accounts alone', async () => {
    const mod = await staff('moderator');
    const victim = await signup(t);
    const manual = await signup(t);
    await sql(`UPDATE users SET status = 'suspended' WHERE id = $1`, [manual.id]);
    const p = await post(victim);
    await report(await signup(t), 'post', p, 'hate');
    await decide(mod, (await caseFor(p)).id, 'suspend_user', { durationDays: 1 });
    await expireEnforcements(t.ctx);
    expect((await sql('SELECT status FROM users WHERE id = $1', [victim.id])).rows[0].status).toBe(
      'suspended',
    ); // not over yet
    await sql(
      `UPDATE enforcements SET ends_at = now() - interval '1 second' WHERE user_id = $1 AND kind = 'suspension'`,
      [victim.id],
    );
    await expireEnforcements(t.ctx);
    expect((await sql('SELECT status FROM users WHERE id = $1', [victim.id])).rows[0].status).toBe(
      'active',
    );
    expect((await sql('SELECT status FROM users WHERE id = $1', [manual.id])).rows[0].status).toBe(
      'suspended',
    );
    expect(
      (
        await sql(
          `SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'account_reinstated'`,
          [victim.id],
        )
      ).rowCount,
    ).toBe(1);
    expect(getDeletionHooks().length).toBeGreaterThan(0);
  });
});

describe('follow velocity', () => {
  it('opens a spam review case for a brand-new account that mass-follows, and leaves normal following alone', async () => {
    const follower = await signup(t);
    const normal = await signup(t);
    const target = await signup(t);
    const other = await signup(t);
    // 85 follows in the last hour, created in bulk (users only need the columns without defaults).
    await sql(
      `WITH made AS (INSERT INTO users (email, birth_date, age_band) SELECT 'bulk' || g || '-' || $1 || '@example.test', DATE '1990-01-01', 'adult' FROM generate_series(1, 85) g RETURNING id)
       INSERT INTO follows (follower_id, followee_id) SELECT $2::uuid, id FROM made`,
      [uniq('b'), follower.id],
    );
    expect((await follower.client.put(`/v1/users/${target.username}/follow`)).status).toBeLessThan(
      300,
    );
    expect((await normal.client.put(`/v1/users/${target.username}/follow`)).status).toBeLessThan(
      300,
    );
    expect((await normal.client.put(`/v1/users/${other.username}/follow`)).status).toBeLessThan(
      300,
    );
    await new Promise((r) => setTimeout(r, 200)); // the signal is recorded after the response
    const cases = (
      await sql(
        `SELECT * FROM moderation_cases WHERE subject_user_id = $1 AND 'spam' = ANY(categories)`,
        [follower.id],
      )
    ).rows;
    expect(cases).toHaveLength(1);
    expect(cases[0].signals.spam.reasons).toContain('follow_velocity');
    expect(cases[0]).toMatchObject({ source: 'automated', target_type: 'user' });
    expect(
      (await sql(`SELECT 1 FROM moderation_cases WHERE subject_user_id = $1`, [normal.id]))
        .rowCount,
    ).toBe(0);
    // Following still works: the signal opens a review, it never blocks the person.
    expect(
      (
        await sql('SELECT 1 FROM follows WHERE follower_id = $1 AND followee_id = $2', [
          follower.id,
          target.id,
        ])
      ).rowCount,
    ).toBe(1);
  });
});

describe('impersonation screening', () => {
  it('opens one review case for a lookalike of a staff account, never for the staff account itself or unrelated names', async () => {
    const real = await signup(t, { username: `acmecoffee${uniq('').slice(0, 4)}` });
    await makeStaff(t, real, 'moderator');
    const fake = await signup(t, { username: real.username.replace('acmecoffee', 'acme_c0ffee') });
    const unrelated = await signup(t, { username: uniq('sunny') });

    const a = await screenProfileIdentity(t.ctx, fake.id);
    expect(a.risk).toBe('high');
    expect(a.caseId).toBeTruthy();
    const c = (await sql('SELECT * FROM moderation_cases WHERE id = $1', [a.caseId])).rows[0];
    expect(c).toMatchObject({
      target_type: 'user',
      subject_user_id: fake.id,
      source: 'automated',
      state: 'review',
    });
    expect(c.categories).toContain('impersonation');
    // Idempotent while the case is open.
    expect((await screenProfileIdentity(t.ctx, fake.id)).caseId).toBe(a.caseId);
    expect(
      (
        await sql(
          `SELECT count(*)::int AS n FROM moderation_cases WHERE target_id = $1 AND 'impersonation' = ANY(categories)`,
          [fake.id],
        )
      ).rows[0].n,
    ).toBe(1);
    // The protected account is not flagged against itself, and unrelated names are ignored.
    expect((await screenProfileIdentity(t.ctx, real.id)).caseId).toBeNull();
    expect((await screenProfileIdentity(t.ctx, unrelated.id)).risk).toBe('none');
    // It only opens a review: the lookalike is neither renamed nor suspended.
    expect((await sql('SELECT status FROM users WHERE id = $1', [fake.id])).rows[0].status).toBe(
      'active',
    );
  });
});
