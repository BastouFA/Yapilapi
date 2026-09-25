/**
 * Long-running maintenance scheduler: runs every job listed in
 * docs/operations/resilience-and-disaster-recovery.md#scheduled-jobs on its documented cadence, in-process,
 * for as long as this process stays up.
 *
 * This exists so an operator does not have to wire ~12 separate cron entries (and pay Render's per-cron-service
 * minimum ~12 times over, or pull a fresh container for a job that's due every 60s). One long-lived worker with
 * its own timers is both cheaper and simpler to operate; each job is still exactly the same idempotent,
 * safe-to-run-concurrently function the standalone scripts/*.ts entrypoints call, so nothing about job semantics
 * changes versus running them as separate cron invocations.
 *
 * Deploy as a Render "worker" service (or any process supervisor) with:
 *   startCommand: node --import tsx scripts/scheduler.ts
 * A crash restarts the whole scheduler (all jobs), which is intentional: these jobs are cheap, idempotent, and
 * safe to run more often than their cadence, so restarting from zero is always safe.
 *
 * If you'd rather run these as N separate Render Cron Job services instead (e.g. to see each job's history and
 * duration independently in the dashboard), scripts/*.ts remain fully usable standalone for that; this file is an
 * alternative operator can choose, not a replacement for them.
 */
import { loadConfig, loadDotEnv } from '@yapilapi/config';
import { createContext } from '../apps/api/src/context-factory.js';
import { buildApp } from '../apps/api/src/app.js';
import { completeEndedEvents, sendEventReminders } from '../apps/api/src/modules/events/index.js';
import { expireStaleBookings } from '../apps/api/src/modules/business/index.js';
import { expireMoments } from '../apps/api/src/modules/moments/service.js';
import {
  autoCompleteOrders,
  releaseExpiredReservations,
} from '../apps/api/src/modules/commerce/index.js';
import {
  retryPendingFulfilments,
  retryProcessingRefunds,
} from '../apps/api/src/modules/payments/index.js';
import { runCreatorMaintenance } from '../apps/api/src/modules/creator/maintenance.js';
import { publishDueStudioPosts } from '../apps/api/src/modules/studio/index.js';
import { runLiveMaintenance } from '../apps/api/src/modules/live/index.js';
import { runAdsMaintenance } from '../apps/api/src/modules/ads/index.js';
import { expireEnforcements } from '../apps/api/src/modules/safety/service.js';
import { finalizeDueDeletions } from '../apps/api/src/modules/privacy/deletion.js';
import { purgeExpiredExports } from '../apps/api/src/modules/privacy/export.js';
import { sendEmailDigests } from '../apps/api/src/modules/notifications/digest.js';
import { purgeOldNotifications } from '../apps/api/src/modules/notifications/service.js';
import { deliverWebhooks, purgeOldDeliveries } from '../apps/api/src/modules/developer/webhooks.js';
import { purgeExpiredOAuth } from '../apps/api/src/modules/developer/oauth.js';
import { getMediaRuntime, runMediaMaintenance } from '../apps/api/src/modules/media/index.js';
import { purgeOldAnalytics } from '../apps/api/src/modules/analytics/track.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;

loadDotEnv();
const ctx = createContext(loadConfig());
// Account deletion runs every module's registered deletion hook, which only exist once the app is assembled
// (see scripts/finalize-deletions.ts for the same reasoning). Build it once, up front, for the whole process
// lifetime rather than per run.
const app = await buildApp(ctx);
await app.ready();

interface Job {
  name: string;
  cadenceMs: number;
  run: () => Promise<string>;
}

