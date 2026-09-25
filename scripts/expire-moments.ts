/**
 * Reclaim storage for expired moments (media is deleted, text/location erased). Schedule every 5 minutes
 * (cron or a systemd timer): npx tsx scripts/expire-moments.ts
 * Visibility does not depend on this job: expired moments are already invisible in SQL.
 */
import { loadConfig, loadDotEnv } from '@yapilapi/config';
import { createContext } from '../apps/api/src/context-factory.js';
import { expireMoments } from '../apps/api/src/modules/moments/service.js';

loadDotEnv();
const ctx = createContext(loadConfig());
try {
  const r = await expireMoments(ctx);
  console.log(`expired moments: ${r.moments}, media deleted: ${r.media}`);
} finally {
  await ctx.pubsub.close();
  await ctx.limiter.close();
  await ctx.db.end();
}
