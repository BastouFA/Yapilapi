import { loadConfig, loadDotEnv } from '@yapilapi/config';
import { createPool, migrate, resetSchema } from '@yapilapi/database';

loadDotEnv();
const config = loadConfig();
const db = createPool(config.DATABASE_URL, { max: 2 });
try {
  await resetSchema(db, config.APP_ENV);
  const { applied } = await migrate(db);
  console.log(`database reset; ${applied.length} migrations applied`);
} finally {
  await db.end();
}
