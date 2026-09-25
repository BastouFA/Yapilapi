import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlatformRole } from '@yapilapi/shared';
import {
  Client,
  createTestApp,
  enableMfa,
  makeStaff,
  signup,
  uniq,
  type TestApp,
  type TestUser,
} from './helpers.js';
import {
  PERMISSIONS,
  PERMISSION_MATRIX,
  maskEmail,
  outranks,
  roleHas,
  rolesWith,
} from '../src/modules/admin/index.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

const sql = <R extends Record<string, any> = any>(text: string, params: unknown[] = []) =>
  t.ctx.db.query<R>(text, params);
type Staff = 'support' | 'moderator' | 'admin' | 'superadmin';
const staff = async (role: Staff) => {
  const u = await signup(t);
  await makeStaff(t, u, role);
  return u;
};
const login = (u: TestUser) =>
  new Client(t, 'bearer').request('POST', '/v1/auth/login', {
    body: { email: u.email, password: u.password, deliver: 'token' },
  });
const auditActions = async (actor: string) =>
  (
    await sql(
      'SELECT action, target_id, metadata FROM audit_logs WHERE actor_id = $1 ORDER BY id',
      [actor],
    )
  ).rows;

describe('permission matrix (pure)', () => {
  it('roles inherit from the role below and never gain permissions by going down', () => {
    const order: PlatformRole[] = ['user', 'support', 'moderator', 'admin', 'superadmin'];
    for (let i = 1; i < order.length; i++)
      for (const p of PERMISSION_MATRIX[order[i - 1]!])
        expect(roleHas(order[i]!, p), `${order[i]} lacks ${p}`).toBe(true);
    expect(PERMISSION_MATRIX.user.size).toBe(0);
    expect(rolesWith('users.role_change')).toEqual(['superadmin']);
    expect(rolesWith('flags.write')).toEqual(['admin', 'superadmin']);
    expect(rolesWith('cases.decide')).toEqual(['moderator', 'admin', 'superadmin']);
    expect(rolesWith('users.read')).toEqual(['support', 'moderator', 'admin', 'superadmin']);
    for (const p of PERMISSIONS) expect(rolesWith(p).length, p).toBeGreaterThan(0);
  });
  it('outranks is strict and masks emails sensibly', () => {
    expect(outranks('admin', 'moderator')).toBe(true);
    expect(outranks('admin', 'admin')).toBe(false);
    expect(outranks('support', 'user')).toBe(true);
    expect(maskEmail('alice@example.com')).not.toContain('alice');
    expect(maskEmail('alice@example.com')).toContain('@');
  });
});

