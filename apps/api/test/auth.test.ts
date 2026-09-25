import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpAt } from '@yapilapi/security';
import { Client, ORIGIN, createTestApp, enableMfa, signup, uniq, type TestApp } from './helpers.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

const tokenFrom = (text: string) => /token=([A-Za-z0-9_-]+)/.exec(text)![1]!;

describe('registration', () => {
  it('creates an account, sets an httpOnly cookie, and returns the current user', async () => {
    const u = await signup(t);
    expect(u.client.cookies.has('yl_session')).toBe(true);
    const me = await u.client.get('/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(u.email);
    expect(me.body.user.emailVerified).toBe(false);
    expect(me.body.user.profile.username).toBe(u.username);
    expect(me.body.user).not.toHaveProperty('passwordHash');
  });

  it('never stores the password or session token in plaintext', async () => {
    const u = await signup(t);
    const { rows } = await t.ctx.db.query('SELECT password_hash FROM users WHERE id = $1', [u.id]);
    expect(rows[0].password_hash).toMatch(/^scrypt\$/);
    expect(rows[0].password_hash).not.toContain(u.password);
    const raw = u.client.cookies.get('yl_session')!;
    const s = await t.ctx.db.query('SELECT 1 FROM sessions WHERE token_hash = $1', [raw]);
    expect(s.rowCount).toBe(0);
  });

  it('rejects duplicate email and username, weak passwords, reserved names, and under-13s', async () => {
    const u = await signup(t);
    const c = new Client(t);
    const base = {
      password: 'Sturdy-Passphrase-42',
      displayName: 'X',
      birthDate: '1990-01-01',
      acceptTerms: true,
    };
    expect(
      (await c.post('/v1/auth/register', { ...base, email: u.email, username: uniq() })).status,
    ).toBe(409);
    expect(
      (
        await c.post('/v1/auth/register', {
          ...base,
          email: `${uniq()}@example.test`,
          username: u.username,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await c.post('/v1/auth/register', {
          ...base,
          password: 'password1234',
          email: `${uniq()}@example.test`,
          username: uniq(),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await c.post('/v1/auth/register', {
          ...base,
          email: `${uniq()}@example.test`,
          username: 'admin',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await c.post('/v1/auth/register', {
          ...base,
          birthDate: '2020-01-01',
          email: `${uniq()}@example.test`,
          username: uniq(),
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await c.post('/v1/auth/register', {
          ...base,
          email: `${uniq()}@example.test`,
          username: uniq(),
          acceptTerms: false,
        })
      ).status,
    ).toBe(400);
  });

  it('applies safer defaults to teen accounts', async () => {
    const teen = await signup(t, { birthDate: `${new Date().getUTCFullYear() - 15}-01-01` });
    const { rows } = await t.ctx.db.query(
      'SELECT p.is_private, up.who_can_message, up.discoverable, up.default_post_visibility FROM profiles p JOIN user_preferences up USING (user_id) WHERE p.user_id = $1',
      [teen.id],
    );
    expect(rows[0]).toEqual({
      is_private: true,
      who_can_message: 'friends',
      discoverable: false,
      default_post_visibility: 'followers',
    });
  });
});

describe('login, sessions and logout', () => {
  it('logs in with correct credentials and rejects wrong ones with a uniform error', async () => {
    const u = await signup(t);
    const c = new Client(t);
    const bad = await c.post('/v1/auth/login', { email: u.email, password: 'wrong-password-1' });
    const unknown = await c.post('/v1/auth/login', {
      email: `${uniq()}@example.test`,
      password: 'wrong-password-1',
    });
    expect(bad.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(bad.body.error.message).toBe(unknown.body.error.message);
    const ok = await c.post('/v1/auth/login', { email: u.email, password: u.password });
    expect(ok.status).toBe(200);
    expect((await c.get('/v1/auth/me')).status).toBe(200);
  });

  it('locks the account after repeated failures, then still rejects the right password while locked', async () => {
    const u = await signup(t);
    const c = new Client(t);
    for (let i = 0; i < 5; i++)
      await c.post('/v1/auth/login', { email: u.email, password: 'nope-nope-nope' });
    const locked = await c.post('/v1/auth/login', { email: u.email, password: u.password });
    expect(locked.status).toBe(401);
    const { rows } = await t.ctx.db.query(
      `SELECT count(*)::int AS n FROM security_events WHERE user_id = $1 AND type = 'account_locked'`,
      [u.id],
    );
    expect(rows[0].n).toBe(1);
  });

  it('logout invalidates the session server-side', async () => {
    const u = await signup(t);
    const stolen = u.client.cookies.get('yl_session')!;
    expect((await u.client.post('/v1/auth/logout')).status).toBe(204);
    const replay = await t.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie: `yl_session=${stolen}` },
    });
    expect(replay.statusCode).toBe(401);
  });

  it("lists and revokes sessions; users cannot revoke others' sessions", async () => {
    const a = await signup(t);
    const second = new Client(t);
    await second.post('/v1/auth/login', { email: a.email, password: a.password });
    const list = await a.client.get('/v1/auth/sessions');
    expect(list.body.items.length).toBe(2);
    const other = list.body.items.find((s: any) => !s.current);
    const b = await signup(t);
    expect((await b.client.del(`/v1/auth/sessions/${other.id}`)).status).toBe(404);
    expect((await a.client.del(`/v1/auth/sessions/${other.id}`)).status).toBe(204);
    expect((await second.get('/v1/auth/me')).status).toBe(401);
  });

  it('supports bearer tokens for mobile clients', async () => {
    const u = await signup(t, { mode: 'bearer' });
    expect(u.client.token).toBeTruthy();
    expect((await u.client.get('/v1/auth/me')).status).toBe(200);
  });
});

describe('CSRF and cookie hardening', () => {
  it('sets HttpOnly + SameSite=Lax on the session cookie', async () => {
    const u = `${uniq()}`;
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers: { origin: ORIGIN, 'x-yl-csrf': '1' },
      payload: {
        email: `${u}@example.test`,
        password: 'Sturdy-Passphrase-42',
        username: u,
        displayName: 'C',
        birthDate: '1990-01-01',
        acceptTerms: true,
      },
    });
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
  });

  it('rejects cross-origin and header-less cookie-authenticated writes', async () => {
    const u = await signup(t);
    const cookie = `yl_session=${u.client.cookies.get('yl_session')}`;
    const evil = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie, origin: 'https://evil.example', 'x-yl-csrf': '1' },
    });
    expect(evil.statusCode).toBe(403);
    const noHeader = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie, origin: ORIGIN },
    });
    expect(noHeader.statusCode).toBe(403);
    const noOrigin = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie, 'x-yl-csrf': '1' },
    });
    expect(noOrigin.statusCode).toBe(403);
    expect((await u.client.get('/v1/auth/me')).status).toBe(200); // still signed in: none of the above executed
  });
});

