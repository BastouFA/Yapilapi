import pg from 'pg';
import { createPool, migrate, resetSchema } from '@yapilapi/database';

/**
 * Integration tests run against a REAL PostgreSQL database (never mocks). The schema is rebuilt from
 * migrations at the start of every run. Set TEST_DATABASE_URL to use a private database (the database is
 * created if it does not exist) — parallel test runs MUST use different databases.
 */
export default async function setup() {
  const url =
    process.env.TEST_DATABASE_URL ??
    'postgres://yapilapi:yapilapi_dev_password@127.0.0.1:5432/yapilapi_test';
  process.env.TEST_DATABASE_URL = url;

  const u = new URL(url);
  const dbName = u.pathname.slice(1);
  if (!/^[a-z0-9_]+$/.test(dbName) || !dbName.includes('test')) {
    throw new Error(
      `Refusing to run integration tests against database "${dbName}" (name must contain "test")`,
    );
  }
  const admin = new pg.Client({ connectionString: url.replace(/\/[^/]+$/, '/postgres') });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      dbName,
    ]);
    if (!rowCount) await admin.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await admin.end();
  }

  const db = createPool(url, { max: 2 });
  try {
    await resetSchema(db, 'test');
    await migrate(db);
  } finally {
    await db.end();
  }

  // Freeze the freshly-migrated schema as a template. Every integration test FILE starts from a pristine
  // copy of it (see per-file-db.ts), so files cannot leak rows or feature-flag changes into each other.
  const admin2 = new pg.Client({ connectionString: url.replace(/\/[^/]+$/, '/postgres') });
  await admin2.connect();
  try {
    const tpl = `${dbName}_tpl`;
    await admin2.query(`DROP DATABASE IF EXISTS ${tpl} WITH (FORCE)`);
    await admin2.query(`CREATE DATABASE ${tpl} TEMPLATE ${dbName}`);
  } finally {
    await admin2.end();
  }
}
