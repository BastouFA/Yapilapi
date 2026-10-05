import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '@yapilapi/auth';
import type { BuiltApp } from '../src/app.ts';
import { as, signUp, testApp, type TestUser } from './helpers.ts';

/**
 * The identity, security and privacy sweep of 2026-09-29: each test pins a hole or a gap that was
 * open (sign-in guesses spread over many addresses, reset links outliving a new password, API keys
 * reaching account settings, cookie requests from other origins, and signed-out people search
 * finding people under 18 and private accounts by their hidden bio).
 */

let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.close();
});

const db = () => t.ctx.db;
const TEEN = `${new Date().getUTCFullYear() - 15}-03-01`;
const outbox = async () => (await t.app.inject({ url: '/dev/outbox' })).json().items as { to: string; text: string }[];
const login = (email: string, password: string, ip = '203.0.113.9') =>
  t.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password }, remoteAddress: ip });

async function resetLink(u: TestUser): Promise<string> {
  await t.app.inject({ method: 'POST', url: '/v1/auth/password/forgot', payload: { email: u.email } });
  const mail = (await outbox()).filter((m) => m.to === u.email && m.text.includes('reset-password')).pop();
  return mail!.text.match(/token=([\w-]+)/)![1]!;
}

describe('signing in', () => {
  it('makes an account wait after 10 wrong passwords, whichever addresses they come from', async () => {
    const u = await signUp(t.app);
    for (let i = 0; i < 10; i++) expect((await login(u.email, `wrong-password-${i}`, `198.51.100.${i + 1}`)).statusCode).toBe(401);
    // The right password from yet another address waits too, with a way out.
    const locked = await login(u.email, u.password, '192.0.2.77');
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.code).toBe('too_many_attempts');
    // Resetting the password starts the count again.
    const token = await resetLink(u);
    expect((await t.app.inject({ method: 'POST', url: '/v1/auth/password/reset', payload: { token, password: 'a-brand-new-password' } })).statusCode).toBe(200);
    expect((await login(u.email, 'a-brand-new-password')).statusCode).toBe(200);
  });

  it('starts the count again after a sign-in, and never locks an address out of other accounts', async () => {
    const u = await signUp(t.app);
    for (let i = 0; i < 9; i++) await login(u.email, `wrong-password-${i}`);
    expect((await login(u.email, u.password)).statusCode).toBe(200);
    for (let i = 0; i < 9; i++) expect((await login(u.email, `wrong-again-${i}`)).statusCode).toBe(401);
    const other = await signUp(t.app);
    expect((await login(other.email, other.password)).statusCode).toBe(200);
  });
});

describe('password reset links', () => {
  it('stop working once the password is reset with another link, or changed in Settings', async () => {
    const u = await signUp(t.app);
    const first = await resetLink(u);
    const second = await resetLink(u);
    expect(
      (await t.app.inject({ method: 'POST', url: '/v1/auth/password/reset', payload: { token: second, password: 'reset-password-one' } })).statusCode,
    ).toBe(200);
    expect((await t.app.inject({ method: 'POST', url: '/v1/auth/password/reset', payload: { token: first, password: 'someone-elses-pick' } })).statusCode).toBe(
      400,
    );

    const v = await signUp(t.app);
    const early = await resetLink(v);
    expect((await as(t.app, v).post('/v1/auth/password/change', { currentPassword: v.password, newPassword: 'changed-in-settings' })).status).toBe(200);
    expect((await t.app.inject({ method: 'POST', url: '/v1/auth/password/reset', payload: { token: early, password: 'undo-the-change-1' } })).statusCode).toBe(
      400,
    );
  });
});

describe('developer API keys', () => {
  it('cannot reach what identifies or protects the account', async () => {
    const u = await signUp(t.app);
    const app = await as(t.app, u).post('/v1/developer/apps', { name: 'Sweep app' });
    const key = await as(t.app, u).post(`/v1/developer/apps/${app.body.app.id}/keys`, { name: 'k', scopes: ['read', 'write'] });
    const k = as(t.app, { ...u, token: key.body.secret });
    const refused: [keyof typeof k, string, unknown?][] = [
      ['put', '/v1/me/sign-in-alerts', { email: false }],
      ['put', '/v1/me/phone', { phone: '+2348012345678' }],
      ['put', '/v1/me/username', { username: 'taken_by_a_key' }],
      ['post', '/v1/me/birth-date', { birthDate: '2000-01-01' }],
      ['get', '/v1/me/account'],
      ['get', '/v1/me/verification'],
      ['get', '/v1/me/privacy'],
      ['post', '/v1/family/invite', { username: 'someone' }],
      ['get', '/v1/family'],
      ['get', '/v1/me/connected-apps'],
      ['get', '/v1/%6De/%61ccount'],
    ];
    for (const [method, url, body] of refused) {
      const r = await (k[method] as (u: string, b?: unknown) => Promise<{ status: number }>)(url, body);
      expect(r.status, `${method} ${url}`).toBe(403);
    }
    // Ordinary reads and writes still work.
    expect((await k.get(`/v1/users/${u.username}`)).status).toBe(200);
    expect((await k.patch('/v1/me/profile', { bio: 'Set from an app' })).status).toBe(200);
    const alerts = await db().query(`SELECT sign_in_email_alerts FROM user_preferences WHERE user_id = $1`, [u.id]);
    expect(alerts.rows[0].sign_in_email_alerts).not.toBe(false);
  });
});

