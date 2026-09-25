/**
 * Scheduled studio publishing. Idempotent and safe to run concurrently; schedule every minute:
 *   npx tsx scripts/studio-publish.ts        (or: npm run studio:publish)
 * Publishes ONLY publications the creator explicitly confirmed (exact content + exact media), and only when nothing changed since then.
 */
import { loadConfig, loadDotEnv } from '@yapilapi/config';
import { createContext } from '../apps/api/src/context-factory.js';
import { publishDueStudioPosts } from '../apps/api/src/modules/studio/index.js';

loadDotEnv();
const ctx = createContext(loadConfig());
try {
  console.log(JSON.stringify(await publishDueStudioPosts(ctx)));
} finally {
  await ctx.pubsub.close();
  await ctx.limiter.close();
  await ctx.db.end();
}