describe('authorization matrix over the HTTP API', () => {
  const uid = '00000000-0000-4000-8000-000000000001';
  // [method, url, body, minimum role]
  const routes: Array<['get' | 'post' | 'put' | 'del', string, unknown, Staff]> = [
    ['get', '/v1/admin/me', undefined, 'support'],
    ['get', '/v1/admin/users?q=someone', undefined, 'support'],
    ['get', `/v1/admin/users/${uid}`, undefined, 'support'],
    ['get', `/v1/admin/users/${uid}/notes`, undefined, 'support'],
    ['post', `/v1/admin/users/${uid}/notes`, { body: 'x' }, 'support'],
    ['get', `/v1/admin/content/post/${uid}`, undefined, 'support'],
    ['get', '/v1/admin/communities', undefined, 'support'],
    ['get', '/v1/admin/businesses', undefined, 'support'],
    ['get', '/v1/admin/creators', undefined, 'support'],
    ['get', '/v1/admin/payments/summary', undefined, 'support'],
    [
      'post',
      `/v1/admin/users/${uid}/suspend`,
      { reason: 'Because of abuse', days: 3 },
      'moderator',
    ],
    ['post', `/v1/admin/communities/${uid}/suspend`, { reason: 'Because of abuse' }, 'moderator'],
    ['post', `/v1/admin/communities/${uid}/restore`, { reason: 'Mistake made' }, 'moderator'],
    ['post', `/v1/admin/users/${uid}/reactivate`, { reason: 'Mistake made' }, 'admin'],
    ['post', `/v1/admin/creators/${uid}/suspend`, { reason: 'Because of abuse' }, 'admin'],
    ['post', `/v1/admin/creators/${uid}/reinstate`, { reason: 'Mistake made' }, 'admin'],
    ['get', '/v1/admin/fraud/summary', undefined, 'admin'],
    ['get', '/v1/admin/ai/usage', undefined, 'admin'],
    ['get', '/v1/admin/audit', undefined, 'admin'],
    ['get', '/v1/admin/system/health', undefined, 'admin'],
    ['get', '/v1/admin/flags', undefined, 'admin'],
    ['put', '/v1/admin/flags/MINI_APPS', { enabled: false, reason: 'testing' }, 'admin'],
    ['get', '/v1/admin/analytics/msa', undefined, 'admin'],
    [
      'put',
      `/v1/admin/users/${uid}/role`,
      { role: 'support', reason: 'Trusted colleague' },
      'superadmin',
    ],
  ];

  it('anonymous callers get 401, ordinary users get 403, staff without MFA get 403, on every admin route', async () => {
    const user = await signup(t);
    const noMfa = await signup(t);
    await sql(`UPDATE users SET platform_role = 'superadmin' WHERE id = $1`, [noMfa.id]);
    for (const [m, url, body] of routes) {
      const call = (c: Client) => (c as any)[m](url, body);
      expect((await call(new Client(t))).status, `anon ${m} ${url}`).toBe(401);
      expect((await call(user.client)).status, `user ${m} ${url}`).toBe(403);
      expect((await call(noMfa.client)).status, `superadmin-without-mfa ${m} ${url}`).toBe(403);
    }
  });

  it('each role passes exactly the routes its permissions allow (403 below, never 403 at or above the minimum)', async () => {
    const order: Staff[] = ['support', 'moderator', 'admin', 'superadmin'];
    for (const role of order) {
      const s = await staff(role);
      for (const [m, url, body, min] of routes) {
        const status = (await (s.client as any)[m](url, body)).status;
        const allowed = order.indexOf(role) >= order.indexOf(min);
        if (allowed) expect(status, `${role} ${m} ${url}`).not.toBe(403);
        else expect(status, `${role} ${m} ${url}`).toBe(403);
        expect(status, `${role} ${m} ${url}`).not.toBe(401);
      }
    }
  });

  it("/v1/admin/me reports the caller's role and permissions", async () => {
    const mod = await staff('moderator');
    const r = await mod.client.get('/v1/admin/me');
    expect(r.body.role).toBe('moderator');
    expect(r.body.permissions).toContain('cases.decide');
    expect(r.body.permissions).not.toContain('flags.write');
  });
});

