import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';

/** The admin console: trends, health, one account in detail, the content browser, announcements, payments and the audit log. */
let t: BuiltApp;
let admin: TestUser;
let moderator: TestUser;
let person: TestUser;
beforeAll(async () => {
  t = await testApp();
  admin = await signUp(t.app);
  moderator = await signUp(t.app);
  person = await signUp(t.app);
  await t.ctx.db.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [admin.id]);
  await t.ctx.db.query(`UPDATE users SET role = 'moderator' WHERE id = $1`, [moderator.id]);
});
afterAll(async () => {
  await t.close();
});

const db = () => t.ctx.db;
const ZERO = '00000000-0000-4000-8000-000000000000';
const auditFor = async (action: string, entityId: string) =>
  (await db().query(`SELECT actor_id, metadata FROM audit_logs WHERE action = $1 AND entity_id = $2 ORDER BY id DESC`, [action, entityId])).rows;

describe('who can use the console', () => {
  const routes: [method: 'get' | 'post', url: string][] = [
    ['get', '/v1/admin/analytics/series?days=7'],
    ['get', '/v1/admin/system'],
    ['get', `/v1/admin/users/${ZERO}`],
    ['post', `/v1/admin/users/${ZERO}/sign-out-everywhere`],
    ['post', `/v1/admin/users/${ZERO}/confirm-email`],
    ['get', '/v1/admin/content?kind=post'],
    ['post', `/v1/admin/content/post/${ZERO}/remove`],
    ['post', `/v1/admin/content/post/${ZERO}/restore`],
    ['get', '/v1/admin/announcements'],
    ['post', '/v1/admin/announcements'],
    ['post', `/v1/admin/announcements/${ZERO}/end`],
    ['get', '/v1/admin/payments?days=30'],
    ['get', '/v1/admin/audit-logs?action=user.'],
  ];
  it('refuses everyone but admins, moderators included', async () => {
    for (const [method, url] of routes) {
      expect((await as(t.app, person)[method](url)).status, `${method} ${url}`).toBe(403);
      expect((await as(t.app, moderator)[method](url)).status, `${method} ${url} (moderator)`).toBe(403);
      expect((await as(t.app, null)[method](url)).status, `${method} ${url} (signed out)`).toBe(401);
    }
  });

  it('lets moderators read and close problem reports', async () => {
    const r = await as(t.app, person).post('/v1/me/problems', { body: 'The map does not load on my phone.', platform: 'web' });
    expect(r.status).toBe(201);
    expect((await as(t.app, person).get('/v1/admin/problems')).status).toBe(403);
    const list = await as(t.app, moderator).get('/v1/admin/problems');
    expect(list.body.items.some((p: any) => p.id === r.body.report.id)).toBe(true);
    expect((await as(t.app, person).post(`/v1/admin/problems/${r.body.report.id}/close`)).status).toBe(403);
    expect((await as(t.app, moderator).post(`/v1/admin/problems/${r.body.report.id}/close`)).status).toBe(200);
    expect((await as(t.app, moderator).get('/v1/admin/problems')).body.items.some((p: any) => p.id === r.body.report.id)).toBe(false);
    expect(await auditFor('problem_report.close', r.body.report.id)).toHaveLength(1);
  });
});

