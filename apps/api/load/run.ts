/**
 * Load test: `pnpm load` (from the repo root) or `pnpm --filter @yapilapi/api load`.
 *
 * 1. Resets a dedicated load-test database (never the development one) and migrates it.
 * 2. Starts the API as a child process against it, so the load generator does not
 *    share an event loop with the server.
 * 3. Seeds users, follows, posts, reactions, conversations and ad campaigns through the API.
 * 4. Runs each scenario with autocannon (warm-up, then a measured run) and prints
 *    p50/p95/p99 latency, throughput and errors next to the p95 target.
 *
 * Settings (environment):
 *   LOAD_DATABASE_URL  postgres://postgres:postgres@localhost:5432/yapilapi_load  (reset on every run)
 *   LOAD_REDIS_URL     redis://localhost:6379/13 (empty string = no Redis)
 *   LOAD_PORT          4100
 *   LOAD_CONNECTIONS   16      concurrent connections per scenario
 *   LOAD_DURATION      15      measured seconds per scenario (plus 3 s warm-up)
 *   LOAD_USERS         500     seeded users (posts, follows etc. scale with it)
 *   LOAD_ONLY          comma-separated scenario names to run, e.g. "home feed,ads next"
 *   LOAD_OUT           write the results as JSON to this file
 *   LOAD_TRACING       set to an OTLP endpoint to run the API with tracing on
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import autocannon from 'autocannon';
import pg from 'pg';
import { ensureDatabase, migrate } from '@yapilapi/database';
import { seed } from './seed.ts';
import { scenarios, type Scenario } from './scenarios.ts';

const env = process.env;
const DB = env.LOAD_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/yapilapi_load';
const REDIS = env.LOAD_REDIS_URL ?? 'redis://localhost:6379/13';
const PORT = Number(env.LOAD_PORT ?? 4100);
const CONNECTIONS = Number(env.LOAD_CONNECTIONS ?? 16);
const DURATION = Number(env.LOAD_DURATION ?? 15);
const USERS = Number(env.LOAD_USERS ?? 500);
const ONLY = env.LOAD_ONLY?.split(',').map((s) => s.trim().toLowerCase());
const BASE = `http://127.0.0.1:${PORT}`;
const WEBHOOK_SECRET = 'load-test-webhook-secret';
const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The database is dropped and recreated, so refuse anything that doesn't look like a scratch database.
const dbName = new URL(DB).pathname.slice(1);
if (!/(load|perf|test)/.test(dbName) || dbName === 'yapilapi') {
  console.error(`Refusing to reset "${dbName}": LOAD_DATABASE_URL must name a scratch database (its name must contain load, perf or test).`);
  process.exit(1);
}

async function resetDatabase() {
  await ensureDatabase(DB);
  const c = new pg.Client({ connectionString: DB });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await c.end();
  await migrate(DB, () => {});
}

async function startApi(): Promise<ChildProcess> {
  // Never seed or load someone else's server by accident.
  const taken = await fetch(`${BASE}/health/live`)
    .then(() => true)
    .catch(() => false);
  if (taken) throw new Error(`Port ${PORT} is already in use; set LOAD_PORT to a free port.`);
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: apiDir,
    env: {
      PATH: env.PATH,
      HOME: env.HOME,
      NODE_ENV: 'production',
      // "test" lifts the per-user rate limits (they would otherwise be what we measure)
      // and turns off background workers, so only request handling is timed.
      APP_ENV: 'test',
      API_PORT: String(PORT),
      API_HOST: '127.0.0.1',
      DATABASE_URL: DB,
      REDIS_URL: REDIS,
      STORAGE_DRIVER: 'local',
      UPLOAD_DIR: path.join(os.tmpdir(), 'ypl-load-uploads'),
      PUBLIC_API_URL: BASE,
      AI_PROVIDER: 'dev',
      PAYMENTS_WEBHOOK_SECRET: WEBHOOK_SECRET,
      RATE_LIMIT_MAX: '1000000',
      ...(env.LOAD_TRACING ? { OTEL_EXPORTER_OTLP_ENDPOINT: env.LOAD_TRACING, OTEL_SERVICE_NAME: 'yapilapi-api-load' } : {}),
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`API exited with code ${child.exitCode}`);
    const ok = await fetch(`${BASE}/health/ready`)
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) return child;
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill();
  throw new Error(`API did not become ready on ${BASE}`);
}

export interface ScenarioResult {
  name: string;
  route: string;
  requests: number;
  rps: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  non2xx: number;
  errors: number;
  sloP95Ms: number;
  pass: boolean;
}

function percentile(sorted: number[], p: number) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

async function runScenario(s: Scenario, seconds: number, record: boolean): Promise<ScenarioResult> {
  const latencies: number[] = [];
  let non2xx = 0;
  let instance!: autocannon.Instance;
  const done = new Promise<autocannon.Result>((resolve, reject) => {
    instance = autocannon(
      {
        url: BASE,
        connections: CONNECTIONS,
        duration: seconds,
        requests: [
          {
            setupRequest: (req) => {
              const spec = s.next();
              return {
                ...req,
                method: spec.method,
                path: spec.path,
                headers: { authorization: `Bearer ${spec.token}`, ...(spec.body !== undefined ? { 'content-type': 'application/json' } : {}) },
                body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
              };
            },
          },
        ],
      },
      (err, res) => (err ? reject(err) : resolve(res)),
    );
  });
  instance.on('response', (_client, statusCode, _bytes, responseTime) => {
    if (!record) return;
    latencies.push(responseTime);
    if (statusCode < 200 || statusCode >= 300) non2xx++;
  });
  const result = await done;
  latencies.sort((a, b) => a - b);
  const p95 = percentile(latencies, 95);
  return {
    name: s.name,
    route: s.route,
    requests: latencies.length,
    rps: Math.round(latencies.length / seconds),
    p50: round(percentile(latencies, 50)),
    p95: round(p95),
    p99: round(percentile(latencies, 99)),
    max: round(latencies.at(-1) ?? 0),
    non2xx,
    errors: result.errors + result.timeouts,
    sloP95Ms: s.sloP95Ms,
    pass: p95 <= s.sloP95Ms && non2xx === 0 && result.errors + result.timeouts === 0,
  };
}

const round = (n: number) => Math.round(n * 10) / 10;

function table(rows: ScenarioResult[]) {
  const head = '| Scenario | Route | Requests | Req/s | p50 ms | p95 ms | p99 ms | max ms | Non-2xx | p95 target | Meets |';
  const sep = '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |';
  const lines = rows.map(
    (r) =>
      `| ${r.name} | \`${r.route}\` | ${r.requests} | ${r.rps} | ${r.p50} | ${r.p95} | ${r.p99} | ${r.max} | ${r.non2xx + r.errors} | ${r.sloP95Ms} | ${r.pass ? 'yes' : 'NO'} |`,
  );
  return [head, sep, ...lines].join('\n');
}

async function main() {
  console.log(`Load test against ${dbName} (reset), ${USERS} users, ${CONNECTIONS} connections, ${DURATION}s per scenario`);
  await resetDatabase();
  const api = await startApi();
  const db = new pg.Pool({ connectionString: DB, max: 2 });
  try {
    const dataset = await seed(
      {
        base: BASE,
        db,
        webhookSecret: WEBHOOK_SECRET,
        users: USERS,
        postsPerUser: 15,
        followsPerUser: 25,
        friendsPerUser: 5,
        likesPerUser: 30,
        commentsPerUser: 5,
        conversationsPerUser: 3,
        messagesPerConversation: 6,
        advertisers: Math.max(5, Math.round(USERS / 10)),
        concurrency: 16,
      },
      console.log,
    );
    const counts = (
      await db.query(
        `SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM posts) AS posts, (SELECT count(*) FROM follows) AS follows, (SELECT count(*) FROM friendships) AS friendships,
                (SELECT count(*) FROM reactions) AS reactions, (SELECT count(*) FROM messages) AS messages, (SELECT count(*) FROM notifications) AS notifications`,
      )
    ).rows[0];
    console.log(`  dataset: ${JSON.stringify(counts)}`);

    const results: ScenarioResult[] = [];
    for (const s of scenarios(dataset)) {
      if (ONLY && !ONLY.includes(s.name)) continue;
      process.stdout.write(`  ${s.name}: warm-up…`);
      await runScenario(s, 3, false);
      process.stdout.write(' measuring…');
      const r = await runScenario(s, DURATION, true);
      results.push(r);
      console.log(` p95 ${r.p95} ms, ${r.rps} req/s${r.pass ? '' : '  (misses target)'}`);
    }
    console.log(`\n${table(results)}\n`);
    console.log(`Node ${process.version}, ${os.cpus()[0]?.model ?? 'unknown CPU'} × ${os.cpus().length}, ${Math.round(os.totalmem() / 2 ** 30)} GB`);
    if (env.LOAD_OUT)
      await writeFile(
        env.LOAD_OUT,
        JSON.stringify({ at: new Date().toISOString(), connections: CONNECTIONS, duration: DURATION, users: USERS, dataset: counts, results }, null, 2),
      );
    process.exitCode = results.every((r) => r.pass) ? 0 : 1;
  } finally {
    await db.end();
    api.kill('SIGTERM');
  }
}

await main();
