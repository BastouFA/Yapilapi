/**
 * Send email digests of unread notifications to users who opted in, then delete notifications older than 90 days.
 * Schedule every 30 minutes:  npx tsx scripts/send-email-digests.ts
 * Idempotent: a user gets at most one digest per 20 hours, and quiet hours / pause / focus mode are respected.
 */
import { loadConfig, loadDotEnv } from '@yapilapi/config';
import { createContext } from '../apps/api/src/context-factory.js';
import { sendEmailDigests } from '../apps/api/src/modules/notifications/digest.js';
import { purgeOldNotifications } from '../apps/api/src/modules/notifications/service.js';

loadDotEnv();
const ctx = createContext(loadConfig());
try {
  const r = await sendEmailDigests(ctx);
  const purged = await purgeOldNotifications(ctx);
  console.log(
    `digests sent: ${r.sent}, users considered: ${r.users}, skipped: ${r.skipped}, failed: ${r.failed}, old notifications purged: ${purged}`,
  );
  if (r.failed) process.exitCode = 1;
} finally {
  await ctx.pubsub.close();
  await ctx.limiter.close();
  await ctx.db.end();
}
