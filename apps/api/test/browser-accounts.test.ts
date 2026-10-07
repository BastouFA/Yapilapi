import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNTS_COOKIE, hashToken, SESSION_COOKIE } from '@yapilapi/auth';
import { MAX_DEVICE_ACCOUNTS } from '@yapilapi/shared';
import type { BuiltApp } from '../src/app.ts';
import { as, signUp, testApp, type TestUser } from './helpers.ts';

/**
 * More than one account in one browser (modules/browser-accounts.ts): signing in to another
 * account keeps the first, switching, logging out of one or all, the limit, and that nothing
 * but this browser's own live sessions can be switched to, and no token ever reaches the page.
 */

let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.close();
});

const db = () => t.ctx.db;

/** A browser: keeps the cookies the API sets and sends them back, like the website's pages do. */
function browser(headers: Record<string, string> = {}) {
  const jar = new Map<string, { value: string; httpOnly?: boolean; maxAge?: number }>();
  const bodies: string[] = [];
  const call = async (method: 'GET' | 'POST', url: string, payload?: unknown, extra: Record<string, string> = {}) => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v.value}`).join('; ');
    const res = await t.app.inject({ method, url, payload: payload as never, headers: { ...headers, ...extra, ...(cookie ? { cookie } : {}) } });
    for (const c of res.cookies as { name: string; value: string; httpOnly?: boolean; maxAge?: number; expires?: Date }[]) {
      if (!c.value || (c.expires && c.expires.getTime() < Date.now())) jar.delete(c.name);
      else jar.set(c.name, { value: c.value, httpOnly: c.httpOnly, maxAge: c.maxAge });
    }
    bodies.push(res.body);
    return { status: res.statusCode, body: res.body ? (res.json() as any) : null };
  };
  return {
    jar,
    bodies,
    get: (url: string) => call('GET', url),
    post: (url: string, payload: unknown = {}, extra?: Record<string, string>) => call('POST', url, payload, extra),
    login: (u: TestUser, more: Record<string, unknown> = {}) => call('POST', '/v1/auth/login', { email: u.email, password: u.password, ...more }),
    add: (u: TestUser) => call('POST', '/v1/auth/login', { email: u.email, password: u.password, addAccount: true }),
    me: async () => (await call('GET', '/v1/auth/me')).body?.user?.id as string | undefined,
    accounts: async () =>
      (await call('GET', '/v1/auth/accounts')).body as { items: { id: string; username: string; current: boolean; unread: number }[]; max: number },
    tokens: () => [jar.get(SESSION_COOKIE)?.value, ...(jar.get(ACCOUNTS_COOKIE)?.value.split('.') ?? [])].filter((x): x is string => !!x),
  };
}

const ids = (list: { items: { id: string }[] }) => list.items.map((a) => a.id);

describe('accounts on one browser', () => {
  it('adds a second account, lists both and switches back and forth', async () => {
    const [a, b] = [await signUp(t.app), await signUp(t.app)];
    const web = browser();
    expect((await web.login(a)).status).toBe(200);
    let list = await web.accounts();
    expect(list.items).toEqual([{ id: a.id, username: a.username, displayName: expect.any(String), avatarUrl: null, current: true, unread: 0 }]);
    expect(list.max).toBe(MAX_DEVICE_ACCOUNTS);

    expect((await web.add(b)).status).toBe(200);
    expect(await web.me()).toBe(b.id);
    list = await web.accounts();
    expect(ids(list)).toEqual([a.id, b.id]);
    expect(list.items.map((x) => x.current)).toEqual([false, true]);
    // Both cookies are httpOnly: the page can't read either.
    expect(web.jar.get(SESSION_COOKIE)?.httpOnly).toBe(true);
    expect(web.jar.get(ACCOUNTS_COOKIE)?.httpOnly).toBe(true);

    const s = await web.post('/v1/auth/accounts/switch', { userId: a.id });
    expect(s.status).toBe(200);
    expect(s.body.user.id).toBe(a.id);
    expect(await web.me()).toBe(a.id);
    expect((await web.accounts()).items.map((x) => x.current)).toEqual([true, false]);
    expect((await web.post('/v1/auth/accounts/switch', { userId: b.id })).status).toBe(200);
    expect(await web.me()).toBe(b.id);
    // The order stays the order they were added.
    expect(ids(await web.accounts())).toEqual([a.id, b.id]);
  });

  it('counts unread notifications for the accounts not in use', async () => {
    const [a, b] = [await signUp(t.app), await signUp(t.app)];
    const web = browser();
    await web.login(a);
    await web.add(b);
    // b follows a: a gets a notification while b is in use.
    expect((await as(t.app, b).post(`/v1/users/${a.id}/follow`)).status).toBeLessThan(300);
    const list = await web.accounts();
    expect(list.items.find((x) => x.id === a.id)?.unread).toBeGreaterThanOrEqual(1);
    expect(list.items.find((x) => x.id === b.id)?.unread).toBe(0);
  });

  it('never sends a token in a response', async () => {
    const [a, b] = [await signUp(t.app), await signUp(t.app)];
    const web = browser();
    await web.login(a);
    await web.add(b);
    const tokens = web.tokens();
    expect(tokens.length).toBeGreaterThanOrEqual(2);
    web.bodies.length = 0;
    await web.accounts();
    await web.post('/v1/auth/accounts/switch', { userId: a.id });
    await web.post('/v1/auth/accounts/logout', { userId: b.id });
    await web.accounts();
    for (const body of web.bodies) for (const token of tokens) expect(body).not.toContain(token);
  });

  it('keeps at most five accounts: Add account past that is refused, a plain sign-in makes room', async () => {
    const users: TestUser[] = [];
    for (let i = 0; i < MAX_DEVICE_ACCOUNTS + 1; i++) users.push(await signUp(t.app));
    const web = browser();
    await web.login(users[0]!);
    for (const u of users.slice(1, MAX_DEVICE_ACCOUNTS)) expect((await web.add(u)).status).toBe(200);
    expect((await web.accounts()).items).toHaveLength(MAX_DEVICE_ACCOUNTS);

    const extra = users[MAX_DEVICE_ACCOUNTS]!;
    const refused = await web.add(extra);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('too_many_accounts');
    expect(refused.body.error.message).toBe(`You can keep up to ${MAX_DEVICE_ACCOUNTS} accounts in this browser.`);
    // Nothing changed: no session was made (only the one from signing up), and the account in use is the same.
    expect((await db().query(`SELECT 1 FROM sessions WHERE user_id = $1`, [extra.id])).rowCount).toBe(1);
    expect(await web.me()).toBe(users[MAX_DEVICE_ACCOUNTS - 1]!.id);

    // A sign-in without "Add account" (another tab's login page) makes room: the oldest leaves.
    expect((await web.login(extra)).status).toBe(200);
    expect(ids(await web.accounts())).toEqual(users.slice(1).map((u) => u.id));
  });

  it('signing in again to an account already here replaces its old session', async () => {
    const [a, b] = [await signUp(t.app), await signUp(t.app)];
    const web = browser();
    await web.login(a);
    const first = web.jar.get(SESSION_COOKIE)!.value;
    await web.add(b);
    await web.add(a);
    expect(ids(await web.accounts())).toEqual([b.id, a.id]);
    expect(await web.me()).toBe(a.id);
    const old = await db().query(`SELECT revoked_at FROM sessions WHERE token_hash = $1`, [hashToken(first)]);
    expect(old.rows[0].revoked_at).not.toBeNull();
  });

  it('logs out of one account: another one stays in use, or takes over when it was the one in use', async () => {
    const [a, b, c] = [await signUp(t.app), await signUp(t.app), await signUp(t.app)];
    const web = browser();
    await web.login(a);
    await web.add(b);
    await web.add(c);
    const sessionOf = async (u: TestUser) =>
      (await db().query(`SELECT revoked_at FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [u.id])).rows[0].revoked_at;

    // One that isn't in use: its session ends, c stays in use.
    let r = await web.post('/v1/auth/accounts/logout', { userId: b.id });
    expect(r.status).toBe(200);
    expect(r.body.current.id).toBe(c.id);
    expect(await sessionOf(b)).not.toBeNull();
    expect(ids(await web.accounts())).toEqual([a.id, c.id]);
    expect(await web.me()).toBe(c.id);

    // The one in use: the next one takes over.
    r = await web.post('/v1/auth/accounts/logout', { userId: c.id });
    expect(r.body.current.id).toBe(a.id);
    expect(await web.me()).toBe(a.id);
    expect(ids(await web.accounts())).toEqual([a.id]);

    // The last one: signed out.
    r = await web.post('/v1/auth/accounts/logout', { userId: a.id });
    expect(r.body.current).toBeNull();
    expect((await web.get('/v1/auth/me')).status).toBe(401);
    expect((await web.accounts()).items).toEqual([]);
    expect(web.jar.has(SESSION_COOKIE)).toBe(false);
    expect(web.jar.has(ACCOUNTS_COOKIE)).toBe(false);
  });

  it('Log out leaves the other accounts to switch to, even signed out', async () => {
    const [a, b] = [await signUp(t.app), await signUp(t.app)];
    const web = browser();
    await web.login(a);
    await web.add(b);
    expect((await web.post('/v1/auth/logout')).status).toBe(200);
    expect((await web.get('/v1/auth/me')).status).toBe(401);
    const list = await web.accounts();
    expect(list.items.map((x) => [x.id, x.current])).toEqual([[a.id, false]]);
    expect((await web.post('/v1/auth/accounts/switch', { userId: a.id })).status).toBe(200);
    expect(await web.me()).toBe(a.id);
  });

  it('logs out of every account at once', async () => {
    const [a, b] = [await signUp(t.app), await signUp(t.app)];
    const web = browser();
    await web.login(a);
    await web.add(b);
    const tokens = web.tokens();
    const r = await web.post('/v1/auth/accounts/logout-all');
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(2);
    expect(web.jar.size).toBe(0);
    const live = await db().query(`SELECT 1 FROM sessions WHERE token_hash = ANY($1) AND revoked_at IS NULL`, [tokens.map(hashToken)]);
    expect(live.rowCount).toBe(0);
    // Their sessions elsewhere (here, the ones made at sign-up) are not this browser's: they stay.
    expect((await as(t.app, a).get('/v1/auth/me')).status).toBe(200);
    expect((await web.get('/v1/auth/me')).status).toBe(401);
  });
});