describe('email verification and password reset', () => {
  it('verifies email via a single-use token', async () => {
    const u = await signup(t);
    const token = tokenFrom(t.email.last(u.email)!.text);
    expect((await new Client(t).post('/v1/auth/email/verify', { token })).status).toBe(200);
    expect((await u.client.get('/v1/auth/me')).body.user.emailVerified).toBe(true);
    expect((await new Client(t).post('/v1/auth/email/verify', { token })).status).toBe(400);
  });

  it('reset flow: no enumeration, single-use, revokes all sessions, new password works', async () => {
    const u = await signup(t);
    const c = new Client(t);
    const known = await c.post('/v1/auth/password/forgot', { email: u.email });
    const unknown = await c.post('/v1/auth/password/forgot', { email: `${uniq()}@example.test` });
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(known.body).toEqual(unknown.body);
    const token = tokenFrom(t.email.last(u.email)!.text);
    expect(
      (await c.post('/v1/auth/password/reset', { token, newPassword: 'Another-Strong-Pass-9' }))
        .status,
    ).toBe(200);
    expect(
      (await c.post('/v1/auth/password/reset', { token, newPassword: 'Yet-Another-Pass-77' }))
        .status,
    ).toBe(400);
    expect((await u.client.get('/v1/auth/me')).status).toBe(401);
    expect(
      (
        await new Client(t).post('/v1/auth/login', {
          email: u.email,
          password: 'Another-Strong-Pass-9',
        })
      ).status,
    ).toBe(200);
    expect(
      (await new Client(t).post('/v1/auth/login', { email: u.email, password: u.password })).status,
    ).toBe(401);
  });

  it('password change requires the current password and keeps only the current session', async () => {
    const u = await signup(t);
    const other = new Client(t);
    await other.post('/v1/auth/login', { email: u.email, password: u.password });
    expect(
      (
        await u.client.post('/v1/auth/password/change', {
          currentPassword: 'wrong',
          newPassword: 'Brand-New-Pass-123',
        })
      ).status,
    ).toBe(401);
    const ok = await u.client.post('/v1/auth/password/change', {
      currentPassword: u.password,
      newPassword: 'Brand-New-Pass-123',
    });
    expect(ok.body.otherSessionsRevoked).toBe(1);
    expect((await other.get('/v1/auth/me')).status).toBe(401);
    expect((await u.client.get('/v1/auth/me')).status).toBe(200);
  });
});

