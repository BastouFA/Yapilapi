import pg from 'pg';
import { ensureDatabase, migrate } from '@yapilapi/database';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/yapilapi_test';

/** Fresh schema for every run: drop everything, re-apply migrations. */
export default async function setup() {
  await ensureDatabase(TEST_DB);
  const c = new pg.Client({ connectionString: TEST_DB });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await c.end();
  await migrate(TEST_DB, () => {});
}