describe('overview and system', () => {
  it('counts each day, with totals and the change from the period before', async () => {
    await as(t.app, person).post('/v1/posts', { body: 'A post for the trends', visibility: 'public' });
    const r = await as(t.app, admin).get('/v1/admin/analytics/series?days=7');
    expect(r.status).toBe(200);
    expect(r.body.days).toBe(7);
    expect(r.body.series).toHaveLength(7);
    const today = new Date().toISOString().slice(0, 10);
    expect(r.body.to).toBe(today);
    const last = r.body.series.at(-1);
    expect(last.day).toBe(today);
    for (const k of ['signups', 'active', 'posts', 'reels', 'comments', 'messages', 'reports', 'paidOrders']) {
      expect(typeof last[k]).toBe('number');
      expect(typeof r.body.totals[k]).toBe('number');
      expect(k in r.body.change).toBe(true);
    }
    expect(last.signups).toBeGreaterThanOrEqual(3);
    expect(last.posts).toBeGreaterThanOrEqual(1);
    expect(r.body.totals.active).toBeGreaterThanOrEqual(1);
    expect((await as(t.app, admin).get('/v1/admin/analytics/series?days=12')).status).toBe(400);
    expect((await as(t.app, admin).get('/v1/admin/analytics/series?days=90')).body.series).toHaveLength(90);
  });

  it('reports the database, Redis, the job queue and webhooks', async () => {
    await db().query(
      `INSERT INTO jobs (kind, payload, status, last_error, finished_at) VALUES ('test.admin_console', '{}', 'failed', 'It broke [Dev data]', now())`,
    );
    const r = await as(t.app, admin).get('/v1/admin/system');
    expect(r.status).toBe(200);
    expect(r.body.database.ok).toBe(true);
    expect(r.body.redis).toBe('not_configured');
    expect(r.body.jobs.failed).toBeGreaterThanOrEqual(1);
    expect(r.body.jobs.recentFailures.some((j: any) => j.kind === 'test.admin_console' && j.error === 'It broke [Dev data]')).toBe(true);
    expect(r.body.jobs.recentFailures.length).toBeLessThanOrEqual(20);
    expect(typeof r.body.webhooks.failed).toBe('number');
    expect(typeof r.body.serverTime).toBe('string');
    expect(r.body.app.environment).toBe('test');
  });
});

describe('one account', () => {
  it('shows the profile, counts, posts, sessions and devices, never tokens', async () => {
    const u = await signUp(t.app);
    await as(t.app, u).post('/v1/posts', { body: 'Hello from the detail page', visibility: 'public' });
    await as(t.app, person).post(`/v1/users/${u.id}/follow`);
    const r = await as(t.app, admin).get(`/v1/admin/users/${u.id}`);
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ id: u.id, username: u.username, email: u.email, emailConfirmed: false, role: 'user', status: 'active' });
    expect(r.body.self).toBe(false);
    expect(r.body.counts).toMatchObject({ posts: 1, followers: 1, following: 0, reportsMade: 0, reportsAgainst: 0 });
    expect(r.body.posts[0]).toMatchObject({ body: 'Hello from the detail page', moderationStatus: 'normal' });
    expect(r.body.sessions.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(r.body)).not.toContain(u.token);
    expect(JSON.stringify(r.body)).not.toMatch(/token_hash|tokenHash|password/);
    expect(r.body.risk).toMatchObject({ score: 0, openSignals: 0 });
    expect((await as(t.app, admin).get(`/v1/admin/users/${ZERO}`)).status).toBe(404);
    expect((await as(t.app, admin).get(`/v1/admin/users/${admin.id}`)).body.self).toBe(true);
  });

  it('signs an account out everywhere', async () => {
    const u = await signUp(t.app);
    const again = await as(t.app, null).post('/v1/auth/login', { email: u.email, password: u.password });
    expect(again.status).toBe(200);
    const r = await as(t.app, admin).post(`/v1/admin/users/${u.id}/sign-out-everywhere`);
    expect(r.status).toBe(200);
    expect(r.body.revoked).toBe(2);
    expect((await as(t.app, u).get('/v1/auth/me')).status).toBe(401);
    expect((await as(t.app, { ...u, token: again.body.token }).get('/v1/auth/me')).status).toBe(401);
    expect(await auditFor('user.sign_out_everywhere', u.id)).toEqual([expect.objectContaining({ actor_id: admin.id, metadata: { sessions: 2 } })]);
    // Not on yourself: Settings does that.
    expect((await as(t.app, admin).post(`/v1/admin/users/${admin.id}/sign-out-everywhere`)).status).toBe(400);
    expect((await as(t.app, admin).get('/v1/auth/me')).status).toBe(200);
  });

  it('marks an email address confirmed, once', async () => {
    const u = await signUp(t.app);
    expect((await as(t.app, u).get('/v1/me/account')).body.account.emailVerified).toBe(false);
    expect((await as(t.app, admin).post(`/v1/admin/users/${u.id}/confirm-email`)).body.emailConfirmed).toBe(true);
    expect((await as(t.app, u).get('/v1/me/account')).body.account.emailVerified).toBe(true);
    await as(t.app, admin).post(`/v1/admin/users/${u.id}/confirm-email`);
    expect(await auditFor('user.confirm_email', u.id)).toHaveLength(1);
    expect((await as(t.app, admin).get(`/v1/admin/users/${u.id}`)).body.user.emailConfirmed).toBe(true);
    expect((await as(t.app, admin).post(`/v1/admin/users/${admin.id}/confirm-email`)).status).toBe(400);
  });
});