describe('multi-factor authentication', () => {
  it('requires a TOTP code at login once enabled; codes cannot be replayed; recovery codes are single-use', async () => {
    const u = await signup(t);
    const { secret, recoveryCodes } = await enableMfa(u);
    const c = new Client(t);
    const step1 = await c.post('/v1/auth/login', { email: u.email, password: u.password });
    expect(step1.body.mfaRequired).toBe(true);
    expect(c.cookies.has('yl_session')).toBe(false);
    expect(
      (
        await c.post('/v1/auth/mfa/verify', {
          challengeToken: step1.body.challengeToken,
          code: '000000',
        })
      ).status,
    ).toBe(401);

    // Use the next time-step so we don't collide with the code consumed during enrolment.
    const code = totpAt(secret, Date.now() + 30_000);
    const ok = await c.post('/v1/auth/mfa/verify', {
      challengeToken: step1.body.challengeToken,
      code,
    });
    expect(ok.status).toBe(200);
    expect((await c.get('/v1/auth/me')).status).toBe(200);

    const c2 = new Client(t);
    const s2 = await c2.post('/v1/auth/login', { email: u.email, password: u.password });
    expect(
      (await c2.post('/v1/auth/mfa/verify', { challengeToken: s2.body.challengeToken, code }))
        .status,
    ).toBe(401); // replay

    const s3 = await new Client(t).post('/v1/auth/login', { email: u.email, password: u.password });
    const c3 = new Client(t);
    expect(
      (
        await c3.post('/v1/auth/mfa/verify', {
          challengeToken: s3.body.challengeToken,
          recoveryCode: recoveryCodes[0],
        })
      ).status,
    ).toBe(200);
    const s4 = await new Client(t).post('/v1/auth/login', { email: u.email, password: u.password });
    expect(
      (
        await new Client(t).post('/v1/auth/mfa/verify', {
          challengeToken: s4.body.challengeToken,
          recoveryCode: recoveryCodes[0],
        })
      ).status,
    ).toBe(401);
  });

  it('limits guesses per challenge', async () => {
    const u = await signup(t);
    const { secret } = await enableMfa(u);
    const c = new Client(t);
    const s = await c.post('/v1/auth/login', { email: u.email, password: u.password });
    for (let i = 0; i < 5; i++)
      await c.post('/v1/auth/mfa/verify', {
        challengeToken: s.body.challengeToken,
        code: '111111',
      });
    const valid = totpAt(secret, Date.now() + 30_000);
    expect(
      (await c.post('/v1/auth/mfa/verify', { challengeToken: s.body.challengeToken, code: valid }))
        .status,
    ).toBe(401);
  });

  it('stores TOTP secrets encrypted', async () => {
    const u = await signup(t);
    const { secret } = await enableMfa(u);
    const { rows } = await t.ctx.db.query('SELECT secret_enc FROM mfa_factors WHERE user_id = $1', [
      u.id,
    ]);
    expect(rows[0].secret_enc).not.toContain(secret);
    expect(rows[0].secret_enc.startsWith('v1.')).toBe(true);
  });
});

describe('account deletion', () => {
  it('schedules deletion with a grace period and can be cancelled', async () => {
    const u = await signup(t);
    expect((await u.client.post('/v1/account/deletion', { password: 'wrong' })).status).toBe(401);
    const del = await u.client.post('/v1/account/deletion', { password: u.password });
    expect(del.status).toBe(200);
    expect((await u.client.get('/v1/auth/me')).body.user.status).toBe('pending_deletion');
    expect((await u.client.post('/v1/account/deletion/cancel')).status).toBe(200);
    expect((await u.client.get('/v1/auth/me')).body.user.status).toBe('active');
  });
});

describe('platform basics', () => {
  it('serves health, readiness and structured errors', async () => {
    const c = new Client(t);
    expect((await c.get('/health/live')).status).toBe(200);
    const ready = await c.get('/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.checks.database).toBe('ok');
    const nf = await c.get('/nope');
    expect(nf.status).toBe(404);
    expect(nf.body.error.code).toBe('not_found');
    expect(nf.headers['x-request-id']).toBeTruthy();
    expect((await c.get('/v1/auth/me')).status).toBe(401);
  });

  it('exposes feature flags and only the required security headers', async () => {
    const c = new Client(t);
    const meta = await c.get('/v1/meta');
    expect(meta.body.flags).toMatchObject({ COMMERCE: true, LIVE: false });
    expect(meta.headers['x-content-type-options']).toBe('nosniff');
    expect(meta.headers['x-powered-by']).toBeUndefined();
  });
});
