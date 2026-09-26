import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp, type BuiltApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';

/** A test app. `env` overrides configuration; `opts` passes build options (e.g. a fake fetch for Paystack). */
export async function testApp(env: Record<string, string> = {}, opts: Parameters<typeof buildApp>[1] = {}): Promise<BuiltApp> {
  const config = loadConfig({
    ...process.env,
    APP_ENV: 'test',
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/yapilapi_test',
    REDIS_URL: '',
    AI_PROVIDER: 'dev',
    UPLOAD_DIR: `/tmp/ypl-test-uploads`,
    PRIVATE_UPLOAD_DIR: `/tmp/ypl-test-private`,
    RATE_LIMIT_MAX: '10000',
    ...env,
  });
  return buildApp(config, { logger: false, ...opts });
}

export interface TestUser {
  id: string;
  token: string;
  username: string;
  email: string;
  password: string;
}

let n = 0;
export async function signUp(app: FastifyInstance, extra: Record<string, unknown> = {}): Promise<TestUser> {
  n++;
  const suffix = `${Date.now().toString(36)}${n}${randomUUID().slice(0, 4)}`;
  const body = {
    email: `t_${suffix}@example.test`,
    password: 'correct-horse-battery',
    username: `t_${suffix}`.slice(0, 30),
    displayName: `Tester ${n}`,
    ...extra,
  };
  const res = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: body });
  if (res.statusCode !== 201) throw new Error(`signup failed: ${res.statusCode} ${res.body}`);
  const json = res.json();
  return { id: json.user.id, token: json.token, username: body.username, email: body.email, password: body.password };
}

/** Authenticated request helper. */
export function as(app: FastifyInstance, user: TestUser | null) {
  const call = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => {
    const res = await app.inject({
      method,
      url,
      payload: payload as never,
      headers: user ? { authorization: `Bearer ${user.token}` } : {},
    });
    return { status: res.statusCode, body: res.body ? (res.json() as any) : null };
  };
  return {
    get: (url: string) => call('GET', url),
    post: (url: string, payload?: unknown) => call('POST', url, payload ?? {}),
    put: (url: string, payload?: unknown) => call('PUT', url, payload ?? {}),
    patch: (url: string, payload?: unknown) => call('PATCH', url, payload ?? {}),
    del: (url: string, payload?: unknown) => call('DELETE', url, payload),
  };
}
