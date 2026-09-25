import { loadConfig, loadDotEnv } from '@yapilapi/config';
import { createPool, migrate } from '@yapilapi/database';

loadDotEnv();
const config = loadConfig();
const db = createPool(config.DATABASE_URL, { max: 2 });
try {
  const { applied, skipped } = await migrate(db);
  console.log(`migrations: ${applied.length} applied, ${skipped.length} already applied`);
  for (const a of applied) console.log(`  + ${a}`);
} finally {
  await db.end();
}
