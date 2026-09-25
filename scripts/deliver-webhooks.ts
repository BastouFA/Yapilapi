/**
 * Deliver due developer webhooks and clean up expired OAuth material and old delivery logs.
 * Run every minute:  npx tsx scripts/deliver-webhooks.ts
 * Safe to run concurrently (rows are claimed with SKIP LOCKED). Every attempt re-validates the destination (SSRF) and
 * pins the connection to the validated address.
 */
import { loadConfig, loadDotEnv } from '@yapilapi/config';
import { createContext } from '../apps/api/src/context-factory.js';
import { deliverWebhooks, purgeOldDeliveries } from '../apps/api/src/modules/developer/webhooks.js';
import { purgeExpiredOAuth } from '../apps/api/src/modules/developer/oauth.js';

loadDotEnv();
const ctx = createContext(loadConfig());
try {
  const r = await deliverWebhooks(ctx);
  const oauth = await purgeExpiredOAuth(ctx);
  const old = await purgeOldDeliveries(ctx);
  console.log(
    `webhooks attempted: ${r.attempted}, ok: ${r.succeeded}, retry: ${r.retried}, failed: ${r.failed}; oauth purged: ${oauth.codes} codes / ${oauth.tokens} tokens; deliveries purged: ${old}`,
  );
} finally {
  await ctx.pubsub.close();
  await ctx.limiter.close();
  await ctx.db.end();
}
