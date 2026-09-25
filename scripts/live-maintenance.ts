/**
 * Live maintenance. Idempotent; schedule every 10 minutes:
 *   npx tsx scripts/live-maintenance.ts        (or: npm run live:maintenance)
 * Ends sessions left running for over 12 hours and cancels scheduled sessions that never started 24 hours after their time.
 */
import { loadConfig, loadDotEnv } from '@yapilapi/config';
import { createContext } from '../apps/api/src/context-factory.js';
import { runLiveMaintenance } from '../apps/api/src/modules/live/index.js';

loadDotEnv();
const ctx = createContext(loadConfig());
try {
  console.log(JSON.stringify(await runLiveMaintenance(ctx)));
} finally {
  await ctx.pubsub.close();
  await ctx.limiter.close();
  await ctx.db.end();
}
