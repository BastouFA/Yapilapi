/**
 * Event upkeep job. Schedule every 5-10 minutes (cron or a systemd timer): npx tsx scripts/send-event-reminders.ts
 *  - sends the 24h / 1h `event_reminder` notifications (idempotent: the event_reminders ledger makes re-runs and parallel workers safe)
 *  - marks published events that have ended as completed
 * Visibility and RSVP rules do not depend on this job.
 */
import { loadConfig, loadDotEnv } from '@yapilapi/config';
import { createContext } from '../apps/api/src/context-factory.js';
import { completeEndedEvents, sendEventReminders } from '../apps/api/src/modules/events/index.js';

loadDotEnv();
const ctx = createContext(loadConfig());
try {
  const r = await sendEventReminders(ctx);
  const completed = await completeEndedEvents(ctx);
  console.log(
    `event reminders: considered ${r.considered}, sent ${r.sent}, already sent ${r.alreadySent}; events completed: ${completed.length}`,
  );
} finally {
  await ctx.pubsub.close();
  await ctx.limiter.close();
  await ctx.db.end();
}
