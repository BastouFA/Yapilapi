/**
 * Delete raw analytics events older than ANALYTICS_RETENTION_DAYS (default 90, see .env.example).
 * Schedule daily:  npx tsx scripts/analytics-retention.ts
 * Idempotent.
 */
import { loadConfig, loadDotEnv } from '@yapilapi/config';
import { createContext } from '../apps/api/src/context-factory.js';
import { purgeOldAnalytics } from '../apps/api/src/modules/analytics/track.js';

loadDotEnv();
const ctx = createContext(loadConfig());
try {
  const n = await purgeOldAnalytics(ctx);
  console.log(`analytics events deleted: ${n}`);
} finally {
  await ctx.pubsub.close();
  await ctx.limiter.close();
  await ctx.db.end();
}
