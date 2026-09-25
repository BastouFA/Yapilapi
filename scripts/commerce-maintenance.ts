/**
 * Commerce/payments housekeeping. Idempotent and safe to run concurrently; schedule every 1-5 minutes:
 *   npx tsx scripts/commerce-maintenance.ts        (or: npm run commerce:maintenance)
 *  - releases stock held by unpaid orders whose reservation expired (cancels them, voids open payments)
 *  - hands pending entitlements (tickets, bookings, downloads, memberships) whose fulfilment crashed back to the fulfiller
 *  - re-drives refunds stuck in `processing` (provider call outcome unknown; idempotent at the provider)
 *  - completes fulfilled orders nobody disputed for ORDER_AUTO_COMPLETE_DAYS
 */
import { loadConfig, loadDotEnv } from '@yapilapi/config';
import { createContext } from '../apps/api/src/context-factory.js';
import {
  autoCompleteOrders,
  releaseExpiredReservations,
} from '../apps/api/src/modules/commerce/index.js';
import {
  retryPendingFulfilments,
  retryProcessingRefunds,
} from '../apps/api/src/modules/payments/index.js';

loadDotEnv();
const ctx = createContext(loadConfig());
try {
  console.log(`released expired reservations: ${await releaseExpiredReservations(ctx)}`);
  console.log(`retried pending fulfilments: ${await retryPendingFulfilments(ctx)}`);
  console.log(`retried processing refunds: ${await retryProcessingRefunds(ctx)}`);
  console.log(`auto-completed orders: ${await autoCompleteOrders(ctx)}`);
} finally {
  await ctx.pubsub.close();
  await ctx.limiter.close();
  await ctx.db.end();
}
