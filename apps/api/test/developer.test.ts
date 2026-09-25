import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decrypt, verifyWebhookSignature } from '@yapilapi/security';
import {
  Client,
  createTestApp,
  makeStaff,
  signup,
  uniq,
  type TestApp,
  type TestUser,
} from './helpers.js';
import {
  deliverWebhooks,
  MAX_ATTEMPTS,
  pkceChallengeFromVerifier,
  setWebhookNetwork,
  webhookAad,
} from '../src/modules/developer/index.js';
import type { OutboundRequest, ResolvedAddress } from '../src/modules/developer/ssrf.js';

let t: TestApp;
let dnsTable: Record<string, string[]> = {};
let sent: OutboundRequest[] = [];
let respond: (req: OutboundRequest) => number | Promise<number> = () => 200;

beforeAll(async () => {
  t = await createTestApp();
  setWebhookNetwork({
    lookup: async (host): Promise<ResolvedAddress[]> => {
      const a = dnsTable[host];
      if (!a) throw new Error('ENOTFOUND');
      return a.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    },
    transport: async (req) => {
      sent.push(req);
      return { status: await respond(req) };
    },
  });
});
afterAll(async () => {
  setWebhookNetwork();
  await t.close();
});
beforeEach(async () => {
  dnsTable = { 'hooks.example.test': ['93.184.216.34'] };
  sent = [];
  respond = () => 200;
  // The delivery queue is global: start every test with nothing pending from earlier tests.
  await t.ctx.db.query(
    `UPDATE webhook_deliveries SET status = 'failed' WHERE status IN ('pending','delivering')`,
  );
});

const sql = <R extends Record<string, any> = any>(text: string, params: unknown[] = []) =>
  t.ctx.db.query<R>(text, params);
/** JS clocks have ms precision, Postgres has us: a row queued in the same millisecond would look not-yet-due. */
const soon = () => new Date(Date.now() + 25);
const teenUser = () => signup(t, { birthDate: `${new Date().getUTCFullYear() - 15}-02-02` });
const REDIRECT = 'https://client.example.test/callback';
const bearer = (token: string) => {
  const c = new Client(t, 'bearer');
  c.token = token;
  return c;
};
const anon = () => new Client(t, 'bearer');

