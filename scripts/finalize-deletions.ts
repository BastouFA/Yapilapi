/**
 * Permanently delete accounts whose 14-day deletion grace period has ended, and purge expired data exports.
 * Schedule hourly:  npx tsx scripts/finalize-deletions.ts
 * Idempotent. Each account is deleted in its own transaction, so one failure never blocks the others; failures are
 * printed and the process exits non-zero so the scheduler alerts.
 */
import { loadConfig, loadDotEnv } from '@yapilapi/config';
import { createContext } from '../apps/api/src/context-factory.js';
import { buildApp } from '../apps/api/src/app.js';
import { finalizeDueDeletions } from '../apps/api/src/modules/privacy/deletion.js';
import { purgeExpiredExports } from '../apps/api/src/modules/privacy/export.js';

loadDotEnv();
const ctx = createContext(loadConfig());
// Account deletion runs every module's registered deletion hook. Modules register them when the app is assembled,
// so assemble it (without listening) to make the hook list complete. Deleting with a partial list would leave data behind.
const app = await buildApp(ctx);
await app.ready();
try {
  const r = await finalizeDueDeletions(ctx);
  const purged = await purgeExpiredExports(ctx);
  console.log(`accounts deleted: ${r.finalized}, exports purged: ${purged}`);
  for (const f of r.failed) console.error(`FAILED ${f.userId}: ${f.error}`);
  if (r.failed.length) process.exitCode = 1;
} finally {
  await app.close();
  await ctx.pubsub.close();
  await ctx.limiter.close();
  await ctx.db.end();
}