describe('cookie requests from another origin', () => {
  it('are refused for changes; the web app, the phone and servers are not affected', async () => {
    const u = await signUp(t.app);
    const cookie = `${SESSION_COOKIE}=${u.token}`;
    const forged = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/logout-all',
      headers: { cookie, origin: 'http://localhost:3999', 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'a=b',
    });
    expect(forged.statusCode).toBe(403);
    expect((await as(t.app, u).get('/v1/auth/me')).status).toBe(200);
    // The web app's own origin, no origin at all (its server), and a Bearer token from anywhere.
    const own = await t.app.inject({ method: 'PATCH', url: '/v1/me/profile', headers: { cookie, origin: 'http://localhost:3000' }, payload: { bio: 'a' } });
    expect(own.statusCode).toBe(200);
    const server = await t.app.inject({ method: 'PATCH', url: '/v1/me/profile', headers: { cookie }, payload: { bio: 'b' } });
    expect(server.statusCode).toBe(200);
    const bearer = await t.app.inject({
      method: 'PATCH',
      url: '/v1/me/profile',
      headers: { authorization: `Bearer ${u.token}`, origin: 'http://localhost:3999' },
      payload: { bio: 'c' },
    });
    expect(bearer.statusCode).toBe(200);
    // Reading is fine (CORS keeps the answer from the other page).
    expect((await t.app.inject({ url: '/v1/auth/me', headers: { cookie, origin: 'http://localhost:3999' } })).statusCode).toBe(200);
  });
});

describe('people search without an account', () => {
  it('never finds people under 18, and finds a private account only by its name', async () => {
    const mark = `zq${Date.now().toString(36)}`;
    const teen = await signUp(t.app, { birthDate: TEEN, displayName: `Teen ${mark}` });
    const adult = await signUp(t.app, { displayName: `Adult ${mark}` });
    const signedOut = await as(t.app, null).get(`/v1/search?q=${mark}&type=people`);
    const ids = signedOut.body.results.people.map((p: { id: string }) => p.id);
    expect(ids).toContain(adult.id);
    expect(ids).not.toContain(teen.id);
    // Signed in, the rules for signed-in people apply (the teen's profile shows as private).
    const signedIn = await as(t.app, adult).get(`/v1/search?q=${mark}&type=people`);
    expect(signedIn.body.results.people.map((p: { id: string }) => p.id)).toContain(teen.id);

    const priv = await signUp(t.app);
    await as(t.app, priv).patch('/v1/me/profile', { isPrivate: true, bio: `Loves ${mark}bio` });
    const byBio = await as(t.app, null).get(`/v1/search?q=${mark}bio&type=people`);
    expect(byBio.body.results.people.map((p: { id: string }) => p.id)).not.toContain(priv.id);
    const byName = await as(t.app, null).get(`/v1/search?q=${priv.username}&type=people`);
    expect(byName.body.results.people.map((p: { id: string }) => p.id)).toContain(priv.id);
  });
});

describe('a profile you blocked', () => {
  it('shows you their name only, marked blocked, so you can unblock; they still cannot find you', async () => {
    const me = await signUp(t.app);
    const them = await signUp(t.app);
    await as(t.app, them).patch('/v1/me/profile', { bio: '[Dev data] Not for blockers' });
    expect((await as(t.app, me).post(`/v1/users/${them.id}/block`)).status).toBe(200);

    const seen = await as(t.app, me).get(`/v1/users/${them.username}`);
    expect(seen.status).toBe(200);
    expect(seen.body.profile).toMatchObject({ username: them.username, bio: '', relationship: { blocked: true } });
    expect(seen.body.profile.counts).toEqual({ followers: 0, following: 0, friends: 0, posts: 0 });

    // The blocked person still gets not found.
    expect((await as(t.app, them).get(`/v1/users/${me.username}`)).status).toBe(404);

    expect((await as(t.app, me).del(`/v1/users/${them.id}/block`)).status).toBe(200);
    expect((await as(t.app, me).get(`/v1/users/${them.username}`)).body.profile.bio).toBe('[Dev data] Not for blockers');
  });
});
