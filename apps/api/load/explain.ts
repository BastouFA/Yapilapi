/**
 * Slow-query finder: `pnpm --filter @yapilapi/api load:explain`, after `pnpm load`
 * has seeded the load database.
 *
 * Builds the API in-process against LOAD_DATABASE_URL, times every query the
 * hot endpoints run (as several seeded users), and prints the slowest
 * statements with EXPLAIN (ANALYZE, BUFFERS) for the worst call of each.
 */
import { loadConfig } from '../src/config.ts';
import { buildApp } from '../src/app.ts';

const DB = process.env.LOAD_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/yapilapi_load';
const USERS = Number(process.env.EXPLAIN_USERS ?? 20);
const TOP = Number(process.env.EXPLAIN_TOP ?? 8);

interface Stat {
  sql: string;
  calls: number;
  totalMs: number;
  maxMs: number;
  worstParams: unknown[];
  routes: Set<string>;
}

const { app, ctx, close } = await buildApp(
  loadConfig({ ...process.env, APP_ENV: 'test', DATABASE_URL: DB, REDIS_URL: '', AI_PROVIDER: 'dev', RATE_LIMIT_MAX: '1000000' }),
  { logger: false, webhookWorker: false },
);

const stats = new Map<string, Stat>();
let route = '';
const original = ctx.db.query.bind(ctx.db) as (sql: string, params?: unknown[]) => Promise<unknown>;
(ctx.db as unknown as { query: typeof original }).query = async (sql: string, params?: unknown[]) => {
  const t0 = performance.now();
  try {
    return await original(sql, params);
  } finally {
    const ms = performance.now() - t0;
    const key = sql.replace(/\s+/g, ' ').trim();
    const s = stats.get(key) ?? { sql: key, calls: 0, totalMs: 0, maxMs: 0, worstParams: [], routes: new Set<string>() };
    s.calls++;
    s.totalMs += ms;
    s.routes.add(route);
    if (ms >= s.maxMs) {
      s.maxMs = ms;
      s.worstParams = params ?? [];
    }
    stats.set(key, s);
  }
};

const { rows: users } = await ctx.db.query<{ email: string }>(`SELECT email FROM users WHERE email LIKE '%@load.example.test' ORDER BY random() LIMIT $1`, [
  USERS,
]);
if (!users.length) throw new Error('No seeded users: run `pnpm load` first.');

const tokens: string[] = [];
for (const u of users) {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: u.email, password: 'load-test-password-1' } });
  tokens.push(res.json().token);
}

const routes = [
  '/v1/feed',
  '/v1/feed?mode=following',
  '/v1/search?q=sunset',
  '/v1/search?q=music',
  '/v1/search?q=amara',
  '/v1/notifications',
  '/v1/ads/next',
  '/v1/conversations',
];
for (const url of routes) {
  route = url;
  for (const token of tokens) {
    const res = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
    if (res.statusCode !== 200) console.warn(`${url} → ${res.statusCode}`);
  }
}
route = '';

const top = [...stats.values()].sort((a, b) => b.totalMs / b.calls - a.totalMs / a.calls).slice(0, TOP);
for (const s of top) {
  console.log(`\n── ${(s.totalMs / s.calls).toFixed(2)} ms avg, ${s.maxMs.toFixed(2)} ms max, ${s.calls} calls  [${[...s.routes].join(', ')}]`);
  console.log(s.sql.slice(0, 400) + (s.sql.length > 400 ? ' …' : ''));
  const plan = await original(`EXPLAIN (ANALYZE, BUFFERS) ${s.sql}`, s.worstParams);
  for (const r of (plan as { rows: Record<string, string>[] }).rows) console.log('   ', r['QUERY PLAN']);
}

await close();
