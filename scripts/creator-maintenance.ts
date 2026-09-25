/**
 * Creator-economy housekeeping. Idempotent and safe to run concurrently; schedule every 1-5 minutes:
 *   npx tsx scripts/creator-maintenance.ts        (or: npm run creator:maintenance)
 *  - applies captured/failed payments to subscriptions, tips and gifts (needed with asynchronous providers)
 *  - renews due subscriptions, runs dunning (retries after 1/3/5 days, then expiry) and ends cancel-at-period-end subscriptions
 *  - marks paid brand partnerships, attributes affiliate conversions from paid orders and settles matured commissions
 */
import { loadConfig, loadDotEnv } from '@yapilapi/config';
import { createContext } from '../apps/api/src/context-factory.js';
import { runCreatorMaintenance } from '../apps/api/src/modules/creator/maintenance.js';

loadDotEnv();
const ctx = createContext(loadConfig());
try {
  console.log(JSON.stringify(await runCreatorMaintenance(ctx)));
} finally {
  await ctx.pubsub.close();
  await ctx.limiter.close();
  await ctx.db.end();
}