describe('content browser', () => {
  it('removes a post and restores it, the way a moderation decision does', async () => {
    const author = await signUp(t.app);
    const viewer = await signUp(t.app);
    const p = await as(t.app, author).post('/v1/posts', { body: 'Market day photos, come by the stall', visibility: 'public' });
    expect(p.status).toBe(201);
    const id = p.body.post.id;
    const publicPosts = async () => (await as(t.app, viewer).get(`/v1/users/${author.username}/posts`)).body.items.map((x: any) => x.id);
    expect(await publicPosts()).toContain(id);

    const found = await as(t.app, admin).get(`/v1/admin/content?kind=post&q=${encodeURIComponent('@' + author.username)}`);
    expect(found.body.items.map((x: any) => x.id)).toEqual([id]);
    expect(found.body.items[0]).toMatchObject({ kind: 'post', removed: false, href: `/p/${id}`, author: { username: author.username } });

    expect((await as(t.app, admin).post(`/v1/admin/content/post/${id}/remove`, {})).status).toBe(400);
    expect((await as(t.app, admin).post(`/v1/admin/content/reel/${id}/remove`, { reason: 'Spam links' })).status).toBe(404);
    const removed = await as(t.app, admin).post(`/v1/admin/content/post/${id}/remove`, { reason: 'Spam links' });
    expect(removed.status).toBe(200);
    expect(await publicPosts()).not.toContain(id);
    expect((await as(t.app, viewer).get(`/v1/posts/${id}`)).status).toBe(404);
    expect((await as(t.app, admin).post(`/v1/admin/content/post/${id}/remove`, { reason: 'Again' })).status).toBe(400);
    // Told the way a queue decision tells them, and it is a case they can appeal.
    const n = await db().query(`SELECT data FROM notifications WHERE user_id = $1 AND type = 'enforcement'`, [author.id]);
    expect(n.rows[0].data).toMatchObject({ decision: 'remove', canAppeal: true, targetType: 'post' });
    const mine = await as(t.app, author).get('/v1/me/moderation');
    expect(mine.body.items[0]).toMatchObject({ target_type: 'post', target_id: id, decision: 'remove' });
    const list = await as(t.app, admin).get(`/v1/admin/content?kind=post&status=removed&q=${encodeURIComponent(author.username)}`);
    expect(list.body.items.map((x: any) => x.id)).toEqual([id]);
    expect((await as(t.app, admin).get(`/v1/admin/content?kind=post&status=visible&q=${encodeURIComponent(author.username)}`)).body.items).toEqual([]);

    const restored = await as(t.app, admin).post(`/v1/admin/content/post/${id}/restore`);
    expect(restored.status).toBe(200);
    expect(await publicPosts()).toContain(id);
    expect((await as(t.app, viewer).get(`/v1/posts/${id}`)).status).toBe(200);
    expect((await as(t.app, admin).post(`/v1/admin/content/post/${id}/restore`)).status).toBe(400);
    // The removal no longer counts against them.
    expect(
      (await db().query(`SELECT count(*)::int AS n FROM enforcements WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > now())`, [author.id])).rows[0]
        .n,
    ).toBe(0);
    expect((await as(t.app, author).get('/v1/me/moderation')).body.items).toEqual([]);

    const removals = await auditFor('content.remove', id);
    expect(removals).toEqual([expect.objectContaining({ actor_id: admin.id, metadata: expect.objectContaining({ reason: 'Spam links', kind: 'post' }) })]);
    expect(await auditFor('content.restore', id)).toHaveLength(1);
  });

  it('keeps something its author deleted deleted', async () => {
    const author = await signUp(t.app);
    const p = await as(t.app, author).post('/v1/posts', { body: 'Soon gone', visibility: 'public' });
    const id = p.body.post.id;
    await as(t.app, admin).post(`/v1/admin/content/post/${id}/remove`, { reason: 'Rules' });
    await db().query(`UPDATE posts SET deleted_at = now() - interval '1 minute' WHERE id = $1`, [id]);
    expect((await as(t.app, admin).post(`/v1/admin/content/post/${id}/restore`)).status).toBe(400);
    expect((await db().query(`SELECT moderation_status FROM posts WHERE id = $1`, [id])).rows[0].moderation_status).toBe('removed');
  });

  it('removes a comment and keeps the post’s count right', async () => {
    const author = await signUp(t.app);
    const p = await as(t.app, author).post('/v1/posts', { body: 'Comments welcome', visibility: 'public' });
    const c = await as(t.app, person).post(`/v1/posts/${p.body.post.id}/comments`, { body: 'Nice one [Dev data]' });
    expect(c.status).toBe(201);
    const cid = c.body.comment.id;
    const count = async () => (await db().query(`SELECT comment_count FROM posts WHERE id = $1`, [p.body.post.id])).rows[0].comment_count;
    expect(await count()).toBe(1);
    expect((await as(t.app, admin).post(`/v1/admin/content/comment/${cid}/remove`, { reason: 'Harassment' })).status).toBe(200);
    expect(await count()).toBe(0);
    const listed = await as(t.app, admin).get(`/v1/admin/content?kind=comment&status=removed&q=${encodeURIComponent(person.username)}`);
    expect(listed.body.items[0]).toMatchObject({ id: cid, removed: true, href: `/p/${p.body.post.id}` });
    expect((await as(t.app, admin).post(`/v1/admin/content/comment/${cid}/restore`)).status).toBe(200);
    expect(await count()).toBe(1);
  });

  it('removes and restores a community', async () => {
    const owner = await signUp(t.app);
    const slug = `adm-${Date.now().toString(36)}`;
    const made = await as(t.app, owner).post('/v1/communities', { name: 'Admin console garden club', slug, visibility: 'public' });
    expect(made.status).toBe(201);
    const id = made.body.community.id;
    expect((await as(t.app, admin).post(`/v1/admin/content/community/${id}/remove`, { reason: 'Scam group' })).status).toBe(200);
    expect((await db().query(`SELECT deleted_at FROM communities WHERE id = $1`, [id])).rows[0].deleted_at).not.toBeNull();
    const listed = await as(t.app, admin).get(`/v1/admin/content?kind=community&status=removed&q=${encodeURIComponent(slug)}`);
    expect(listed.status).toBe(200);
    expect((await as(t.app, admin).post(`/v1/admin/content/community/${id}/restore`)).status).toBe(200);
    expect((await db().query(`SELECT deleted_at FROM communities WHERE id = $1`, [id])).rows[0].deleted_at).toBeNull();
  });

  it('pages newest first', async () => {
    const author = await signUp(t.app);
    for (let i = 0; i < 3; i++) await as(t.app, author).post('/v1/posts', { body: `Paged post ${i}`, visibility: 'public' });
    const all = await as(t.app, admin).get(`/v1/admin/content?kind=post&q=${encodeURIComponent(author.username)}`);
    expect(all.body.items.map((x: any) => x.text)).toEqual(['Paged post 2', 'Paged post 1', 'Paged post 0']);
    expect(all.body.nextCursor).toBeNull();
    expect((await as(t.app, admin).get('/v1/admin/content?kind=nope')).status).toBe(400);
  });
});

