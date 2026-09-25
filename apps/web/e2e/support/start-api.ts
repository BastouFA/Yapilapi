/**
 * Starts the real API for the E2E run against the private database `yapilapi_test_web`:
 * (re)creates the database, applies every migration, then runs apps/api/src/server.ts with the console email
 * adapter. API output is teed to a log file so tests can read verification links from it.
 */
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, migrate, resetSchema } from '@yapilapi/database';
import { ADMIN_DB_URL, API_LOG, API_PORT, DB_NAME, DB_URL, WEB_URL } from './env';

if (!DB_NAME.includes('test'))
  throw new Error('Refusing to run E2E against a database whose name does not contain "test"');

const admin = createPool(ADMIN_DB_URL, { max: 1 });
try {
  const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB_NAME]);
  if (!rows.length) await admin.query(`CREATE DATABASE ${DB_NAME}`);
} finally {
  await admin.end();
}
const db = createPool(DB_URL, { max: 2 });
try {
  await resetSchema(db, 'test');
  const r = await migrate(db);
  console.log(`[e2e] database ${DB_NAME} reset, ${r.applied.length} migrations applied`);
} finally {
  await db.end();
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const log = createWriteStream(API_LOG, { flags: 'w' });
const child = spawn(
  process.execPath,
  ['--import', 'tsx', path.join(root, 'apps/api/src/server.ts')],
  {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      APP_ENV: 'development',
      API_HOST: '127.0.0.1',
      API_PORT: String(API_PORT),
      API_PUBLIC_URL: `http://127.0.0.1:${API_PORT}`,
      WEB_PUBLIC_URL: WEB_URL,
      CORS_ALLOWED_ORIGINS: WEB_URL,
      DATABASE_URL: DB_URL,
      REDIS_URL: '', // in-process pub/sub: never share channels with other API instances
      EMAIL_ADAPTER: 'console',
      RATE_LIMIT_ENABLED: 'false',
      LOG_LEVEL: 'info',
      COOKIE_SECURE: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
child.stdout.on('data', (b: Buffer) => {
  log.write(b);
  process.stdout.write(b);
});
child.stderr.on('data', (b: Buffer) => {
  log.write(b);
  process.stderr.write(b);
});
const stop = () => {
  child.kill('SIGTERM');
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
child.on('exit', (code) => process.exit(code ?? 0));