const jobs: Job[] = [
  {
    name: 'moments:expire',
    cadenceMs: 15 * MINUTE,
    run: async () => {
      const r = await expireMoments(ctx);
      return `expired moments: ${r.moments}, media deleted: ${r.media}`;
    },
  },
  {
    name: 'events:reminders',
    cadenceMs: 5 * MINUTE,
    run: async () => {
      const r = await sendEventReminders(ctx);
      const completed = await completeEndedEvents(ctx);
      return `considered ${r.considered}, sent ${r.sent}, already sent ${r.alreadySent}; events completed: ${completed.length}`;
    },
  },
  {
    name: 'bookings:expire',
    cadenceMs: 5 * MINUTE,
    run: async () => `expired booking requests: ${await expireStaleBookings(ctx)}`,
  },
  {
    name: 'commerce:maintenance',
    cadenceMs: 5 * MINUTE,
    run: async () => {
      const released = await releaseExpiredReservations(ctx);
      const fulfilments = await retryPendingFulfilments(ctx);
      const refunds = await retryProcessingRefunds(ctx);
      const completed = await autoCompleteOrders(ctx);
      return `released ${released}, retried fulfilments ${fulfilments}, retried refunds ${refunds}, auto-completed ${completed}`;
    },
  },
  {
    name: 'studio:publish',
    cadenceMs: 1 * MINUTE,
    run: async () => JSON.stringify(await publishDueStudioPosts(ctx)),
  },
  {
    name: 'live:maintenance',
    cadenceMs: 15 * MINUTE,
    run: async () => JSON.stringify(await runLiveMaintenance(ctx)),
  },
  {
    name: 'ads:maintenance',
    cadenceMs: 15 * MINUTE,
    run: async () => JSON.stringify(await runAdsMaintenance(ctx)),
  },
  {
    name: 'creator:maintenance',
    cadenceMs: 15 * MINUTE,
    run: async () => JSON.stringify(await runCreatorMaintenance(ctx)),
  },
  {
    name: 'safety:expire-enforcements',
    cadenceMs: 15 * MINUTE,
    run: async () => {
      const r = await expireEnforcements(ctx);
      return `accounts reinstated: ${r.reinstated}`;
    },
  },
  {
    name: 'privacy:finalize-deletions',
    cadenceMs: 60 * MINUTE,
    run: async () => {
      const r = await finalizeDueDeletions(ctx);
      const purged = await purgeExpiredExports(ctx);
      for (const f of r.failed)
        console.error(`[scheduler] FAILED deletion ${f.userId}: ${f.error}`);
      return `accounts deleted: ${r.finalized} (failed: ${r.failed.length}), exports purged: ${purged}`;
    },
  },
  {
    name: 'notifications:digests',
    cadenceMs: 60 * MINUTE,
    run: async () => {
      const r = await sendEmailDigests(ctx);
      const purged = await purgeOldNotifications(ctx);
      return `digests sent: ${r.sent}, considered: ${r.users}, skipped: ${r.skipped}, failed: ${r.failed}, purged: ${purged}`;
    },
  },
  {
    name: 'developer:webhooks',
    cadenceMs: 1 * MINUTE,
    run: async () => {
      const r = await deliverWebhooks(ctx);
      const oauth = await purgeExpiredOAuth(ctx);
      const old = await purgeOldDeliveries(ctx);
      return `webhooks attempted ${r.attempted}, ok ${r.succeeded}, retry ${r.retried}, failed ${r.failed}; oauth purged ${oauth.codes}/${oauth.tokens}; deliveries purged ${old}`;
    },
  },
  {
    name: 'media:cleanup',
    cadenceMs: 60 * MINUTE,
    run: async () => {
      const r = await runMediaMaintenance(ctx);
      await getMediaRuntime(ctx).queue.idle();
      return `expired uploads: ${r.expiredUploads}, purged: ${r.purged}, requeued: ${r.requeued}`;
    },
  },
  {
    name: 'analytics:retention',
    cadenceMs: 24 * 60 * MINUTE,
    run: async () => `analytics events deleted: ${await purgeOldAnalytics(ctx)}`,
  },
];

const timers: NodeJS.Timeout[] = [];
const running = new Set<string>();

async function tick(job: Job) {
  if (running.has(job.name)) {
    ctx.log.warn(`[scheduler] ${job.name} still running from the previous tick, skipping`);
    return;
  }
  running.add(job.name);
  const startedAt = Date.now();
  try {
    const summary = await job.run();
    ctx.log.info(`[scheduler] ${job.name} ok in ${Date.now() - startedAt}ms: ${summary}`);
  } catch (err) {
    ctx.log.error({ err }, `[scheduler] ${job.name} failed`);
  } finally {
    running.delete(job.name);
  }
}

// Stagger first runs so 13 jobs don't all hit the database in the same instant on boot.
jobs.forEach((job, i) => {
  const initialDelay = Math.min(i * 2 * SECOND, 30 * SECOND);
  const startTimer = setTimeout(() => {
    void tick(job);
    timers.push(setInterval(() => void tick(job), job.cadenceMs));
  }, initialDelay);
  timers.push(startTimer);
});

console.log(`[scheduler] started ${jobs.length} jobs: ${jobs.map((j) => j.name).join(', ')}`);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[scheduler] ${signal} received, stopping`);
  for (const t of timers) clearTimeout(t);
  // Let any in-flight job finish rather than cutting its DB transaction off mid-way.
  const deadline = Date.now() + 25 * SECOND;
  while (running.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
  }
  await app.close();
  await ctx.pubsub.close();
  await ctx.limiter.close();
  await ctx.db.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