describe('user lookup and privacy of staff views', () => {
  it('masks email below admin, unmasks for admin, and audits both', async () => {
    const victim = await signup(t);
    const support = await staff('support');
    const admin = await staff('admin');
    const s = await support.client.get(`/v1/admin/users/${victim.id}`);
    expect(s.status).toBe(200);
    expect(s.body.email).not.toBe(victim.email);
    expect(JSON.stringify(s.body)).not.toContain(victim.email);
    expect(s.body.countryCode).toBeNull();
    const a = await admin.client.get(`/v1/admin/users/${victim.id}`);
    expect(a.body.email).toBe(victim.email);
    expect((await auditActions(support.id)).map((x) => x.action)).toContain('admin.user_viewed');
    expect((await auditActions(admin.id)).map((x) => x.action)).toContain('admin.user_viewed_pii');
    expect(JSON.stringify(a.body)).not.toMatch(/password|token_hash|mfa_secret/i);
  });

  it('searches by username prefix, exact email and id, masks emails in results, and paginates without repeats', async () => {
    const support = await staff('support');
    const prefix = uniq('srch');
    const users: TestUser[] = [];
    for (let i = 0; i < 5; i++) users.push(await signup(t, { username: `${prefix}${i}` }));
    const byPrefix = await support.client.get('/v1/admin/users', { q: prefix });
    expect(byPrefix.body.items).toHaveLength(5);
    for (const u of users) expect(JSON.stringify(byPrefix.body)).not.toContain(u.email); // domain may remain, the mailbox may not
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 6; i++) {
      const p = await support.client.get('/v1/admin/users', {
        q: prefix,
        limit: '2',
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...p.body.items.map((x: any) => x.id));
      cursor = p.body.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(seen.sort()).toEqual(users.map((u) => u.id).sort());
    expect(
      (await support.client.get('/v1/admin/users', { q: users[0]!.email })).body.items.map(
        (x: any) => x.id,
      ),
    ).toEqual([users[0]!.id]);
    expect(
      (await support.client.get('/v1/admin/users', { q: users[1]!.id })).body.items.map(
        (x: any) => x.id,
      ),
    ).toEqual([users[1]!.id]);
    expect((await support.client.get('/v1/admin/users', { q: '%' })).status).toBe(400); // too short
    expect((await support.client.get('/v1/admin/users', { q: '%%' })).body.items).toHaveLength(0); // wildcard is escaped
    expect(
      (await auditActions(support.id)).filter((x) => x.action === 'admin.user_search').length,
    ).toBeGreaterThanOrEqual(4);
  });

  it('unknown ids are 404 and staff notes are internal, attributed and audited', async () => {
    const support = await staff('support');
    const victim = await signup(t);
    expect((await support.client.get(`/v1/admin/users/${crypto.randomUUID()}`)).status).toBe(404);
    expect(
      (await support.client.post(`/v1/admin/users/${crypto.randomUUID()}/notes`, { body: 'x' }))
        .status,
    ).toBe(404);
    expect(
      (await support.client.post(`/v1/admin/users/${victim.id}/notes`, { body: '   ' })).status,
    ).toBe(400);
    const n = await support.client.post(`/v1/admin/users/${victim.id}/notes`, {
      body: 'Contacted about a billing question',
    });
    expect(n.status).toBe(201);
    const list = await support.client.get(`/v1/admin/users/${victim.id}/notes`);
    expect(list.body.items[0]).toMatchObject({
      body: 'Contacted about a billing question',
      authorId: support.id,
    });
    // The account holder never sees it: no user-facing route exposes notes, and their own export must not contain it.
    expect((await victim.client.get(`/v1/admin/users/${victim.id}/notes`)).status).toBe(403);
    expect((await auditActions(support.id)).map((x) => x.action)).toContain(
      'admin.user_note_added',
    );
  });
});

describe('suspension and reactivation', () => {
  it('a moderator suspends: sessions end, login is refused, status changes, audit is written; an admin reactivates', async () => {
    const mod = await staff('moderator');
    const admin = await staff('admin');
    const victim = await signup(t);
    const before = await victim.client.get('/v1/notifications/unread-count');
    expect(before.status).toBe(200);
    expect(
      (await mod.client.post(`/v1/admin/users/${victim.id}/suspend`, { reason: 'x', days: 3 }))
        .status,
    ).toBe(400); // reason too short
    expect(
      (
        await mod.client.post(`/v1/admin/users/${victim.id}/suspend`, {
          reason: 'Repeated harassment',
          days: 0,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await mod.client.post(`/v1/admin/users/${victim.id}/suspend`, {
          reason: 'Repeated harassment',
          days: 91,
        })
      ).status,
    ).toBe(400);
    const r = await mod.client.post(`/v1/admin/users/${victim.id}/suspend`, {
      reason: 'Repeated harassment',
      days: 7,
    });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('suspended');
    expect((await victim.client.get('/v1/notifications/unread-count')).status).toBe(401);
    expect((await login(victim)).status).toBe(403);
    expect((await sql('SELECT status FROM users WHERE id = $1', [victim.id])).rows[0].status).toBe(
      'suspended',
    );
    expect(
      (
        await mod.client.post(`/v1/admin/users/${victim.id}/suspend`, {
          reason: 'Repeated harassment',
          days: 7,
        })
      ).status,
    ).toBe(409);
    const a = (await auditActions(mod.id)).find((x) => x.action === 'admin.user_suspended');
    expect(a).toMatchObject({ target_id: victim.id });
    expect(a!.metadata).toMatchObject({ days: 7, reason: 'Repeated harassment' });
    // The user is told how to appeal.
    expect(
      (
        await sql(`SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'account_suspended'`, [
          victim.id,
        ])
      ).rowCount,
    ).toBe(1);

    expect(
      (
        await mod.client.post(`/v1/admin/users/${victim.id}/reactivate`, {
          reason: 'Appeal upheld',
        })
      ).status,
    ).toBe(403); // moderators cannot lift
    expect(
      (
        await admin.client.post(`/v1/admin/users/${victim.id}/reactivate`, {
          reason: 'Appeal upheld',
        })
      ).status,
    ).toBe(200);
    expect((await login(victim)).status).toBe(200);
    expect(
      (
        await admin.client.post(`/v1/admin/users/${victim.id}/reactivate`, {
          reason: 'Appeal upheld',
        })
      ).status,
    ).toBe(409);
    expect((await auditActions(admin.id)).map((x) => x.action)).toContain('admin.user_reactivated');
  });

  it('enforces rank: nobody acts on themselves, peers or superiors, and lower staff cannot learn the hierarchy (404)', async () => {
    const mod = await staff('moderator');
    const mod2 = await staff('moderator');
    const admin = await staff('admin');
    const admin2 = await staff('admin');
    const body = { reason: 'Policy violation', days: 3 };
    expect((await mod.client.post(`/v1/admin/users/${mod.id}/suspend`, body)).status).toBe(403);
    expect((await mod.client.post(`/v1/admin/users/${mod2.id}/suspend`, body)).status).toBe(404);
    expect((await mod.client.post(`/v1/admin/users/${admin.id}/suspend`, body)).status).toBe(404);
    expect((await admin.client.post(`/v1/admin/users/${admin2.id}/suspend`, body)).status).toBe(
      404,
    );
    expect((await admin.client.post(`/v1/admin/users/${mod.id}/suspend`, body)).status).toBe(200); // admin outranks moderator
    expect(
      (await admin2.client.post(`/v1/admin/users/${mod.id}/reactivate`, { reason: 'Mistake made' }))
        .status,
    ).toBe(200);
    for (const s of [mod, mod2, admin, admin2])
      expect((await sql('SELECT status FROM users WHERE id = $1', [s.id])).rows[0].status).toBe(
        'active',
      );
  });

  it('refuses to suspend deleted or pending-deletion accounts', async () => {
    const mod = await staff('moderator');
    const gone = await signup(t);
    await sql(`UPDATE users SET status = 'pending_deletion' WHERE id = $1`, [gone.id]);
    expect(
      (
        await mod.client.post(`/v1/admin/users/${gone.id}/suspend`, {
          reason: 'Policy violation',
          days: 3,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await mod.client.post(`/v1/admin/users/${crypto.randomUUID()}/suspend`, {
          reason: 'Policy violation',
          days: 3,
        })
      ).status,
    ).toBe(404);
  });
});

describe('role changes', () => {
  it('only a superadmin can change roles; the target needs MFA and must be an adult; sessions are revoked; it is audited', async () => {
    const sa = await staff('superadmin');
    const admin = await staff('admin');
    const target = await signup(t);
    const body = { role: 'support', reason: 'Joining the support team' };
    expect((await admin.client.put(`/v1/admin/users/${target.id}/role`, body)).status).toBe(403);
    expect(
      (
        await sa.client.put(`/v1/admin/users/${sa.id}/role`, {
          role: 'user',
          reason: 'Stepping down',
        })
      ).status,
    ).toBe(403); // not yourself
    expect((await sa.client.put(`/v1/admin/users/${target.id}/role`, body)).status).toBe(409); // no MFA yet
    await enableMfa(target);
    const teen = await signup(t, { birthDate: `${new Date().getUTCFullYear() - 15}-02-02` });
    expect(
      (await sa.client.put(`/v1/admin/users/${teen.id}/role`, body)).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (
        await sa.client.put(`/v1/admin/users/${target.id}/role`, {
          role: 'emperor',
          reason: 'nonsense here',
        })
      ).status,
    ).toBe(400);
    expect((await sa.client.put(`/v1/admin/users/${target.id}/role`, body)).status).toBe(200);
    expect(
      (await sql('SELECT platform_role FROM users WHERE id = $1', [target.id])).rows[0]
        .platform_role,
    ).toBe('support');
    expect((await target.client.get('/v1/notifications/unread-count')).status).toBe(401); // old session ended
    expect((await sa.client.put(`/v1/admin/users/${target.id}/role`, body)).status).toBe(409); // no-op
    const a = (await auditActions(sa.id)).find((x) => x.action === 'admin.role_changed');
    expect(a!.metadata).toMatchObject({ from: 'user', to: 'support', direction: 'promotion' });
    expect(
      (
        await sa.client.put(`/v1/admin/users/${target.id}/role`, {
          role: 'user',
          reason: 'Left the team',
        })
      ).status,
    ).toBe(200);
    expect((await auditActions(sa.id)).some((x) => x.metadata?.direction === 'demotion')).toBe(
      true,
    );
  });
});

describe('content, communities, creators', () => {
  it('looks up content without ever exposing private messages', async () => {
    const support = await staff('support');
    const author = await signup(t);
    const p = await author.client.post('/v1/posts', {
      body: `Looking at ${uniq('x')} content`,
      visibility: 'followers',
    });
    expect(p.status).toBe(201);
    const r = await support.client.get(`/v1/admin/content/post/${p.body.id}`);
    expect(r.status).toBe(200);
    expect(r.body.ownerId).toBe(author.id);
    expect(JSON.stringify(r.body)).toContain('content');
    expect(
      (await support.client.get(`/v1/admin/content/message/${crypto.randomUUID()}`)).status,
    ).toBe(400);
    expect((await support.client.get(`/v1/admin/content/user/${author.id}`)).status).toBe(400);
    expect((await support.client.get(`/v1/admin/content/post/${crypto.randomUUID()}`)).status).toBe(
      404,
    );
    expect((await auditActions(support.id)).map((x) => x.action)).toContain('admin.content_viewed');
  });

  it('suspends and restores a community (reversible, audited, owner notified)', async () => {
    const mod = await staff('moderator');
    const support = await staff('support');
    const owner = await signup(t);
    const c = await owner.client.post('/v1/communities', { name: `Suspend ${uniq('c')}` });
    expect(c.status).toBe(201);
    expect(
      (
        await support.client.post(`/v1/admin/communities/${c.body.id}/suspend`, {
          reason: 'Coordinated abuse',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await mod.client.post(`/v1/admin/communities/${c.body.id}/suspend`, {
          reason: 'Coordinated abuse',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await mod.client.post(`/v1/admin/communities/${c.body.id}/suspend`, {
          reason: 'Coordinated abuse',
        })
      ).status,
    ).toBe(409);
    expect((await owner.client.get(`/v1/communities/${c.body.slug}`)).status).toBe(404); // gone for everyone
    const listed = await support.client.get('/v1/admin/communities', { suspended: 'true' });
    expect(listed.body.items.map((x: any) => x.id)).toContain(c.body.id);
    expect(
      (
        await sql(
          `SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'community_suspended'`,
          [owner.id],
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await mod.client.post(`/v1/admin/communities/${c.body.id}/restore`, {
          reason: 'Reviewed and cleared',
        })
      ).status,
    ).toBe(200);
    expect((await owner.client.get(`/v1/communities/${c.body.slug}`)).status).toBe(200);
    expect(
      (
        await mod.client.post(`/v1/admin/communities/${crypto.randomUUID()}/suspend`, {
          reason: 'Coordinated abuse',
        })
      ).status,
    ).toBe(404);
    expect((await auditActions(mod.id)).map((x) => x.action)).toEqual(
      expect.arrayContaining(['admin.community_suspended', 'admin.community_restored']),
    );
  });

  it('suspends and reinstates creator monetisation without touching the account', async () => {
    const admin = await staff('admin');
    const cr = await signup(t);
    await sql(`INSERT INTO creators (user_id) VALUES ($1)`, [cr.id]);
    expect(
      (await admin.client.post(`/v1/admin/creators/${cr.id}/reinstate`, { reason: 'Mistake made' }))
        .status,
    ).toBe(409); // already active
    expect(
      (
        await admin.client.post(`/v1/admin/creators/${cr.id}/suspend`, {
          reason: 'Payout fraud suspected',
        })
      ).status,
    ).toBe(200);
    expect(
      (await sql('SELECT status FROM creators WHERE user_id = $1', [cr.id])).rows[0].status,
    ).toBe('suspended');
    expect((await sql('SELECT status FROM users WHERE id = $1', [cr.id])).rows[0].status).toBe(
      'active',
    );
    expect((await cr.client.get('/v1/notifications/unread-count')).status).toBe(200);
    expect(
      (await admin.client.get('/v1/admin/creators', { status: 'suspended' })).body.items.map(
        (x: any) => x.userId,
      ),
    ).toContain(cr.id);
    expect(
      (
        await admin.client.post(`/v1/admin/creators/${cr.id}/reinstate`, {
          reason: 'Cleared after review',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await admin.client.post(`/v1/admin/creators/${crypto.randomUUID()}/suspend`, {
          reason: 'Payout fraud suspected',
        })
      ).status,
    ).toBe(404);
  });

  it('lists businesses with pagination limits enforced', async () => {
    const support = await staff('support');
    expect((await support.client.get('/v1/admin/businesses')).status).toBe(200);
    expect((await support.client.get('/v1/admin/businesses', { limit: '500' })).status).toBe(400);
    expect((await support.client.get('/v1/admin/businesses', { cursor: '!!!' })).status).toBe(400);
  });
});

describe('operational overviews', () => {
  it('serves payment, fraud, AI and health overviews as aggregates', async () => {
    const admin = await staff('admin');
    for (const path of [
      '/v1/admin/payments/summary',
      '/v1/admin/fraud/summary',
      '/v1/admin/ai/usage',
    ]) {
      const r = await admin.client.get(path, { days: '7' });
      expect(r.status, path).toBe(200);
      expect(r.body.periodDays, path).toBe(7);
    }
    expect((await admin.client.get('/v1/admin/payments/summary', { days: '0' })).status).toBe(400);
    const h = await admin.client.get('/v1/admin/system/health');
    expect(h.status).toBe(200);
    expect(h.body.database).toMatchObject({ ok: true });
    expect(h.body.database.migrations.applied).toBeGreaterThan(0);
    expect(h.body.backlogs).toHaveProperty('openModerationCases');
    expect(JSON.stringify(h.body)).not.toMatch(/postgres:\/\/|password|secret/i);
  });

  it('exposes the audit log newest-first with filters and keyset pagination', async () => {
    const admin = await staff('admin');
    const mod = await staff('moderator');
    const victims: TestUser[] = [];
    for (let i = 0; i < 4; i++) {
      const v = await signup(t);
      victims.push(v);
      await mod.client.post(`/v1/admin/users/${v.id}/notes`, { body: `note ${i}` });
    }
    const all = await admin.client.get('/v1/admin/audit', {
      actorId: mod.id,
      action: 'admin.user_note_added',
    });
    expect(all.body.items).toHaveLength(4);
    const ids = all.body.items.map((x: any) => Number(x.id));
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    const seen: number[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const p = await admin.client.get('/v1/admin/audit', {
        actorId: mod.id,
        action: 'admin.user_note_added',
        limit: '3',
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...p.body.items.map((x: any) => Number(x.id)));
      cursor = p.body.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(seen).toEqual(ids);
    expect(
      (await admin.client.get('/v1/admin/audit', { targetType: 'user', targetId: victims[0]!.id }))
        .body.items.length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      (await admin.client.get('/v1/admin/audit', { actionPrefix: 'admin.user_' })).body.items.every(
        (x: any) => x.action.startsWith('admin.user_'),
      ),
    ).toBe(true);
    expect((await admin.client.get('/v1/admin/audit', { limit: '1000' })).status).toBe(400);
    expect((await admin.client.get('/v1/admin/audit', { actorId: 'nope' })).status).toBe(400);
    // The log is append-only at the database level.
    await expect(
      sql('UPDATE audit_logs SET action = $1 WHERE actor_id = $2', ['tampered', mod.id]),
    ).rejects.toThrow();
    await expect(sql('DELETE FROM audit_logs WHERE actor_id = $1', [mod.id])).rejects.toThrow();
  });
});

describe('feature flag administration', () => {
  it('reads, changes, audits and overrides flags; changes take effect immediately in this process', async () => {
    const admin = await staff('admin');
    const tester = await signup(t);
    const list = await admin.client.get('/v1/admin/flags');
    expect(list.status).toBe(200);
    const flag = list.body.items.find((f: any) => f.key === 'MINI_APPS');
    expect(flag).toBeTruthy();

    expect((await admin.client.put('/v1/admin/flags/MINI_APPS', { enabled: true })).status).toBe(
      400,
    ); // a reason is required
    expect(
      (await admin.client.put('/v1/admin/flags/MINI_APPS', { reason: 'no change given' })).status,
    ).toBe(400);
    expect(
      (await admin.client.put('/v1/admin/flags/MINI_APPS', { rolloutPct: 101, reason: 'too high' }))
        .status,
    ).toBe(400);
    expect(
      (
        await admin.client.put('/v1/admin/flags/NOT_A_FLAG', {
          enabled: true,
          reason: 'unknown flag',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await admin.client.put('/v1/admin/flags/lowercase', {
          enabled: true,
          reason: 'bad key format',
        })
      ).status,
    ).toBe(400);

    const on = await admin.client.put('/v1/admin/flags/MINI_APPS', {
      enabled: true,
      rolloutPct: 100,
      reason: 'Enabling for the test',
    });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ key: 'MINI_APPS', enabled: true, rolloutPct: 100 });
    expect(await t.ctx.flags.isEnabled('MINI_APPS', tester.id)).toBe(true);
    const off = await admin.client.put('/v1/admin/flags/MINI_APPS', {
      enabled: false,
      reason: 'Disabling for the test',
    });
    expect(off.body.enabled).toBe(false);
    expect(await t.ctx.flags.isEnabled('MINI_APPS', tester.id)).toBe(false);

    expect(
      (
        await admin.client.put(`/v1/admin/flags/MINI_APPS/overrides/${tester.id}`, {
          enabled: true,
          reason: 'Internal tester',
        })
      ).status,
    ).toBe(200);
    expect(await t.ctx.flags.isEnabled('MINI_APPS', tester.id)).toBe(true);
    expect(
      (await admin.client.get('/v1/admin/flags/MINI_APPS/overrides')).body.items.map(
        (x: any) => x.userId,
      ),
    ).toContain(tester.id);
    expect(
      (
        await admin.client.put(`/v1/admin/flags/MINI_APPS/overrides/${crypto.randomUUID()}`, {
          enabled: true,
          reason: 'Nobody home',
        })
      ).status,
    ).toBe(404);
    expect(
      (await admin.client.del(`/v1/admin/flags/MINI_APPS/overrides/${tester.id}`)).status,
    ).toBe(204);
    expect(await t.ctx.flags.isEnabled('MINI_APPS', tester.id)).toBe(false);
    expect(
      (await admin.client.del(`/v1/admin/flags/MINI_APPS/overrides/${tester.id}`)).status,
    ).toBe(404);

    const acts = await auditActions(admin.id);
    expect(acts.filter((a) => a.action === 'admin.flag_updated')).toHaveLength(2);
    const upd = acts.find((a) => a.action === 'admin.flag_updated')!;
    expect(upd.metadata).toMatchObject({
      from: { enabled: expect.any(Boolean) },
      to: { enabled: true, rolloutPct: 100 },
      reason: 'Enabling for the test',
    });
    expect(acts.map((a) => a.action)).toEqual(
      expect.arrayContaining(['admin.flag_override_set', 'admin.flag_override_removed']),
    );
  });
});
