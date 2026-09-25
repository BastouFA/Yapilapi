import pg from 'pg';

/**
 * Runs before every integration test file: recreates the private test database from the pristine
 * migrated template built in global-setup.ts. Files run sequentially (fileParallelism: false) and close
 * their pools in afterAll, and DROP ... WITH (FORCE) evicts any straggler connection.
 */
const url = process.env.TEST_DATABASE_URL!;
const dbName = new URL(url).pathname.slice(1);
if (!/^[a-z0-9_]+$/.test(dbName) || !dbName.includes('test')) {
  throw new Error(`Refusing to reset database "${dbName}" (name must contain "test")`);
}
const admin = new pg.Client({ connectionString: url.replace(/\/[^/]+$/, '/postgres') });
await admin.connect();
try {
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${dbName} TEMPLATE ${dbName}_tpl`);
} finally {
  await admin.end();
}
