import { randomBytes } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { loadConfig } from '@yapilapi/config';
import { totpAt } from '@yapilapi/security';
import { buildApp } from '../src/app.js';
import { createContext } from '../src/context-factory.js';
import { MemoryEmailSender } from '../src/lib/email.js';
import { MemoryPubSub } from '../src/lib/pubsub.js';
import { MemoryRateLimiter } from '../src/lib/rate-limit.js';
import type { AppContext } from '../src/lib/context.js';

export const ORIGIN = 'http://localhost:3000';

export interface TestApp {
  app: FastifyInstance;
  ctx: AppContext;
  email: MemoryEmailSender;
  close(): Promise<void>;
}

export async function createTestApp(env: Record<string, string> = {}): Promise<TestApp> {
  const config = loadConfig({
    NODE_ENV: 'test',
    APP_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
    DATABASE_POOL_MAX: '5',
    RATE_LIMIT_ENABLED: 'false',
    DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    CORS_ALLOWED_ORIGINS: `${ORIGIN},http://localhost:3100`,
    ...env,
  });
  const email = new MemoryEmailSender();
  const ctx = createContext(config, {
    email,
    pubsub: new MemoryPubSub(),
    limiter: new MemoryRateLimiter(),
  });
  const app = await buildApp(ctx);
  await app.ready();
  return {
    app,
    ctx,
    email,
    close: async () => {
      await app.close();
      await ctx.pubsub.close();
      await ctx.db.end();
    },
  };
}

let counter = 0;
export const uniq = (prefix = 'u') =>
  `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}${randomBytes(2).toString('hex')}`
    .slice(0, 28)
    .toLowerCase();

/** Untyped JSON body of an API response: tests probe arbitrary fields of it, and the HTTP boundary has no static schema. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON response bodies in test helpers
export type ResponseBody = any;

export interface Res<T = ResponseBody> {
  status: number;
  body: T;
  headers: Record<string, unknown>;
}

/** Minimal HTTP client with a cookie jar that behaves like a browser (Origin + CSRF header) or a mobile app (Bearer). */
export class Client {
  cookies = new Map<string, string>();
  token: string | null = null;
  constructor(
    private readonly t: TestApp,
    private readonly mode: 'browser' | 'bearer' = 'browser',
  ) {}

  async request<T = ResponseBody>(
    method: InjectOptions['method'],
    url: string,
    opts: { body?: unknown; query?: Record<string, string>; headers?: Record<string, string> } = {},
  ): Promise<Res<T>> {
    const headers: Record<string, string> = { ...opts.headers };
    if (this.mode === 'browser') {
      headers.origin ??= ORIGIN;
      if (method !== 'GET') headers['x-yl-csrf'] ??= '1';
      if (this.cookies.size)
        headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    } else if (this.token) {
      headers.authorization = `Bearer ${this.token}`;
    }
    const res = await this.t.app.inject({
      method,
      url,
      headers,
      query: opts.query,
      ...(opts.body !== undefined ? { payload: opts.body as object } : {}),
    });
    for (const c of res.cookies) {
      if (c.value === '' || (c.expires && c.expires.getTime() < Date.now()))
        this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    let body: unknown = undefined;
    try {
      body = res.body ? JSON.parse(res.body) : undefined;
    } catch {
      body = res.body;
    }
    return { status: res.statusCode, body: body as T, headers: res.headers };
  }
  get = <T = ResponseBody>(url: string, query?: Record<string, string>) =>
    this.request<T>('GET', url, query ? { query } : {});
  post = <T = ResponseBody>(url: string, body?: unknown) =>
    this.request<T>('POST', url, { body: body ?? {} });
  patch = <T = ResponseBody>(url: string, body?: unknown) =>
    this.request<T>('PATCH', url, { body: body ?? {} });
  put = <T = ResponseBody>(url: string, body?: unknown) =>
    this.request<T>('PUT', url, { body: body ?? {} });
  del = <T = ResponseBody>(url: string, body?: unknown) =>
    this.request<T>('DELETE', url, body === undefined ? {} : { body });
}

export interface TestUser {
  client: Client;
  id: string;
  email: string;
  username: string;
  password: string;
}

export async function signup(
  t: TestApp,
  opts: {
    mode?: 'browser' | 'bearer';
    birthDate?: string;
    username?: string;
    displayName?: string;
    email?: string;
  } = {},
): Promise<TestUser> {
  const client = new Client(t, opts.mode ?? 'browser');
  const username = opts.username ?? uniq('u');
  const email = opts.email ?? `${username}@example.test`;
  const password = 'Sturdy-Passphrase-42';
  const res = await client.post('/v1/auth/register', {
    email,
    password,
    username,
    displayName: opts.displayName ?? `Test ${username}`,
    birthDate: opts.birthDate ?? '1995-06-15',
    acceptTerms: true,
    deliver: opts.mode === 'bearer' ? 'token' : 'cookie',
  });
  if (res.status !== 201)
    throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  if (opts.mode === 'bearer') client.token = res.body.token;
  return { client, id: res.body.user.id, email, username, password };
}

/** Enable TOTP for a user through the real API; returns the secret so tests can compute codes. */
export async function enableMfa(u: TestUser): Promise<{ secret: string; recoveryCodes: string[] }> {
  const setup = await u.client.post('/v1/auth/mfa/setup');
  const secret: string = setup.body.secret;
  const en = await u.client.post('/v1/auth/mfa/enable', { code: totpAt(secret, Date.now()) });
  if (en.status !== 200) throw new Error(`mfa enable failed: ${JSON.stringify(en.body)}`);
  return { secret, recoveryCodes: en.body.recoveryCodes };
}

/** Promote a user to a staff role directly in the DB (there is intentionally no public API for it) and enable MFA. */
export async function makeStaff(
  t: TestApp,
  u: TestUser,
  role: 'support' | 'moderator' | 'admin' | 'superadmin' = 'admin',
) {
  await t.ctx.db.query('UPDATE users SET platform_role = $2 WHERE id = $1', [u.id, role]);
  return enableMfa(u);
}
