/**
 * Media maintenance: drop expired unfinished uploads (and their chunks), delete storage objects of soft-deleted
 * media, and re-queue media stuck in uploaded/processing. Schedule hourly.
 */
import { loadConfig, loadDotEnv } from '@yapilapi/config';
import { createContext } from '../apps/api/src/context-factory.js';
import { getMediaRuntime, runMediaMaintenance } from '../apps/api/src/modules/media/index.js';

loadDotEnv();
const ctx = createContext(loadConfig());
try {
  const r = await runMediaMaintenance(ctx);
  await getMediaRuntime(ctx).queue.idle(); // let re-queued items finish before exiting
  console.log(`expired uploads: ${r.expiredUploads}, purged: ${r.purged}, requeued: ${r.requeued}`);
} finally {
  await ctx.pubsub.close();
  await ctx.limiter.close();
  await ctx.db.end();
}
