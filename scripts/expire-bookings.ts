/**
 * Cancels booking requests that the business never answered before their start time and tells the customer.
 * Schedule every 10 minutes: npx tsx scripts/expire-bookings.ts
 */
import { loadConfig, loadDotEnv } from '@yapilapi/config';
import { createContext } from '../apps/api/src/context-factory.js';
import { expireStaleBookings } from '../apps/api/src/modules/business/index.js';

loadDotEnv();
const ctx = createContext(loadConfig());
try {
  console.log(`expired booking requests: ${await expireStaleBookings(ctx)}`);
} finally {
  await ctx.pubsub.close();
  await ctx.limiter.close();
  await ctx.db.end();
}