describe('what can be switched to', () => {
  it('only live sessions: a password change, an ended session or a closed account leave the list', async () => {
    const [a, b, c, d] = [await signUp(t.app), await signUp(t.app), await signUp(t.app), await signUp(t.app)];
    const web = browser();
    for (const u of [a, b, c]) await web.add(u);
    await web.add(d);
    expect(ids(await web.accounts())).toEqual([a.id, b.id, c.id, d.id]);

    // a changes their password on another device: this browser's session for a ends.
    expect((await as(t.app, a).post('/v1/auth/password/change', { currentPassword: a.password, newPassword: 'another-horse-battery' })).status).toBe(200);
    // b ends this browser's session from Settings > Security on another device.
    const bs = await as(t.app, b).get('/v1/auth/sessions');
    const browserSession = bs.body.items.find((s: { current: boolean }) => !s.current);
    expect((await as(t.app, b).del(`/v1/auth/sessions/${browserSession.id}`)).status).toBe(200);
    // c's account is closed.
    await db().query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [c.id]);

    const tokensBefore = web.tokens().length;
    expect(ids(await web.accounts())).toEqual([d.id]);
    // The cookie is written again without them.
    expect(web.tokens().length).toBeLessThan(tokensBefore);
    for (const gone of [a, b, c]) {
      const r = await web.post('/v1/auth/accounts/switch', { userId: gone.id });
      expect(r.status).toBe(404);
    }
    expect(await web.me()).toBe(d.id);
  });

  it('another browser’s account can’t be switched to, and made-up cookie entries are ignored', async () => {
    const [a, b] = [await signUp(t.app), await signUp(t.app)];
    const first = browser();
    await first.login(a);
    const second = browser();
    await second.login(b);
    expect((await second.post('/v1/auth/accounts/switch', { userId: a.id })).status).toBe(404);
    expect((await second.post('/v1/auth/accounts/logout', { userId: a.id })).status).toBe(404);
    expect(await second.me()).toBe(b.id);
    // Something that isn't a session token, an API-key-shaped value, and a token that never existed.
    second.jar.set(ACCOUNTS_COOKIE, { value: `nope.ypl_0123abcd_${'x'.repeat(30)}.${'A'.repeat(43)}` });
    expect(ids(await second.accounts())).toEqual([b.id]);
    // a's session is untouched by all this.
    expect(await first.me()).toBe(a.id);
    // Malformed requests are refused.
    expect((await second.post('/v1/auth/accounts/switch', { userId: 'me' })).status).toBe(400);
  });

  it('a page on another origin can’t switch, even signed out', async () => {
    const [a, b] = [await signUp(t.app), await signUp(t.app)];
    const web = browser();
    await web.login(a);
    await web.add(b);
    await web.post('/v1/auth/logout');
    expect(web.jar.has(SESSION_COOKIE)).toBe(false);
    const r = await web.post('/v1/auth/accounts/switch', { userId: a.id }, { origin: 'http://localhost:3999' });
    expect(r.status).toBe(403);
    expect((await web.get('/v1/auth/me')).status).toBe(401);
  });

  it('the phone app keeps its accounts itself: its sign-ins don’t touch the browser list', async () => {
    const [a, b] = [await signUp(t.app), await signUp(t.app)];
    const phone = browser({ 'x-client-platform': 'ios' });
    await phone.login(a);
    await phone.add(b);
    expect(phone.jar.has(ACCOUNTS_COOKIE)).toBe(false);
    // Signing in to b didn't end a's session (the phone keeps it in the keychain).
    const live = await db().query(`SELECT 1 FROM sessions WHERE user_id = $1 AND revoked_at IS NULL`, [a.id]);
    expect(live.rowCount).toBeGreaterThanOrEqual(1);
  });
});
