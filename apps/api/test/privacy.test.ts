import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { Client, createTestApp, signup, uniq, type TestApp, type TestUser } from './helpers.js';
import {
  finalizeDueDeletions,
  hasConsent,
  setConsent,
  buildExport,
  purgeExpiredExports,
} from '../src/modules/privacy/index.js';
import { pkceChallengeFromVerifier } from '../src/modules/developer/oauth.js';

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
const post = async (u: TestUser, body: string, extra: Record<string, unknown> = {}) => {
  const r = await u.client.post('/v1/posts', { body, visibility: 'public', ...extra });
  if (r.status !== 201) throw new Error(`post failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id as string;
};
const dm = async (a: TestUser, b: TestUser) =>
  (await a.client.post('/v1/conversations/direct', { userId: b.id })).body.id as string;
const say = (u: TestUser, conv: string, body: string) =>
  u.client.post(`/v1/conversations/${conv}/messages`, { body });
const exportFor = async (u: TestUser) => {
  const r = await u.client.post('/v1/privacy/export', { password: u.password });
  if (r.status !== 202) throw new Error(`export failed ${r.status} ${JSON.stringify(r.body)}`);
  const link = await u.client.post(`/v1/privacy/requests/${r.body.requestId}/download-link`);
  const dl = await u.client.get(link.body.path);
  return {
    request: r.body,
    link: link.body,
    download: dl,
    archive: dl.status === 200 ? (dl.body as any) : null,
  };
};

describe('privacy overview', () => {
  it('requires authentication and reports what is held', async () => {
    expect((await new Client(t).get('/v1/privacy/overview')).status).toBe(401);
    const u = await signup(t);
    await post(u, `Overview post ${uniq('o')}`);
    const r = await u.client.get('/v1/privacy/overview');
    expect(r.status).toBe(200);
    const content = r.body.categories.find((c: any) => c.key === 'content');
    expect(content.detail.posts).toBe(1);
    expect(r.body.retainedAfterDeletion.length).toBeGreaterThan(0);
    expect(r.body.exportSections.map((s: any) => s.key)).toContain('posts');
  });

  it('visibility overview shows audiences of the caller only', async () => {
    const u = await signup(t);
    await post(u, `Vis ${uniq('v')}`, { visibility: 'followers' });
    await post(u, `Vis ${uniq('v')}`, { visibility: 'public' });
    const r = await u.client.get('/v1/privacy/visibility');
    expect(r.status).toBe(200);
    expect(r.body.postsByVisibility).toMatchObject({ followers: 1, public: 1 });
  });
});

describe('consents (append-only)', () => {
  it('defaults are privacy-preserving and hasConsent reads them', async () => {
    const u = await signup(t);
    expect(await hasConsent(t.ctx, u.id, 'analytics')).toBe(false);
    expect(await hasConsent(t.ctx, u.id, 'advertising')).toBe(false);
    expect(await hasConsent(t.ctx, u.id, 'ai_memory')).toBe(false);
    expect(await hasConsent(t.ctx, u.id, 'personalization')).toBe(true);
    const list = await u.client.get('/v1/privacy/consents');
    expect(list.body.items.find((c: any) => c.purpose === 'analytics')).toMatchObject({
      granted: false,
      isDefault: true,
    });
  });

  it('grant then withdraw appends rows; the latest wins and history is never rewritten', async () => {
    const u = await signup(t);
    expect(
      (await u.client.put('/v1/privacy/consents/analytics', { granted: true })).body,
    ).toMatchObject({ granted: true, changed: true });
    expect(await hasConsent(t.ctx, u.id, 'analytics')).toBe(true);
    // Same decision again is a no-op (no noise rows).
    expect(
      (await u.client.put('/v1/privacy/consents/analytics', { granted: true })).body.changed,
    ).toBe(false);
    expect(
      (await u.client.put('/v1/privacy/consents/analytics', { granted: false })).body,
    ).toMatchObject({ granted: false, changed: true });
    expect(await hasConsent(t.ctx, u.id, 'analytics')).toBe(false);
    const hist = await u.client.get('/v1/privacy/consents/history', { purpose: 'analytics' });
    expect(hist.body.items.map((h: any) => h.granted)).toEqual([false, true]);
    const rows = await sql('SELECT id FROM consents WHERE user_id = $1 AND purpose = $2', [
      u.id,
      'analytics',
    ]);
    expect(rows.rowCount).toBe(2);
  });

  it('the database refuses to update or delete consent rows', async () => {
    const u = await signup(t);
    await u.client.put('/v1/privacy/consents/analytics', { granted: true });
    await expect(
      sql('UPDATE consents SET granted = false WHERE user_id = $1', [u.id]),
    ).rejects.toThrow();
    await expect(sql('DELETE FROM consents WHERE user_id = $1', [u.id])).rejects.toThrow();
  });

  it('personalization is stored in user_preferences so feeds and consents cannot disagree', async () => {
    const u = await signup(t);
    await u.client.put('/v1/privacy/consents/personalization', { granted: false });
    expect(await hasConsent(t.ctx, u.id, 'personalization')).toBe(false);
    expect(
      (await sql('SELECT personalization FROM user_preferences WHERE user_id = $1', [u.id])).rows[0]
        .personalization,
    ).toBe(false);
  });

  it('withdrawing analytics consent detaches earlier events from the user', async () => {
    const u = await signup(t);
    await setConsent(t.ctx, u.id, 'analytics', true);
    await sql(`INSERT INTO analytics_events (user_id, name, properties) VALUES ($1, 'x', '{}')`, [
      u.id,
    ]);
    await u.client.put('/v1/privacy/consents/analytics', { granted: false });
    expect(
      (await sql('SELECT count(*)::int AS n FROM analytics_events WHERE user_id = $1', [u.id]))
        .rows[0].n,
    ).toBe(0);
  });

  it('teens cannot grant consents restricted to adults and are treated as not consenting', async () => {
    const teen = await teenUser();
    for (const purpose of ['advertising', 'analytics', 'ai_memory']) {
      expect(
        (await teen.client.put(`/v1/privacy/consents/${purpose}`, { granted: true })).status,
      ).toBe(403);
      expect(await hasConsent(t.ctx, teen.id, purpose as any)).toBe(false);
    }
    expect(
      (await teen.client.put('/v1/privacy/consents/ai_processing', { granted: true })).status,
    ).toBe(200);
    const ads = await teen.client.put('/v1/privacy/advertising', { personalizedAds: true });
    expect(ads.status).toBe(403);
  });

  it('rejects unknown purposes and anonymous callers', async () => {
    const u = await signup(t);
    expect(
      (await u.client.put('/v1/privacy/consents/mind_reading', { granted: true })).status,
    ).toBe(400);
    expect(
      (await new Client(t).put('/v1/privacy/consents/analytics', { granted: true })).status,
    ).toBe(401);
  });
});

describe('advertising preferences', () => {
  it('adults control topics and sensitive limits; teens cannot lower the sensitive limit', async () => {
    const u = await signup(t);
    const r = await u.client.put('/v1/privacy/advertising', {
      personalizedAds: true,
      hiddenTopics: ['Gambling', 'gambling', 'Alcohol'],
      limitSensitive: false,
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ personalizedAds: true, limitSensitive: false });
    expect(r.body.hiddenTopics.sort()).toEqual(['alcohol', 'gambling']);
    const teen = await teenUser();
    expect(
      (await teen.client.put('/v1/privacy/advertising', { limitSensitive: false })).status,
    ).toBe(403);
    expect((await teen.client.get('/v1/privacy/advertising')).body).toMatchObject({
      personalizedAds: false,
      availableToYou: false,
      limitSensitive: true,
    });
  });
});

describe('data export', () => {
  it('requires the password and the archive contains what the user owns', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const mine = await post(a, `My post ${uniq('m')}`);
    const theirs = await post(b, `Their post ${uniq('x')} secret-of-b`);
    await b.client.post(`/v1/posts/${theirs}/comments`, { body: 'secret-comment-of-b' });
    await a.client.post(`/v1/posts/${theirs}/comments`, { body: 'a comments on b' });
    await a.client.put(`/v1/posts/${theirs}/save`);
    const conv = await dm(a, b);
    await say(a, conv, 'hello from a');
    await say(b, conv, 'private reply from b secret-of-b');
    await a.client.put('/v1/privacy/consents/analytics', { granted: true });

    expect((await a.client.post('/v1/privacy/export', {})).status).toBe(400); // password missing
    expect(
      (await a.client.post('/v1/privacy/export', { password: 'wrong-password-123' })).status,
    ).toBe(401);

    const { archive, request } = await exportFor(a);
    expect(request.status).toBe('completed');
    expect(archive.format).toBe('yapilapi-export');
    expect(archive.userId).toBe(a.id);
    const s = archive.sections;
    // completeness across the registered sections
    for (const key of [
      'account',
      'profile',
      'preferences',
      'posts',
      'comments',
      'reactions_and_saves',
      'connections',
      'messages_sent',
      'notifications',
      'consents_and_requests',
      'security',
      'safety',
      'ai',
      'developer',
      'analytics',
    ]) {
      expect(s[key], key).toBeDefined();
    }
    expect(s.account.data.email).toBe(a.email);
    expect(s.profile.data.username).toBe(a.username);
    expect(s.posts.data.map((p: any) => p.id)).toContain(mine);
    expect(s.comments.data.map((c: any) => c.body)).toContain('a comments on b');
    expect(JSON.stringify(s.messages_sent.data)).toContain('hello from a');
    expect(JSON.stringify(s.consents_and_requests.data)).toContain('analytics');
  });

  it("never leaks other people's data or secrets", async () => {
    const a = await signup(t);
    const b = await signup(t);
    const theirs = await post(b, `Only B knows ${uniq('x')} secret-of-b`);
    await b.client.post(`/v1/posts/${theirs}/comments`, { body: 'secret-comment-of-b' });
    await a.client.put(`/v1/posts/${theirs}/save`);
    const conv = await dm(a, b);
    await say(b, conv, 'private reply from b secret-of-b');

    const { archive } = await exportFor(a);
    const text = JSON.stringify(archive);
    expect(text).not.toContain('secret-of-b');
    expect(text).not.toContain('secret-comment-of-b');
    expect(text).not.toContain(b.email);
    // secrets never leave the system
    const rows = await sql('SELECT password_hash FROM users WHERE id = $1', [a.id]);
    expect(text).not.toContain(rows.rows[0].password_hash);
    expect(text).not.toMatch(/password_hash|token_hash|secret_enc|key_hash/);
    // a user's export never includes another's export
    const other = await exportFor(b);
    expect(JSON.stringify(other.archive)).toContain('secret-of-b');
    expect(JSON.stringify(other.archive)).not.toContain(a.email);
  });

  it('is limited to one per 24 hours, counted in the database', async () => {
    const u = await signup(t);
    expect((await u.client.post('/v1/privacy/export', { password: u.password })).status).toBe(202);
    const again = await u.client.post('/v1/privacy/export', { password: u.password });
    expect(again.status).toBe(429);
    expect(again.body.error.details.retryAfterSec).toBeGreaterThan(0);
    await sql(
      `UPDATE privacy_requests SET created_at = now() - interval '25 hours' WHERE user_id = $1`,
      [u.id],
    );
    expect((await u.client.post('/v1/privacy/export', { password: u.password })).status).toBe(202);
  });

  it('download links are single use, expire, and only the owner can use them', async () => {
    const u = await signup(t);
    const other = await signup(t);
    const r = await u.client.post('/v1/privacy/export', { password: u.password });
    const id = r.body.requestId;
    expect((await other.client.post(`/v1/privacy/requests/${id}/download-link`)).status).toBe(404);
    const link = (await u.client.post(`/v1/privacy/requests/${id}/download-link`)).body;
    // another user's session with the stolen link cannot download
    expect((await other.client.get(link.path)).status).toBe(404);
    expect((await new Client(t).get(link.path)).status).toBe(401);
    // wrong token
    expect(
      (await u.client.get(`/v1/privacy/requests/${id}/download`, { token: 'x'.repeat(43) })).status,
    ).toBe(403);
    const ok = await u.client.get(link.path);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-disposition']).toContain('attachment');
    expect(ok.headers['cache-control']).toBe('no-store');
    // single use
    expect((await u.client.get(link.path)).status).toBe(403);
    // expired link
    const link2 = (await u.client.post(`/v1/privacy/requests/${id}/download-link`)).body;
    await sql(
      `UPDATE privacy_exports SET link_expires_at = now() - interval '1 minute' WHERE request_id = $1`,
      [id],
    );
    expect((await u.client.get(link2.path)).status).toBe(403);
    // the stored archive is compressed and matches the served bytes
    const stored = await sql(
      'SELECT payload_gz, sha256 FROM privacy_exports WHERE request_id = $1',
      [id],
    );
    expect(JSON.parse(gunzipSync(stored.rows[0].payload_gz).toString()).userId).toBe(u.id);
  });

  it('expired archives are purged and cannot be downloaded', async () => {
    const u = await signup(t);
    const r = await u.client.post('/v1/privacy/export', { password: u.password });
    await sql(
      `UPDATE privacy_exports SET expires_at = now() - interval '1 minute' WHERE request_id = $1`,
      [r.body.requestId],
    );
    expect(
      (await u.client.post(`/v1/privacy/requests/${r.body.requestId}/download-link`)).status,
    ).toBe(404);
    expect(await purgeExpiredExports(t.ctx)).toBeGreaterThanOrEqual(1);
    const list = await u.client.get('/v1/privacy/requests');
    expect(list.body.items[0]).toMatchObject({ kind: 'export', export: { downloadable: false } });
  });

  it('buildExport is what the endpoint serves (all sections registered)', async () => {
    const u = await signup(t);
    const a = await buildExport(t.ctx, u.id);
    expect(Object.keys(a.sections).length).toBeGreaterThanOrEqual(15);
  });
});

describe('account deletion finalizer', () => {
  it('does nothing before the grace period ends and can be cancelled', async () => {
    const u = await signup(t);
    const s = await u.client.post('/v1/account/deletion', { password: u.password });
    expect(s.status).toBe(200);
    const res = await finalizeDueDeletions(t.ctx);
    expect(res.failed).toEqual([]);
    expect((await sql('SELECT status FROM users WHERE id = $1', [u.id])).rows[0].status).toBe(
      'pending_deletion',
    );
    expect((await u.client.post('/v1/account/deletion/cancel')).status).toBe(200);
    await sql(`UPDATE users SET deletion_scheduled_for = now() - interval '1 day' WHERE id = $1`, [
      u.id,
    ]);
    await finalizeDueDeletions(t.ctx);
    expect((await sql('SELECT status FROM users WHERE id = $1', [u.id])).rows[0].status).toBe(
      'active',
    );
  });

  it("anonymises the account, removes owned data, keeps other people's conversations intact, retains audit and consent evidence", async () => {
    const u = await signup(t);
    const friend = await signup(t);
    const p = await post(u, `To be erased ${uniq('e')}`);
    const fp = await post(friend, `Friend post ${uniq('f')}`);
    await u.client.post(`/v1/posts/${fp}/comments`, { body: 'comment by leaver' });
    await u.client.post(`/v1/posts/${p}/comments`, { body: 'own comment' });
    await u.client.post('/v1/moments', { kind: 'text', body: 'moment by leaver' });
    await u.client.put(`/v1/posts/${fp}/save`);
    await u.client.post(`/v1/follows`, { username: friend.username }).catch(() => undefined);
    const conv = await dm(u, friend);
    expect((await say(u, conv, 'leaver message')).status).toBe(201);
    await say(friend, conv, 'friend message stays');
    await u.client.put('/v1/privacy/consents/analytics', { granted: true });
    await u.client.put('/v1/privacy/consents/ai_processing', { granted: true });
    await sql(`INSERT INTO push_tokens (user_id, platform, token) VALUES ($1,'ios',$2)`, [
      u.id,
      `tok-${uniq('t')}`,
    ]);
    const dev = await u.client.post('/v1/developer/apps', { name: 'Leaver app' });
    expect(dev.status).toBe(201);
    const ex = await exportFor(u);
    expect(ex.download.status).toBe(200);

    expect((await u.client.post('/v1/account/deletion', { password: u.password })).status).toBe(
      200,
    );
    await sql(
      `UPDATE users SET deletion_scheduled_for = now() - interval '1 minute' WHERE id = $1`,
      [u.id],
    );
    const res = await finalizeDueDeletions(t.ctx);
    expect(res).toMatchObject({ failed: [] });
    expect(res.finalized).toBeGreaterThanOrEqual(1);

    const user = (await sql('SELECT * FROM users WHERE id = $1', [u.id])).rows[0];
    expect(user).toMatchObject({ status: 'deleted', password_hash: null });
    expect(user.email).not.toContain(u.email);
    expect(user.deleted_at).not.toBeNull();
    const prof = (await sql('SELECT * FROM profiles WHERE user_id = $1', [u.id])).rows[0];
    expect(prof.display_name).toBe('Deleted user');
    expect(prof.username).not.toBe(u.username);

    // credentials and personal artefacts are gone
    for (const [table, col] of [
      ['sessions', 'user_id'],
      ['push_tokens', 'user_id'],
      ['notifications', 'user_id'],
      ['privacy_exports', 'user_id'],
      ['developer_apps', 'owner_id'],
      ['user_preferences', 'user_id'],
    ] as const) {
      expect(
        (await sql(`SELECT count(*)::int AS n FROM ${table} WHERE ${col} = $1`, [u.id])).rows[0].n,
        table,
      ).toBe(0);
    }
    // content is no longer visible to anyone, and comments on other people's posts are blanked/removed
    expect((await new Client(t).get(`/v1/posts/${p}`)).status).toBe(404);
    const leftover = await sql(`SELECT body, deleted_at FROM comments WHERE author_id = $1`, [
      u.id,
    ]);
    for (const c of leftover.rows) expect(c.deleted_at !== null || c.body === '').toBe(true);
    // the friend's conversation keeps the friend's messages; the leaver's are blanked
    const msgs = await sql(
      `SELECT sender_id, body, deleted_at FROM messages WHERE conversation_id = $1`,
      [conv],
    );
    expect(msgs.rows.find((m) => m.sender_id === friend.id).body).toBe('friend message stays');
    expect(msgs.rows.some((m) => m.body === 'leaver message')).toBe(false);
    expect(msgs.rows.filter((m) => m.body === '' && m.deleted_at)).toHaveLength(1);
    // consent evidence and audit logs are retained (pseudonymous)
    expect(
      (await sql('SELECT count(*)::int AS n FROM consents WHERE user_id = $1', [u.id])).rows[0].n,
    ).toBeGreaterThanOrEqual(2);
    expect(
      (
        await sql(
          `SELECT count(*)::int AS n FROM audit_logs WHERE target_id = $1 AND action = 'account.deleted'`,
          [u.id],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await sql(`SELECT status FROM privacy_requests WHERE user_id = $1 AND kind = 'delete'`, [
          u.id,
        ])
      ).rows[0].status,
    ).toBe('completed');

    // the account can no longer sign in
    const login = await new Client(t, 'bearer').request('POST', '/v1/auth/login', {
      body: { email: u.email, password: u.password, deliver: 'token' },
    });
    expect(login.status).toBeGreaterThanOrEqual(400);
    // and the old session is dead
    expect((await u.client.get('/v1/privacy/overview')).status).toBe(401);
    // running again is a no-op
    expect((await finalizeDueDeletions(t.ctx)).finalized).toBe(0);
  });

  it('a failing account is retried and does not block others', async () => {
    const good = await signup(t);
    const bad = await signup(t);
    for (const x of [good, bad]) {
      await x.client.post('/v1/account/deletion', { password: x.password });
      await sql(
        `UPDATE users SET deletion_scheduled_for = now() - interval '1 minute' WHERE id = $1`,
        [x.id],
      );
    }
    // Sabotage `bad` with a constraint-violating trigger for just this user, then repair it.
    await sql(
      `CREATE OR REPLACE FUNCTION test_block_delete() RETURNS trigger AS $$ BEGIN IF NEW.id = '${bad.id}' THEN RAISE EXCEPTION 'blocked for test'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`,
    );
    await sql(
      `CREATE TRIGGER test_block_delete_trg BEFORE UPDATE OF status ON users FOR EACH ROW WHEN (NEW.status = 'deleted') EXECUTE FUNCTION test_block_delete()`,
    );
    try {
      const res = await finalizeDueDeletions(t.ctx);
      expect(res.failed.map((f) => f.userId)).toContain(bad.id);
      expect((await sql('SELECT status FROM users WHERE id = $1', [good.id])).rows[0].status).toBe(
        'deleted',
      );
      // rolled back completely: nothing half-deleted for the failing account
      expect((await sql('SELECT status FROM users WHERE id = $1', [bad.id])).rows[0].status).toBe(
        'pending_deletion',
      );
      expect(
        (await sql('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1', [bad.id])).rows[0]
          .n,
      ).toBeGreaterThan(0);
    } finally {
      await sql('DROP TRIGGER test_block_delete_trg ON users');
    }
    expect((await finalizeDueDeletions(t.ctx)).finalized).toBeGreaterThanOrEqual(1);
    expect((await sql('SELECT status FROM users WHERE id = $1', [bad.id])).rows[0].status).toBe(
      'deleted',
    );
  });
});

describe('connected apps', () => {
  it('lists authorised apps and lets the user revoke them (tokens die immediately)', async () => {
    const dev = await signup(t);
    const u = await signup(t);
    const app = (
      await dev.client.post('/v1/developer/apps', {
        name: 'Photo Booth',
        redirectUris: ['https://photobooth.example.test/cb'],
        confidential: false,
      })
    ).body;
    const verifier = 'v'.repeat(50);
    const auth = await u.client.post('/v1/oauth/authorize', {
      response_type: 'code',
      client_id: app.clientId,
      redirect_uri: 'https://photobooth.example.test/cb',
      scope: 'profile:read',
      code_challenge: pkceChallengeFromVerifier(verifier),
      code_challenge_method: 'S256',
      approve: true,
      state: 'xyz',
    });
    expect(auth.status).toBe(200);
    const code = new URL(auth.body.redirectTo).searchParams.get('code')!;
    const tok = await new Client(t, 'bearer').request('POST', '/v1/oauth/token', {
      body: {
        grant_type: 'authorization_code',
        client_id: app.clientId,
        code,
        redirect_uri: 'https://photobooth.example.test/cb',
        code_verifier: verifier,
      },
    });
    expect(tok.status).toBe(200);

    const list = await u.client.get('/v1/privacy/connected-apps');
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({
      app: { name: 'Photo Booth' },
      scopes: [{ scope: 'profile:read' }],
    });
    const api = new Client(t, 'bearer');
    api.token = tok.body.access_token;
    expect((await api.get('/v1/public/me')).status).toBe(200);

    expect(
      (await dev.client.del(`/v1/privacy/connected-apps/${list.body.items[0].id}`)).status,
    ).toBe(404); // not their grant
    expect((await u.client.del(`/v1/privacy/connected-apps/${list.body.items[0].id}`)).status).toBe(
      204,
    );
    expect((await api.get('/v1/public/me')).status).toBe(401);
    expect((await u.client.get('/v1/privacy/connected-apps')).body.items).toHaveLength(0);
    expect((await u.client.del(`/v1/privacy/connected-apps/${list.body.items[0].id}`)).status).toBe(
      404,
    );
  });
});