describe('announcements', () => {
  it('goes out to everyone signed in until they close it or it ends', async () => {
    const bad = await as(t.app, admin).post('/v1/admin/announcements', { title: 'Hi', body: 'There', linkUrl: 'http://example.com' });
    expect(bad.status).toBe(400);
    expect((await as(t.app, admin).post('/v1/admin/announcements', { title: 'Hi', body: 'There', linkUrl: '//evil.example' })).status).toBe(400);
    expect((await as(t.app, admin).post('/v1/admin/announcements', { title: 'Hi', body: 'There', linkUrl: 'javascript:alert(1)' })).status).toBe(400);
    const made = await as(t.app, admin).post('/v1/admin/announcements', {
      title: 'Scheduled maintenance [Dev data]',
      body: 'YAPILAPI will be slower for a few minutes tonight.',
      linkUrl: '/settings/privacy',
    });
    expect(made.status).toBe(201);
    const id = made.body.announcement.id;
    expect(made.body.announcement).toMatchObject({ title: 'Scheduled maintenance [Dev data]', linkUrl: '/settings/privacy', endsAt: null });

    const u = await signUp(t.app);
    expect((await as(t.app, null).get('/v1/announcements/current')).status).toBe(401);
    const current = await as(t.app, u).get('/v1/announcements/current');
    expect(current.body.announcement).toMatchObject({ id, body: 'YAPILAPI will be slower for a few minutes tonight.' });
    expect((await as(t.app, u).post(`/v1/announcements/${id}/dismiss`)).status).toBe(200);
    expect((await as(t.app, u).post(`/v1/announcements/${id}/dismiss`)).status).toBe(200);
    expect((await as(t.app, u).get('/v1/announcements/current')).body.announcement?.id).not.toBe(id);
    expect((await as(t.app, u).post(`/v1/announcements/${ZERO}/dismiss`)).status).toBe(404);

    // Someone else still sees it, until it ends.
    const other = await signUp(t.app);
    expect((await as(t.app, other).get('/v1/announcements/current')).body.announcement.id).toBe(id);
    const listed = await as(t.app, admin).get('/v1/admin/announcements');
    expect(listed.body.items.find((a: any) => a.id === id)).toMatchObject({ state: 'active', dismissals: 1, createdBy: admin.username });
    expect((await as(t.app, admin).post(`/v1/admin/announcements/${id}/end`)).status).toBe(200);
    expect((await as(t.app, other).get('/v1/announcements/current')).body.announcement?.id).not.toBe(id);
    expect((await as(t.app, admin).post(`/v1/admin/announcements/${id}/end`)).status).toBe(404);
    expect((await as(t.app, admin).get('/v1/admin/announcements')).body.items.find((a: any) => a.id === id).state).toBe('ended');

    expect(await auditFor('announcement.create', id)).toHaveLength(1);
    expect(await auditFor('announcement.end', id)).toHaveLength(1);
  });

  it('waits for a start in the future, and refuses an end before it', async () => {
    const later = new Date(Date.now() + 3600_000).toISOString();
    expect(
      (await as(t.app, admin).post('/v1/admin/announcements', { title: 'Later', body: 'Not yet', startsAt: later, endsAt: new Date().toISOString() })).status,
    ).toBe(400);
    const made = await as(t.app, admin).post('/v1/admin/announcements', {
      title: 'Later',
      body: 'Not yet',
      startsAt: later,
      linkUrl: 'https://example.com/notes',
    });
    expect(made.status).toBe(201);
    expect((await as(t.app, person).get('/v1/announcements/current')).body.announcement?.id).not.toBe(made.body.announcement.id);
    expect((await as(t.app, person).post(`/v1/announcements/${made.body.announcement.id}/dismiss`)).status).toBe(404);
    expect((await as(t.app, admin).get('/v1/admin/announcements')).body.items.find((a: any) => a.id === made.body.announcement.id).state).toBe('scheduled');
    await as(t.app, admin).post(`/v1/admin/announcements/${made.body.announcement.id}/end`);
  });
});

