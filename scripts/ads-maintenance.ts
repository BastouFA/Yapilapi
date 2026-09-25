/**
 * Ads maintenance. Idempotent; schedule every 10 minutes:
 *   npx tsx scripts/ads-maintenance.ts        (or: npm run ads:maintenance)
 * Ends campaigns past their end date or out of budget, then settles accrued spend into the ledger (a receivable from the advertiser).
 */
import { loadConfig, loadDotEnv } from '@yapilapi/config';
import { createContext } from '../apps/api/src/context-factory.js';
import { runAdsMaintenance } from '../apps/api/src/modules/ads/index.js';

loadDotEnv();
const ctx = createContext(loadConfig());
try {
  console.log(JSON.stringify(await runAdsMaintenance(ctx)));
} finally {
  await ctx.pubsub.close();
  await ctx.limiter.close();
  await ctx.db.end();
}
