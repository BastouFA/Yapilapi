/**
 * Reinstate accounts whose time-limited suspension has ended. Schedule every 5 minutes:
 *   npx tsx scripts/expire-enforcements.ts
 * Idempotent; only touches accounts that have an ended suspension enforcement and no active one.
 */
import { loadConfig, loadDotEnv } from '@yapilapi/config';
import { createContext } from '../apps/api/src/context-factory.js';
import { expireEnforcements } from '../apps/api/src/modules/safety/service.js';

loadDotEnv();
const ctx = createContext(loadConfig());
try {
  const r = await expireEnforcements(ctx);
  console.log(`accounts reinstated: ${r.reinstated}`);
} finally {
  await ctx.pubsub.close();
  await ctx.limiter.close();
  await ctx.db.end();
}