describe('payments and the audit log', () => {
  it('summarises orders by status and provider, with the newest orders', async () => {
    const buyer = await signUp(t.app);
    await db().query(
      `INSERT INTO orders (buyer_id, status, total_cents, platform_fee_cents, currency, idempotency_key, purpose, payee_id, paid_at)
       VALUES ($1, 'paid', 1500, 150, 'USD', $3, 'tip', $2, now())`,
      [buyer.id, person.id, `admin-console-${Date.now()}`],
    );
    const r = await as(t.app, admin).get('/v1/admin/payments?days=30');
    expect(r.status).toBe(200);
    expect(r.body.byStatus.find((s: any) => s.status === 'paid' && s.currency === 'USD').cents).toBeGreaterThanOrEqual(1500);
    expect(r.body.recent.find((o: any) => o.buyer?.id === buyer.id)).toMatchObject({
      amountCents: 1500,
      currency: 'USD',
      status: 'paid',
      seller: { id: person.id, username: person.username },
    });
    expect(Array.isArray(r.body.byProvider)).toBe(true);
    expect(Array.isArray(r.body.refunds)).toBe(true);
    expect((await as(t.app, admin).get('/v1/admin/payments?days=5')).status).toBe(400);
  });

  it('filters by action, actor, entity and date, a page at a time', async () => {
    const u = await signUp(t.app);
    await as(t.app, admin).put(`/v1/admin/users/${u.id}/role`, { role: 'moderator' });
    await as(t.app, admin).put(`/v1/admin/users/${u.id}/role`, { role: 'user' });
    const r = await as(t.app, admin).get(`/v1/admin/audit-logs?action=user.role&actor=${admin.username}&entityType=user&entityId=${u.id}`);
    expect(r.status).toBe(200);
    expect(r.body.items.map((l: any) => l.metadata.role)).toEqual(['user', 'moderator']);
    expect(r.body.items[0]).toMatchObject({ actor_username: admin.username, entity_type: 'user', entity_id: u.id });
    const today = new Date().toISOString().slice(0, 10);
    expect((await as(t.app, admin).get(`/v1/admin/audit-logs?entityId=${u.id}&from=${today}&to=${today}`)).body.items).toHaveLength(2);
    expect((await as(t.app, admin).get(`/v1/admin/audit-logs?entityId=${u.id}&to=2000-01-01`)).body.items).toHaveLength(0);
    expect((await as(t.app, admin).get(`/v1/admin/audit-logs?actor=${person.username}&entityId=${u.id}`)).body.items).toHaveLength(0);
    // "_" is a letter, not a wildcard.
    expect((await as(t.app, admin).get(`/v1/admin/audit-logs?action=user_role`)).body.items).toHaveLength(0);
    expect((await as(t.app, admin).get('/v1/admin/audit-logs?from=yesterday')).status).toBe(400);

    const first = await as(t.app, admin).get('/v1/admin/audit-logs');
    expect(first.body.items.length).toBeGreaterThan(0);
    if (first.body.nextCursor) {
      const next = await as(t.app, admin).get(`/v1/admin/audit-logs?cursor=${first.body.nextCursor}`);
      expect(Number(next.body.items[0].id)).toBeLessThan(Number(first.body.items.at(-1).id));
    }
  });
});