const mkApp = async (dev: TestUser, extra: Record<string, unknown> = {}) => {
  const r = await dev.client.post('/v1/developer/apps', {
    name: `App ${uniq('a')}`,
    redirectUris: [REDIRECT],
    ...extra,
  });
  if (r.status !== 201) throw new Error(`app failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as { id: string; clientId: string; clientSecret: string | null };
};
const verifierOf = (n = 'a') => n.repeat(64);
const authorize = (u: TestUser, app: { clientId: string }, o: Record<string, unknown> = {}) =>
  u.client.post('/v1/oauth/authorize', {
    response_type: 'code',
    client_id: app.clientId,
    redirect_uri: REDIRECT,
    scope: 'profile:read posts:read',
    state: 'st-123',
    code_challenge: pkceChallengeFromVerifier(verifierOf()),
    code_challenge_method: 'S256',
    approve: true,
    ...o,
  });
const codeFrom = (res: any) => new URL(res.body.redirectTo).searchParams.get('code')!;
const exchange = (
  app: { clientId: string; clientSecret?: string | null },
  code: string,
  o: Record<string, unknown> = {},
) =>
  anon().request('POST', '/v1/oauth/token', {
    body: {
      grant_type: 'authorization_code',
      client_id: app.clientId,
      ...(app.clientSecret ? { client_secret: app.clientSecret } : {}),
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifierOf(),
      ...o,
    },
  });
/** Full happy path: returns tokens for `user` against `app`. */
const connect = async (
  user: TestUser,
  app: { clientId: string; clientSecret?: string | null },
  scope = 'profile:read posts:read',
) => {
  const a = await authorize(user, app, { scope });
  expect(a.status).toBe(200);
  const tok = await exchange(app, codeFrom(a));
  expect(tok.status).toBe(200);
  return tok.body as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope: string;
  };
};
const post = async (u: TestUser, body: string, extra: Record<string, unknown> = {}) => {
  const r = await u.client.post('/v1/posts', { body, visibility: 'public', ...extra });
  if (r.status !== 201) throw new Error(`post failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id as string;
};

// ====================================================================== apps and keys
describe('developer apps', () => {
  it('requires auth, is adults-only and validates input', async () => {
    expect((await new Client(t).post('/v1/developer/apps', { name: 'Nope' })).status).toBe(401);
    const teen = await teenUser();
    expect((await teen.client.post('/v1/developer/apps', { name: 'Teen app' })).status).toBe(403);
    const dev = await signup(t);
    expect((await dev.client.post('/v1/developer/apps', { name: 'x' })).status).toBe(400);
    for (const bad of [
      'http://example.com/cb',
      'https://*.example.com/cb',
      'javascript:alert(1)',
      'https://example.com/cb#frag',
    ]) {
      expect(
        (await dev.client.post('/v1/developer/apps', { name: 'Valid name', redirectUris: [bad] }))
          .status,
        bad,
      ).toBe(400);
    }
    expect(
      (
        await dev.client.post('/v1/developer/apps', {
          name: 'Dev loop',
          redirectUris: ['http://localhost:5173/cb'],
        })
      ).status,
    ).toBe(201);
  });

  it('returns the client secret exactly once and stores only a hash', async () => {
    const dev = await signup(t);
    const app = await mkApp(dev);
    expect(app.clientSecret).toMatch(/^ylcs_/);
    const row = (await sql('SELECT client_secret_hash FROM developer_apps WHERE id = $1', [app.id]))
      .rows[0];
    expect(row.client_secret_hash).toHaveLength(64);
    expect(JSON.stringify(row)).not.toContain(app.clientSecret!);
    const got = await dev.client.get(`/v1/developer/apps/${app.id}`);
    expect(got.body.clientSecret).toBeUndefined();
    expect(JSON.stringify((await dev.client.get('/v1/developer/apps')).body)).not.toContain(
      app.clientSecret!,
    );
    const pub = await mkApp(dev, { confidential: false });
    expect(pub.clientSecret).toBeNull();
  });

  it('is private to the owner (404 for others) and can be updated, rotated and deleted', async () => {
    const dev = await signup(t);
    const other = await signup(t);
    const app = await mkApp(dev);
    for (const [m, url] of [
      ['get', `/v1/developer/apps/${app.id}`],
      ['get', `/v1/developer/apps/${app.id}/keys`],
      ['get', `/v1/developer/apps/${app.id}/webhooks`],
      ['post', `/v1/developer/apps/${app.id}/rotate-secret`],
      ['del', `/v1/developer/apps/${app.id}`],
    ] as const) {
      expect((await (other.client as any)[m](url)).status, `${m} ${url}`).toBe(404);
    }
    expect(
      (await other.client.patch(`/v1/developer/apps/${app.id}`, { name: 'Hijack' })).status,
    ).toBe(404);
    expect(
      (
        await dev.client.patch(`/v1/developer/apps/${app.id}`, {
          name: 'Renamed app',
          description: 'Hello',
        })
      ).body,
    ).toMatchObject({ name: 'Renamed app', description: 'Hello' });

    const rot = await dev.client.post(`/v1/developer/apps/${app.id}/rotate-secret`);
    expect(rot.status).toBe(200);
    expect(rot.body.clientSecret).not.toBe(app.clientSecret);
    // the old secret stops working immediately
    const a = await authorize(dev, app);
    expect((await exchange(app, codeFrom(a))).status).toBe(401);
    const b = await authorize(dev, app);
    expect(
      (await exchange({ clientId: app.clientId, clientSecret: rot.body.clientSecret }, codeFrom(b)))
        .status,
    ).toBe(200);

    expect((await dev.client.del(`/v1/developer/apps/${app.id}`)).status).toBe(204);
    expect((await dev.client.get(`/v1/developer/apps/${app.id}`)).status).toBe(404);
  });
});

describe('API keys and the public API', () => {
  it('creates a key once, hashes it, and authenticates public reads', async () => {
    const dev = await signup(t);
    const author = await signup(t, { displayName: 'Public Person' });
    const app = await mkApp(dev);
    const k = await dev.client.post(`/v1/developer/apps/${app.id}/keys`, {
      name: 'server',
      expiresInDays: 30,
    });
    expect(k.status).toBe(201);
    expect(k.body.key).toMatch(/^ylk_/);
    const row = (await sql('SELECT key_hash, key_prefix FROM api_keys WHERE id = $1', [k.body.id]))
      .rows[0];
    expect(row.key_hash).toHaveLength(64);
    expect(k.body.key.startsWith(row.key_prefix)).toBe(true);
    const list = await dev.client.get(`/v1/developer/apps/${app.id}/keys`);
    expect(list.body.items[0].key).toBeUndefined();
    expect(JSON.stringify(list.body)).not.toContain(k.body.key);

    const api = bearer(k.body.key);
    await post(author, `A public post ${uniq('p')}`);
    await post(author, `Followers only ${uniq('f')}`, { visibility: 'followers' });
    const prof = await api.get(`/v1/public/users/${author.username}`);
    expect(prof.status).toBe(200);
    expect(prof.body).toMatchObject({ username: author.username, displayName: 'Public Person' });
    expect(prof.body.email).toBeUndefined();
    expect(prof.headers['x-ratelimit-limit']).toBe('120');
    const posts = await api.get(`/v1/public/users/${author.username}/posts`);
    expect(posts.body.items).toHaveLength(1);
    expect(posts.body.items[0].body).toContain('A public post');
    expect((await api.get('/v1/public/me')).status).toBe(403); // keys are not user tokens
    expect(
      (await sql('SELECT last_used_at FROM api_keys WHERE id = $1', [k.body.id])).rows[0]
        .last_used_at,
    ).not.toBeNull();
  });

  it('rejects missing, malformed, revoked, expired and cookie credentials', async () => {
    const dev = await signup(t);
    const author = await signup(t);
    const app = await mkApp(dev);
    const k = (await dev.client.post(`/v1/developer/apps/${app.id}/keys`, {})).body;
    const url = `/v1/public/users/${author.username}`;
    expect((await anon().get(url)).status).toBe(401);
    expect((await bearer('ylk_nonsense').get(url)).status).toBe(401);
    expect((await bearer('random-token').get(url)).status).toBe(401);
    // a browser session is not an API credential
    expect((await author.client.get(url)).status).toBe(401);
    // session bearer tokens are not API keys either
    const s = await signup(t, { mode: 'bearer' });
    expect((await s.client.get(url)).status).toBe(401);
    expect((await bearer(k.key).get(url)).status).toBe(200);
    expect((await dev.client.del(`/v1/developer/apps/${app.id}/keys/${k.id}`)).status).toBe(204);
    expect((await bearer(k.key).get(url)).status).toBe(401);
    const k2 = (await dev.client.post(`/v1/developer/apps/${app.id}/keys`, { expiresInDays: 1 }))
      .body;
    await sql(`UPDATE api_keys SET expires_at = now() - interval '1 minute' WHERE id = $1`, [
      k2.id,
    ]);
    expect((await bearer(k2.key).get(url)).status).toBe(401);
  });

  it("a suspended app's keys stop working", async () => {
    const dev = await signup(t);
    const author = await signup(t);
    const app = await mkApp(dev);
    const k = (await dev.client.post(`/v1/developer/apps/${app.id}/keys`, {})).body;
    await sql(`UPDATE developer_apps SET status = 'suspended' WHERE id = $1`, [app.id]);
    expect((await bearer(k.key).get(`/v1/public/users/${author.username}`)).status).toBe(401);
  });

  it('enforces a per-key rate limit and caps active keys', async () => {
    const dev = await signup(t);
    const author = await signup(t);
    const app = await mkApp(dev);
    const k = (await dev.client.post(`/v1/developer/apps/${app.id}/keys`, { rateLimitPerMin: 2 }))
      .body;
    const api = bearer(k.key);
    const url = `/v1/public/users/${author.username}`;
    expect((await api.get(url)).status).toBe(200);
    expect((await api.get(url)).status).toBe(200);
    const limited = await api.get(url);
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    for (let i = 0; i < 4; i++)
      expect((await dev.client.post(`/v1/developer/apps/${app.id}/keys`, {})).status).toBe(201);
    expect((await dev.client.post(`/v1/developer/apps/${app.id}/keys`, {})).status).toBe(409);
  });

  it('never exposes teen, private, suspended or blocked-from-view accounts', async () => {
    const dev = await signup(t);
    const app = await mkApp(dev);
    const key = bearer((await dev.client.post(`/v1/developer/apps/${app.id}/keys`, {})).body.key);
    const teen = await teenUser();
    const priv = await signup(t);
    await priv.client.patch('/v1/profile', { isPrivate: true }).catch(() => undefined);
    await sql('UPDATE profiles SET is_private = true WHERE user_id = $1', [priv.id]);
    const gone = await signup(t);
    await sql(`UPDATE users SET status = 'suspended' WHERE id = $1`, [gone.id]);
    for (const u of [teen, priv, gone]) {
      expect((await key.get(`/v1/public/users/${u.username}`)).status).toBe(404);
      expect((await key.get(`/v1/public/users/${u.username}/posts`)).status).toBe(404);
    }
    expect((await key.get('/v1/public/users/nobody_like_this')).status).toBe(404);
  });

  it('hides moderated posts', async () => {
    const dev = await signup(t);
    const author = await signup(t);
    const app = await mkApp(dev);
    const key = bearer((await dev.client.post(`/v1/developer/apps/${app.id}/keys`, {})).body.key);
    const p1 = await post(author, `Keep me ${uniq('k')}`);
    const p2 = await post(author, `Remove me ${uniq('r')}`);
    await sql(`UPDATE posts SET moderation_status = 'removed' WHERE id = $1`, [p2]);
    const ids = (await key.get(`/v1/public/users/${author.username}/posts`)).body.items.map(
      (x: any) => x.id,
    );
    expect(ids).toEqual([p1]);
  });
});

// ====================================================================== OAuth 2 + PKCE
describe('OAuth authorization code flow with PKCE', () => {
  it('happy path for a public client: consent info, code, token, API call, refresh rotation', async () => {
    const dev = await signup(t);
    const user = await signup(t, { displayName: 'Grantor' });
    const app = await mkApp(dev, {
      confidential: false,
      name: 'Cool Client',
      description: 'Does cool things',
    });
    const info = await user.client.get('/v1/oauth/authorize', {
      response_type: 'code',
      client_id: app.clientId,
      redirect_uri: REDIRECT,
      scope: 'profile:read',
      code_challenge: pkceChallengeFromVerifier(verifierOf()),
      code_challenge_method: 'S256',
    });
    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({
      app: { name: 'Cool Client' },
      scopes: [{ scope: 'profile:read' }],
      alreadyAuthorized: false,
    });

    const a = await authorize(user, app, { scope: 'profile:read posts:read' });
    expect(a.status).toBe(200);
    const back = new URL(a.body.redirectTo);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get('state')).toBe('st-123');
    const tok = await exchange(app, codeFrom(a));
    expect(tok.status).toBe(200);
    expect(tok.headers['cache-control']).toBe('no-store');
    expect(tok.body).toMatchObject({
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'profile:read posts:read',
    });
    expect(tok.body.access_token).toMatch(/^ylat_/);
    expect(tok.body.refresh_token).toMatch(/^ylrt_/);

    const stored = (await sql('SELECT access_hash, refresh_hash FROM oauth_tokens')).rows
      .map((r) => `${r.access_hash}${r.refresh_hash}`)
      .join('');
    expect(stored).not.toContain(tok.body.access_token);
    expect(stored).not.toContain(tok.body.refresh_token);

    const me = await bearer(tok.body.access_token).get('/v1/public/me');
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ id: user.id, username: user.username, displayName: 'Grantor' });
    expect(me.body.email).toBeUndefined();

    // refresh rotates: the new pair works, the old access token and refresh token do not
    const r1 = await anon().request('POST', '/v1/oauth/token', {
      body: {
        grant_type: 'refresh_token',
        client_id: app.clientId,
        refresh_token: tok.body.refresh_token,
      },
    });
    expect(r1.status).toBe(200);
    expect(r1.body.access_token).not.toBe(tok.body.access_token);
    expect((await bearer(tok.body.access_token).get('/v1/public/me')).status).toBe(401);
    expect((await bearer(r1.body.access_token).get('/v1/public/me')).status).toBe(200);
  });

  it('happy path for a confidential client (secret required) using form encoding and HTTP Basic', async () => {
    const dev = await signup(t);
    const user = await signup(t);
    const app = await mkApp(dev);
    const a = await authorize(user, app);
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: codeFrom(a),
      redirect_uri: REDIRECT,
      code_verifier: verifierOf(),
    }).toString();
    const basic = Buffer.from(
      `${encodeURIComponent(app.clientId)}:${encodeURIComponent(app.clientSecret!)}`,
    ).toString('base64');
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/oauth/token',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${basic}`,
      },
      payload: form,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).access_token).toMatch(/^ylat_/);
  });

  it('refuses invalid authorization requests without redirecting', async () => {
    const dev = await signup(t);
    const user = await signup(t);
    const app = await mkApp(dev);
    expect((await authorize(user, { clientId: 'yl_unknown' })).status).toBe(400);
    expect(
      (await authorize(user, app, { redirect_uri: 'https://evil.example.test/cb' })).status,
    ).toBe(400);
    expect((await authorize(user, app, { redirect_uri: `${REDIRECT}/extra` })).status).toBe(400); // exact match only
    expect((await authorize(user, app, { scope: 'profile:read admin' })).status).toBe(400);
    expect((await authorize(user, app, { scope: '' })).status).toBe(400);
    expect((await authorize(user, app, { code_challenge_method: 'plain' })).status).toBe(400); // PKCE S256 only
    expect((await authorize(user, app, { code_challenge: 'short' })).status).toBe(400);
    expect((await authorize(user, app, { code_challenge: undefined })).status).toBe(400); // PKCE is mandatory
    expect((await authorize(user, app, { response_type: 'token' })).status).toBe(400); // no implicit flow
    expect(
      (
        await sql('SELECT count(*)::int AS n FROM oauth_authorization_codes WHERE app_id = $1', [
          app.id,
        ])
      ).rows[0].n,
    ).toBe(0);
    expect((await new Client(t).post('/v1/oauth/authorize', {})).status).toBe(401);
  });

  it('the user can deny, and teens cannot connect third-party apps', async () => {
    const dev = await signup(t);
    const user = await signup(t);
    const app = await mkApp(dev);
    const denied = await authorize(user, app, { approve: false });
    const u = new URL(denied.body.redirectTo);
    expect(u.searchParams.get('error')).toBe('access_denied');
    expect(u.searchParams.get('code')).toBeNull();
    expect(u.searchParams.get('state')).toBe('st-123');
    const teen = await teenUser();
    expect((await authorize(teen, app)).status).toBe(403);
    expect(
      (
        await teen.client.get('/v1/oauth/authorize', {
          response_type: 'code',
          client_id: app.clientId,
          redirect_uri: REDIRECT,
          scope: 'profile:read',
          code_challenge: pkceChallengeFromVerifier(verifierOf()),
          code_challenge_method: 'S256',
        })
      ).status,
    ).toBe(403);
  });

  it('fails the token exchange for a wrong verifier, wrong redirect, wrong client, wrong secret and unknown code', async () => {
    const dev = await signup(t);
    const other = await signup(t);
    const user = await signup(t);
    const app = await mkApp(dev);
    const otherApp = await mkApp(other);

    const mk = async () => codeFrom(await authorize(user, app));
    const bad = await exchange(app, await mk(), { code_verifier: verifierOf('b') });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: 'invalid_grant' });
    // a failed PKCE attempt burns the code: the attacker cannot retry with a guessed verifier
    const burned = await mk();
    expect((await exchange(app, burned, { code_verifier: verifierOf('c') })).status).toBe(400);
    expect((await exchange(app, burned)).status).toBe(400);

    expect(
      (await exchange(app, await mk(), { redirect_uri: 'https://evil.example.test/cb' })).body,
    ).toMatchObject({ error: 'invalid_grant' });
    expect((await exchange(app, await mk(), { code_verifier: 'too-short' })).status).toBe(400);
    expect((await exchange(app, await mk(), { code_verifier: undefined })).body).toMatchObject({
      error: 'invalid_request',
    });
    // code issued to another client
    const foreign = await mk();
    expect((await exchange(otherApp, foreign)).body).toMatchObject({ error: 'invalid_grant' });
    // secret problems
    const wrongSecret = await exchange(
      { clientId: app.clientId, clientSecret: 'ylcs_wrong' },
      await mk(),
    );
    expect(wrongSecret.status).toBe(401);
    expect(wrongSecret.body).toMatchObject({ error: 'invalid_client' });
    expect((await exchange({ clientId: app.clientId }, await mk())).status).toBe(401);
    expect((await exchange({ clientId: 'yl_unknown', clientSecret: 'x' }, await mk())).status).toBe(
      401,
    );
    expect((await exchange(app, 'not-a-real-code')).body).toMatchObject({ error: 'invalid_grant' });
    expect(
      (
        await anon().request('POST', '/v1/oauth/token', {
          body: {
            grant_type: 'password',
            client_id: app.clientId,
            client_secret: app.clientSecret,
          },
        })
      ).body,
    ).toMatchObject({ error: 'unsupported_grant_type' });
    // and after all that no tokens were ever minted
    expect(
      (
        await sql(
          'SELECT count(*)::int AS n FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id WHERE g.app_id = $1',
          [app.id],
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it('expired codes are rejected', async () => {
    const dev = await signup(t);
    const user = await signup(t);
    const app = await mkApp(dev);
    const code = codeFrom(await authorize(user, app));
    await sql(`UPDATE oauth_authorization_codes SET expires_at = now() - interval '1 second'`);
    expect((await exchange(app, code)).body).toMatchObject({ error: 'invalid_grant' });
  });

  it('a replayed code revokes the tokens it produced', async () => {
    const dev = await signup(t);
    const user = await signup(t);
    const app = await mkApp(dev);
    const code = codeFrom(await authorize(user, app));
    const first = await exchange(app, code);
    expect(first.status).toBe(200);
    expect((await bearer(first.body.access_token).get('/v1/public/me')).status).toBe(200);
    expect((await exchange(app, code)).status).toBe(400);
    expect((await bearer(first.body.access_token).get('/v1/public/me')).status).toBe(401);
    expect(
      (
        await sql(
          `SELECT count(*)::int AS n FROM audit_logs WHERE action = 'oauth.code_replay' AND target_id = $1`,
          [app.id],
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it('concurrent exchanges of one code produce exactly one token pair', async () => {
    const dev = await signup(t);
    const user = await signup(t);
    const app = await mkApp(dev);
    const code = codeFrom(await authorize(user, app));
    const results = await Promise.all([
      exchange(app, code),
      exchange(app, code),
      exchange(app, code),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });

  it('refresh token reuse is a theft signal: the whole grant is revoked', async () => {
    const dev = await signup(t);
    const user = await signup(t);
    const app = await mkApp(dev, { confidential: false });
    const tok = await connect(user, app);
    const refresh = (rt: string, extra: Record<string, unknown> = {}) =>
      anon().request('POST', '/v1/oauth/token', {
        body: { grant_type: 'refresh_token', client_id: app.clientId, refresh_token: rt, ...extra },
      });
    const r1 = await refresh(tok.refresh_token);
    expect(r1.status).toBe(200);
    const replay = await refresh(tok.refresh_token);
    expect(replay.status).toBe(400);
    expect(replay.body).toMatchObject({ error: 'invalid_grant' });
    // the legitimate holder's newest tokens are dead too
    expect((await bearer(r1.body.access_token).get('/v1/public/me')).status).toBe(401);
    expect((await refresh(r1.body.refresh_token)).status).toBe(400);
  });

  it('refresh can narrow but never widen scope; other clients cannot use the token', async () => {
    const dev = await signup(t);
    const other = await signup(t);
    const user = await signup(t);
    const app = await mkApp(dev, { confidential: false });
    const otherApp = await mkApp(other, { confidential: false });
    const tok = await connect(user, app, 'profile:read');
    const post1 = (b: Record<string, unknown>) =>
      anon().request('POST', '/v1/oauth/token', {
        body: {
          grant_type: 'refresh_token',
          client_id: app.clientId,
          refresh_token: tok.refresh_token,
          ...b,
        },
      });
    expect((await post1({ scope: 'profile:read posts:read' })).body).toMatchObject({
      error: 'invalid_scope',
    });
    const stolen = await anon().request('POST', '/v1/oauth/token', {
      body: {
        grant_type: 'refresh_token',
        client_id: otherApp.clientId,
        refresh_token: tok.refresh_token,
      },
    });
    expect(stolen.status).toBe(400);
    expect((await post1({ scope: 'profile:read' })).status).toBe(200);
  });

  it('scopes gate the API: profile:read only cannot read posts', async () => {
    const dev = await signup(t);
    const user = await signup(t);
    const app = await mkApp(dev);
    await post(user, `Mine ${uniq('m')}`);
    await post(user, `Followers ${uniq('f')}`, { visibility: 'followers' });
    const narrow = await connect(user, app, 'profile:read');
    expect((await bearer(narrow.access_token).get('/v1/public/me')).status).toBe(200);
    expect((await bearer(narrow.access_token).get('/v1/public/me/posts')).status).toBe(403);
    const wide = await connect(user, app, 'profile:read posts:read');
    const posts = await bearer(wide.access_token).get('/v1/public/me/posts');
    expect(posts.status).toBe(200);
    expect(posts.body.items).toHaveLength(1); // only the public one, never followers-only
    // re-authorising replaced the earlier tokens
    expect((await bearer(narrow.access_token).get('/v1/public/me')).status).toBe(401);
    expect(
      (await sql('SELECT count(*)::int AS n FROM oauth_grants WHERE user_id = $1', [user.id]))
        .rows[0].n,
    ).toBe(1);
  });

  it('access tokens expire, and revocation endpoints work', async () => {
    const dev = await signup(t);
    const user = await signup(t);
    const app = await mkApp(dev, { confidential: false });
    const tok = await connect(user, app);
    await sql(`UPDATE oauth_tokens SET access_expires_at = now() - interval '1 second'`);
    expect((await bearer(tok.access_token).get('/v1/public/me')).status).toBe(401);
    const tok2 = await connect(user, app);
    expect((await bearer(tok2.access_token).get('/v1/public/me')).status).toBe(200);
    // RFC 7009: always 200, even for garbage
    expect(
      (
        await anon().request('POST', '/v1/oauth/revoke', {
          body: { token: 'garbage', client_id: app.clientId },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await anon().request('POST', '/v1/oauth/revoke', {
          body: { token: tok2.access_token, client_id: app.clientId },
        })
      ).status,
    ).toBe(200);
    expect((await bearer(tok2.access_token).get('/v1/public/me')).status).toBe(401);
    // another client cannot revoke this client's tokens
    const tok3 = await connect(user, app);
    const otherDev = await signup(t);
    const otherApp = await mkApp(otherDev, { confidential: false });
    await anon().request('POST', '/v1/oauth/revoke', {
      body: { token: tok3.access_token, client_id: otherApp.clientId },
    });
    expect((await bearer(tok3.access_token).get('/v1/public/me')).status).toBe(200);
  });

  it('suspended users and suspended apps lose API access', async () => {
    const dev = await signup(t);
    const user = await signup(t);
    const app = await mkApp(dev, { confidential: false });
    const tok = await connect(user, app);
    await sql(`UPDATE developer_apps SET status = 'suspended' WHERE id = $1`, [app.id]);
    expect((await bearer(tok.access_token).get('/v1/public/me')).status).toBe(401);
    await sql(`UPDATE developer_apps SET status = 'active' WHERE id = $1`, [app.id]);
    expect((await bearer(tok.access_token).get('/v1/public/me')).status).toBe(200);
    await sql(`UPDATE users SET status = 'suspended' WHERE id = $1`, [user.id]);
    expect((await bearer(tok.access_token).get('/v1/public/me')).status).toBe(401);
  });

  it('the scopes listing is public', async () => {
    const r = await anon().get('/v1/oauth/scopes');
    expect(r.body.items.map((s: any) => s.scope)).toEqual(['profile:read', 'posts:read']);
  });
});

// ====================================================================== webhooks
describe('webhook registration (SSRF blocklist)', () => {
  const register = (dev: TestUser, appId: string, url: string, events: string[] = ['ping']) =>
    dev.client.post(`/v1/developer/apps/${appId}/webhooks`, { url, events });

  it('rejects unsafe destinations', async () => {
    const dev = await signup(t);
    const app = await mkApp(dev);
    dnsTable['rebind.example.test'] = ['93.184.216.34', '10.0.0.7'];
    dnsTable['internal.example.test'] = ['127.0.0.1'];
    dnsTable['meta.example.test'] = ['169.254.169.254'];
    dnsTable['v6.example.test'] = ['::1'];
    dnsTable['mapped.example.test'] = ['::ffff:192.168.1.1'];
    const unsafe = [
      'http://hooks.example.test/x',
      'https://localhost/x',
      'https://127.0.0.1/x',
      'https://2130706433/x',
      'https://[::1]/x',
      'https://169.254.169.254/latest/meta-data/',
      'https://10.1.2.3/x',
      'https://192.168.0.1/x',
      'https://user:pw@hooks.example.test/x',
      'https://hooks.example.test:22/x',
      'https://foo.internal/x',
      'https://internal.example.test/x',
      'https://rebind.example.test/x',
      'https://meta.example.test/x',
      'https://v6.example.test/x',
      'https://mapped.example.test/x',
      'https://does-not-resolve.example.test/x',
      'file:///etc/passwd',
      'gopher://hooks.example.test/x',
    ];
    for (const url of unsafe) {
      const r = await register(dev, app.id, url);
      expect(r.status, url).toBe(400);
    }
    expect(
      (await sql('SELECT count(*)::int AS n FROM webhook_endpoints WHERE app_id = $1', [app.id]))
        .rows[0].n,
    ).toBe(0);
  });

  it('accepts a public https endpoint, shows the secret once and stores it encrypted', async () => {
    const dev = await signup(t);
    const app = await mkApp(dev);
    const r = await register(dev, app.id, 'https://hooks.example.test/yl', [
      'ping',
      'post.created',
    ]);
    expect(r.status).toBe(201);
    expect(r.body.secret).toMatch(/^whsec_/);
    const row = (await sql('SELECT secret_enc FROM webhook_endpoints WHERE id = $1', [r.body.id]))
      .rows[0];
    expect(row.secret_enc).not.toContain(r.body.secret);
    expect(decrypt(row.secret_enc, t.ctx.config.dataEncryptionKey, webhookAad(r.body.id))).toBe(
      r.body.secret,
    );
    const list = await dev.client.get(`/v1/developer/apps/${app.id}/webhooks`);
    expect(JSON.stringify(list.body)).not.toContain(r.body.secret);
    // events must be known; ownership enforced
    expect(
      (await register(dev, app.id, 'https://hooks.example.test/y2', ['user.exploded'])).status,
    ).toBe(400);
    const other = await signup(t);
    expect((await register(other, app.id, 'https://hooks.example.test/y3')).status).toBe(404);
    expect((await other.client.post(`/v1/developer/webhooks/${r.body.id}/test`)).status).toBe(404);
    expect((await other.client.del(`/v1/developer/webhooks/${r.body.id}`)).status).toBe(404);
    // updating the URL re-runs the SSRF checks
    expect(
      (
        await dev.client.patch(`/v1/developer/webhooks/${r.body.id}`, {
          url: 'https://127.0.0.1/x',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await dev.client.patch(`/v1/developer/webhooks/${r.body.id}`, {
          url: 'https://hooks.example.test/new',
        })
      ).status,
    ).toBe(200);
  });

  it('teens cannot register webhooks', async () => {
    const teen = await teenUser();
    const dev = await signup(t);
    const app = await mkApp(dev);
    expect((await register(teen, app.id, 'https://hooks.example.test/x')).status).toBe(403);
  });
});

describe('webhook delivery', () => {
  const setup = async (events = ['ping']) => {
    const dev = await signup(t);
    const app = await mkApp(dev, { confidential: false });
    const wh = (
      await dev.client.post(`/v1/developer/apps/${app.id}/webhooks`, {
        url: 'https://hooks.example.test/yl',
        events,
      })
    ).body;
    return { dev, app, wh };
  };
  const latest = async (endpointId: string) =>
    (
      await sql(
        'SELECT * FROM webhook_deliveries WHERE endpoint_id = $1 ORDER BY created_at DESC LIMIT 1',
        [endpointId],
      )
    ).rows[0];

  it('delivers a signed payload to the pinned, validated address', async () => {
    const { dev, wh } = await setup();
    expect((await dev.client.post(`/v1/developer/webhooks/${wh.id}/test`)).status).toBe(202);
    const res = await deliverWebhooks(t.ctx, { now: soon() });
    expect(res).toMatchObject({ attempted: 1, succeeded: 1 });
    expect(sent).toHaveLength(1);
    const req = sent[0]!;
    expect(req.address.address).toBe('93.184.216.34'); // connection pinned to the validated IP
    expect(req.url.hostname).toBe('hooks.example.test');
    expect(req.headers['x-yapilapi-event']).toBe('ping');
    expect(req.headers['content-type']).toBe('application/json');
    expect(
      verifyWebhookSignature({
        secret: wh.secret,
        header: req.headers['x-yapilapi-signature'],
        rawBody: req.body,
      }),
    ).toBe(true);
    expect(
      verifyWebhookSignature({
        secret: 'whsec_other',
        header: req.headers['x-yapilapi-signature'],
        rawBody: req.body,
      }),
    ).toBe(false);
    expect(
      verifyWebhookSignature({
        secret: wh.secret,
        header: req.headers['x-yapilapi-signature'],
        rawBody: `${req.body} `,
      }),
    ).toBe(false);
    expect(JSON.parse(req.body)).toMatchObject({
      type: 'ping',
      data: { message: 'Hello from YAPILAPI' },
    });
    const d = await latest(wh.id);
    expect(d).toMatchObject({ status: 'succeeded', attempts: 1, last_status_code: 200 });
    const hist = await dev.client.get(`/v1/developer/webhooks/${wh.id}/deliveries`);
    expect(hist.body.items[0]).toMatchObject({ status: 'succeeded', eventType: 'ping' });
    // nothing left to do
    expect((await deliverWebhooks(t.ctx, { now: soon() })).attempted).toBe(0);
  });

  it('retries with backoff on server errors and gives up after the maximum attempts', async () => {
    const { dev, wh } = await setup();
    respond = () => 503;
    await dev.client.post(`/v1/developer/webhooks/${wh.id}/test`);
    let now = soon();
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const r = await deliverWebhooks(t.ctx, { now });
      expect(r.attempted, `attempt ${attempt}`).toBe(1);
      const d = await latest(wh.id);
      expect(d.attempts).toBe(attempt);
      if (attempt < MAX_ATTEMPTS) {
        expect(d.status).toBe('pending');
        expect(new Date(d.next_attempt_at).getTime()).toBeGreaterThan(now.getTime());
        // not due yet: a run before next_attempt_at does nothing
        expect((await deliverWebhooks(t.ctx, { now })).attempted).toBe(0);
        now = new Date(new Date(d.next_attempt_at).getTime() + 1000);
      }
    }
    expect(await latest(wh.id)).toMatchObject({
      status: 'failed',
      attempts: MAX_ATTEMPTS,
      last_error: 'http_503',
    });
  });

  it('a 4xx response is permanent; a recovering endpoint resets the failure counter', async () => {
    const { dev, wh } = await setup();
    respond = () => 410;
    await dev.client.post(`/v1/developer/webhooks/${wh.id}/test`);
    await deliverWebhooks(t.ctx, { now: soon() });
    expect(await latest(wh.id)).toMatchObject({ status: 'failed', attempts: 1 });
    expect(
      (await sql('SELECT consecutive_failures FROM webhook_endpoints WHERE id = $1', [wh.id]))
        .rows[0].consecutive_failures,
    ).toBe(1);
    respond = () => 200;
    await dev.client.post(`/v1/developer/webhooks/${wh.id}/test`);
    await deliverWebhooks(t.ctx, { now: soon() });
    expect(
      (await sql('SELECT consecutive_failures FROM webhook_endpoints WHERE id = $1', [wh.id]))
        .rows[0].consecutive_failures,
    ).toBe(0);
  });

  it('never follows redirects', async () => {
    const { dev, wh } = await setup();
    respond = () => 302;
    await dev.client.post(`/v1/developer/webhooks/${wh.id}/test`);
    await deliverWebhooks(t.ctx, { now: soon() });
    expect(sent).toHaveLength(1);
    expect((await latest(wh.id)).last_error).toBe('redirect_not_followed');
  });

  it('re-checks DNS at delivery time: a host that later resolves to a private address is refused (DNS rebinding)', async () => {
    const { dev, wh } = await setup();
    await dev.client.post(`/v1/developer/webhooks/${wh.id}/test`);
    dnsTable['hooks.example.test'] = ['169.254.169.254'];
    const r = await deliverWebhooks(t.ctx, { now: soon() });
    expect(r).toMatchObject({ attempted: 1, failed: 1 });
    expect(sent).toHaveLength(0); // no connection was attempted
    expect((await latest(wh.id)).last_error).toBe('blocked_destination:blocked_address');
  });

  it('disables an endpoint after too many consecutive failures and tells the owner', async () => {
    const { dev, wh } = await setup();
    respond = () => 500;
    await sql('UPDATE webhook_endpoints SET consecutive_failures = 19 WHERE id = $1', [wh.id]);
    await dev.client.post(`/v1/developer/webhooks/${wh.id}/test`);
    await deliverWebhooks(t.ctx, { now: soon() });
    const ep = (
      await sql('SELECT active, disabled_reason FROM webhook_endpoints WHERE id = $1', [wh.id])
    ).rows[0];
    expect(ep).toMatchObject({ active: false, disabled_reason: 'too_many_failures' });
    expect((await dev.client.post(`/v1/developer/webhooks/${wh.id}/test`)).status).toBe(409);
    const notes = await dev.client.get('/v1/notifications');
    if (notes.status === 200)
      expect(notes.body.items.some((n: any) => n.kind === 'webhook_endpoint_disabled')).toBe(true);
    // fixing and re-enabling clears the state
    const re = await dev.client.patch(`/v1/developer/webhooks/${wh.id}`, { active: true });
    expect(re.body).toMatchObject({ active: true, disabledReason: null, consecutiveFailures: 0 });
  });

  it('post.created goes only to apps the author authorised with posts:read, for public posts', async () => {
    const dev = await signup(t);
    const author = await signup(t);
    const bystander = await signup(t);
    const app = await mkApp(dev, { confidential: false });
    const wh = (
      await dev.client.post(`/v1/developer/apps/${app.id}/webhooks`, {
        url: 'https://hooks.example.test/yl',
        events: ['post.created', 'authorization.revoked'],
      })
    ).body;

    await post(author, `Before connecting ${uniq('b')}`);
    await post(bystander, `Bystander ${uniq('y')}`);
    expect(
      (
        await sql('SELECT count(*)::int AS n FROM webhook_deliveries WHERE endpoint_id = $1', [
          wh.id,
        ])
      ).rows[0].n,
    ).toBe(0);

    await connect(author, app, 'profile:read'); // no posts:read
    await post(author, `No posts scope ${uniq('n')}`);
    expect(
      (
        await sql('SELECT count(*)::int AS n FROM webhook_deliveries WHERE endpoint_id = $1', [
          wh.id,
        ])
      ).rows[0].n,
    ).toBe(0);

    await connect(author, app, 'profile:read posts:read');
    const pub = await post(author, `Public after ${uniq('p')}`);
    await post(author, `Followers only ${uniq('f')}`, { visibility: 'followers' });
    await post(bystander, `Bystander again ${uniq('z')}`);
    const q = await sql(
      `SELECT payload FROM webhook_deliveries WHERE endpoint_id = $1 AND event_type = 'post.created'`,
      [wh.id],
    );
    expect(q.rowCount).toBe(1);
    expect(q.rows[0].payload.data).toMatchObject({ userId: author.id, postId: pub });
    expect(JSON.stringify(q.rows[0].payload)).not.toContain('Public after'); // ids only, no content

    // revoking access emits authorization.revoked and later posts stop flowing
    const grant = (await author.client.get('/v1/privacy/connected-apps')).body.items[0];
    await author.client.del(`/v1/privacy/connected-apps/${grant.id}`);
    await post(author, `After revoke ${uniq('r')}`);
    const types = (
      await sql(
        `SELECT event_type FROM webhook_deliveries WHERE endpoint_id = $1 ORDER BY created_at`,
        [wh.id],
      )
    ).rows.map((r) => r.event_type);
    expect(types).toEqual(['post.created', 'authorization.revoked']);
    await deliverWebhooks(t.ctx, { now: soon() });
    expect(sent.map((s) => s.headers['x-yapilapi-event']).sort()).toEqual([
      'authorization.revoked',
      'post.created',
    ]);
  });

  it('does not deliver for inactive endpoints or suspended apps', async () => {
    const { dev, app, wh } = await setup();
    await dev.client.post(`/v1/developer/webhooks/${wh.id}/test`);
    await sql(`UPDATE developer_apps SET status = 'suspended' WHERE id = $1`, [app.id]);
    const r = await deliverWebhooks(t.ctx, { now: soon() });
    expect(r.failed).toBe(1);
    expect(sent).toHaveLength(0);
  });
});

// ====================================================================== mini apps
describe('mini apps', () => {
  const manifest = {
    entryUrl: 'https://mini.example.test/app',
    permissions: ['profile.basic', 'posts.read_own'],
  };
  const setFlag = async (on: boolean) => {
    await sql(`UPDATE feature_flags SET enabled = $1, rollout_pct = $2 WHERE key = 'MINI_APPS'`, [
      on,
      on ? 100 : 0,
    ]);
    t.ctx.flags.invalidate();
  };
  const mk = async (dev: TestUser, appId: string, extra: Record<string, unknown> = {}) =>
    dev.client.post(`/v1/developer/apps/${appId}/mini-apps`, {
      slug: uniq('mini'),
      name: 'Mini One',
      manifest,
      ...extra,
    });

  it('is invisible while the MINI_APPS flag is off', async () => {
    await setFlag(false);
    const dev = await signup(t);
    const app = await mkApp(dev);
    expect((await mk(dev, app.id)).status).toBe(404);
    expect((await dev.client.get('/v1/mini-apps')).status).toBe(404);
    expect((await dev.client.get('/v1/mini-apps/installed')).status).toBe(404);
    const admin = await signup(t);
    await makeStaff(t, admin, 'admin');
    expect((await admin.client.get('/v1/staff/mini-apps')).status).toBe(404);
  });

  it('runs the full lifecycle: draft, submit, staff review, catalog, install with chosen permissions, suspend', async () => {
    await setFlag(true);
    try {
      const dev = await signup(t);
      const user = await signup(t);
      const teen = await teenUser();
      const admin = await signup(t);
      const moderator = await signup(t);
      await makeStaff(t, admin, 'admin');
      await makeStaff(t, moderator, 'moderator');
      const app = await mkApp(dev);
      const slug = uniq('mini');

      // manifest validation
      expect(
        (await mk(dev, app.id, { manifest: { entryUrl: 'http://insecure.example.test' } })).status,
      ).toBe(400);
      expect(
        (
          await mk(dev, app.id, {
            manifest: { entryUrl: 'https://ok.example.test', permissions: ['read_all_dms'] },
          })
        ).status,
      ).toBe(400);
      expect(
        (await mk(dev, app.id, { manifest: { entryUrl: 'https://ok.example.test', extra: 1 } }))
          .status,
      ).toBe(400);
      expect((await mk(dev, app.id, { slug: 'A b' })).status).toBe(400);

      const created = await mk(dev, app.id, { slug });
      expect(created.status).toBe(201);
      expect(created.body.status).toBe('draft');
      const id = created.body.id;
      expect((await mk(dev, app.id, { slug })).status).toBe(409); // slug unique
      // drafts are not in the catalog
      expect((await user.client.get(`/v1/mini-apps/${slug}`)).status).toBe(404);
      expect(
        (await user.client.get('/v1/mini-apps')).body.items.map((m: any) => m.slug),
      ).not.toContain(slug);

      // ownership
      const stranger = await signup(t);
      expect((await stranger.client.post(`/v1/developer/mini-apps/${id}/submit`)).status).toBe(404);
      expect(
        (await stranger.client.patch(`/v1/developer/mini-apps/${id}`, { name: 'Hijack' })).status,
      ).toBe(404);

      expect((await dev.client.post(`/v1/developer/mini-apps/${id}/submit`)).body.status).toBe(
        'in_review',
      );
      expect(
        (await dev.client.patch(`/v1/developer/mini-apps/${id}`, { name: 'Edited during review' }))
          .status,
      ).toBe(409);

      // staff review authorization: only admin+
      for (const who of [user, dev, moderator]) {
        expect(
          (await who.client.put(`/v1/staff/mini-apps/${id}/review`, { decision: 'approve' }))
            .status,
        ).toBe(403);
      }
      expect(
        (await new Client(t).put(`/v1/staff/mini-apps/${id}/review`, { decision: 'approve' }))
          .status,
      ).toBe(401);
      expect(
        (await admin.client.put(`/v1/staff/mini-apps/${id}/review`, { decision: 'reject' })).status,
      ).toBe(400); // note required
      const queue = await admin.client.get('/v1/staff/mini-apps');
      expect(queue.body.items.map((m: any) => m.id)).toContain(id);

      const rejected = await admin.client.put(`/v1/staff/mini-apps/${id}/review`, {
        decision: 'reject',
        note: 'Please explain the location use',
      });
      expect(rejected.body.status).toBe('rejected');
      expect(
        (await admin.client.put(`/v1/staff/mini-apps/${id}/review`, { decision: 'approve' }))
          .status,
      ).toBe(409); // not in review any more
      // rejected apps can be fixed and resubmitted
      expect(
        (await dev.client.patch(`/v1/developer/mini-apps/${id}`, { version: '1.0.1' })).body.status,
      ).toBe('draft');
      await dev.client.post(`/v1/developer/mini-apps/${id}/submit`);
      expect(
        (await admin.client.put(`/v1/staff/mini-apps/${id}/review`, { decision: 'approve' })).body
          .status,
      ).toBe('published');
      expect(
        (
          await sql(
            `SELECT count(*)::int AS n FROM audit_logs WHERE target_id = $1 AND action LIKE 'mini_app.%'`,
            [id],
          )
        ).rows[0].n,
      ).toBeGreaterThanOrEqual(5);

      // catalog and consent model
      const detail = await user.client.get(`/v1/mini-apps/${slug}`);
      expect(detail.body.permissions.map((p: any) => p.permission)).toEqual([
        'profile.basic',
        'posts.read_own',
      ]);
      expect(
        (
          await user.client.post(`/v1/mini-apps/${slug}/install`, {
            grantedPermissions: ['profile.basic', 'location.coarse'],
          })
        ).status,
      ).toBe(400); // undeclared
      expect(
        (
          await user.client.post(`/v1/mini-apps/${slug}/install`, {
            grantedPermissions: ['profile.basic'],
          })
        ).status,
      ).toBe(201);
      expect((await user.client.get('/v1/mini-apps/installed')).body.items[0]).toMatchObject({
        slug,
        grantedPermissions: ['profile.basic'],
      });
      expect(
        (await teen.client.post(`/v1/mini-apps/${slug}/install`, { grantedPermissions: [] }))
          .status,
      ).toBe(403);
      expect((await new Client(t).get('/v1/mini-apps')).status).toBe(401);

      // published apps cannot be edited in place; withdrawing pulls them from the catalog
      expect(
        (await dev.client.patch(`/v1/developer/mini-apps/${id}`, { name: 'Sneaky change' })).status,
      ).toBe(409);
      // suspension hides it and blocks new installs
      expect(
        (
          await admin.client.put(`/v1/staff/mini-apps/${id}/review`, {
            decision: 'suspend',
            note: 'Policy violation',
          })
        ).body.status,
      ).toBe('suspended');
      expect((await user.client.get(`/v1/mini-apps/${slug}`)).status).toBe(404);
      expect(
        (await stranger.client.post(`/v1/mini-apps/${slug}/install`, { grantedPermissions: [] }))
          .status,
      ).toBe(404);
      expect(
        (await admin.client.put(`/v1/staff/mini-apps/${id}/review`, { decision: 'reinstate' })).body
          .status,
      ).toBe('published');
      expect((await user.client.del(`/v1/mini-apps/${slug}/install`)).status).toBe(204);
      expect((await user.client.del(`/v1/mini-apps/${slug}/install`)).status).toBe(404);
      expect((await dev.client.post(`/v1/developer/mini-apps/${id}/withdraw`)).body.status).toBe(
        'draft',
      );
      expect((await user.client.get(`/v1/mini-apps/${slug}`)).status).toBe(404);
    } finally {
      await setFlag(false);
    }
  });
});

describe('staff MFA on the mini-app review queue', () => {
  it('rejects an admin without MFA', async () => {
    await sql(`UPDATE feature_flags SET enabled = true, rollout_pct = 100 WHERE key = 'MINI_APPS'`);
    t.ctx.flags.invalidate();
    try {
      const u = await signup(t);
      await sql(`UPDATE users SET platform_role = 'admin' WHERE id = $1`, [u.id]);
      const r = await u.client.get('/v1/staff/mini-apps');
      expect(r.status).toBe(403);
    } finally {
      await sql(
        `UPDATE feature_flags SET enabled = false, rollout_pct = 0 WHERE key = 'MINI_APPS'`,
      );
      t.ctx.flags.invalidate();
    }
  });
});
