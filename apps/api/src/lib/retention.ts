import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import { tx } from '@yapilapi/database';
import type { Config } from '../config.ts';
import type { MediaStorage } from './storage.ts';
import { purgeMedia, removeFiles, removeLiveRecordingFolder, unusedMedia } from './media-files.ts';

/**
 * How long we keep things. The privacy policy (apps/web/app/legal/privacy/page.tsx, "How long we
 * keep it") states these same periods: change both together.
 */
export const RETENTION = {
  /** Sessions that expired or were signed out. */
  endedSessionsDays: 30,
  /** Security events (sign-ins, password and two-step changes, failed attempts) with their IP address and device. */
  securityEventsDays: 365,
  /** The audit log of account, money and moderation actions. */
  auditLogsDays: 730,
  /** Product analytics events. 13 months, so a year can be compared with the one before. */
  analyticsEventsDays: 395,
  /** Daily minutes used (Settings, time spent). */
  usageDays: 395,
  /** The log of assistant and translation calls (no content). */
  aiCallLogDays: 90,
  /** Catch me up summaries and suggested chat replies, kept only to show them again. */
  aiSuggestionsDays: 7,
  /** Notifications in the inbox. */
  notificationsDays: 365,
  /** Phone number checks (the number, IP address and time). */
  phoneVerificationsDays: 90,
  /** One-time data once used or expired: email and reset links, sign-in challenges, OAuth codes, download links, unfinished uploads. */
  oneTimeDataDays: 7,
  /** Finished background jobs and webhook deliveries. */
  finishedJobsDays: 30,
  /** View-once uploads that were never sent. */
  unsentPrivateMediaHours: 24,
  /** Posts, comments, messages, stories and files people deleted, before they are erased for good (and their files). */
  deletedContentDays: 30,
  /** Content removed by moderators, kept for appeals and legal requests first. */
  removedByModerationDays: 180,
  /** A live's raw recording on the video server, after the live ended (the stored video is the host's to keep or delete). */
  rawLiveRecordingDays: 2,
  /**
   * Payment records (orders, payments, refunds, payouts, tips, subscriptions that ended and the
   * payment provider's notices): the legal accounting period, in years. FINANCIAL_RECORDS_YEARS
   * in the configuration changes it. A download someone bought stays theirs while their account
   * and the product exist.
   */
  financialRecordsYears: 7,
  /** Reports, moderation decisions, appeals and enforcements, after the case closed (kept while the account stays suspended). */
  safetyRecordsDays: 730,
  /** Call history (who called, when, how long), after the call. */
  callHistoryDays: 365,
  /** Watch together sessions (who joined and left, the queue), after they end. */
  watchSessionsDays: 90,
  /** The door's log for events: each scan, typed code and undo. */
  ticketScansDays: 90,
  /** Event tickets (with who gave them to whom), after the event ended or was cancelled. */
  pastTicketsDays: 365,
  /** Games in chats (and their card in the chat), after they end. */
  endedGamesDays: 365,
  /** An earlier username, after the 14-day hold on it ends. */
  usernameHistoryDaysAfterHold: 30,
  /** Devices remembered for sign-in alerts, and the devices of sessions, after they were last seen. */
  signInDevicesDays: 395,
  /** Visits to business pages, the times you opened Pulse, post and reel views, and ad impressions and clicks: 13 months. */
  visitsDays: 395,
} as const;

export interface RetentionDeps {
  db: Pool;
  storage: MediaStorage;
  config: Config;
}

const BATCH = 5000;

/** Delete in batches so no single statement holds locks for long. Returns how many rows went. */
async function deleteInBatches(db: Pool, table: string, where: string, params: unknown[] = []): Promise<number> {
  let total = 0;
  for (let i = 0; i < 1000; i++) {
    const r = await db.query(`DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} WHERE ${where} LIMIT ${BATCH})`, params);
    total += r.rowCount ?? 0;
    if ((r.rowCount ?? 0) < BATCH) break;
  }
  return total;
}

const days = (n: number) => `now() - interval '${n} days'`;

/**
 * Posts, stories and messages deleted long enough ago are erased: the rows, and the files of
 * their photos and videos that nothing else uses. Returns how many rows and media went.
 */
async function eraseDeleted(deps: RetentionDeps, table: 'posts' | 'moments' | 'messages', mediaSql: string): Promise<{ rows: number; media: number }> {
  let rows = 0;
  let media = 0;
  const due = `deleted_at IS NOT NULL AND (
      (deleted_at < ${days(RETENTION.deletedContentDays)} AND ${table === 'messages' || table === 'moments' ? 'true' : "moderation_status <> 'removed'"})
   OR deleted_at < ${days(RETENTION.removedByModerationDays)})`;
  for (let i = 0; i < 200; i++) {
    const ids = (await deps.db.query<{ id: string }>(`SELECT id FROM ${table} WHERE ${due} LIMIT 500`)).rows.map((r) => r.id);
    if (!ids.length) break;
    const mediaIds = (await deps.db.query<{ id: string }>(mediaSql, [ids])).rows.map((r) => r.id);
    // A reel's shareable video file (its row goes with the post).
    const shares =
      table === 'posts'
        ? (
            await deps.db.query<{ storage_key: string }>(`SELECT storage_key FROM share_videos WHERE post_id = ANY($1::uuid[]) AND storage_key IS NOT NULL`, [
              ids,
            ])
          ).rows
        : [];
    await deps.db.query(`DELETE FROM ${table} WHERE id = ANY($1::uuid[])`, [ids]);
    await removeFiles(
      deps,
      shares.map((s) => ({ url: null, poster_url: null, hls_url: null, variants: null, storage_key: s.storage_key })),
    );
    rows += ids.length;
    media += await purgeMedia(deps, await unusedMedia(deps.db, [...new Set(mediaIds)]));
    if (ids.length < 500) break;
  }
  return { rows, media };
}

/**
 * Payment records older than the accounting period: orders with their payments, refunds and the
 * tips they paid for, then payouts, subscriptions that ended and the payment provider's notices.
 * An order for a download stays while its buyer's account and the product exist (it is how they
 * keep access to what they bought).
 */
async function eraseFinancialRecords(db: Pool, years: number): Promise<number> {
  const cutoff = `now() - make_interval(years => ${Math.max(1, Math.floor(years))})`;
  let total = 0;
  for (let i = 0; i < 200; i++) {
    const ids = (
      await db.query<{ id: string }>(
        `SELECT o.id FROM orders o WHERE o.created_at < ${cutoff}
           AND NOT (o.status IN ('paid', 'partially_refunded')
                    AND EXISTS (SELECT 1 FROM users b WHERE b.id = o.buyer_id AND b.status = 'active')
                    AND EXISTS (SELECT 1 FROM order_items oi JOIN products pd ON pd.id = oi.product_id
                                WHERE oi.order_id = o.id AND pd.kind = 'digital' AND pd.deleted_at IS NULL))
         LIMIT 500`,
      )
    ).rows.map((r) => r.id);
    if (!ids.length) break;
    await tx(db, async (c) => {
      await c.query(`DELETE FROM refunds WHERE payment_id IN (SELECT id FROM payments WHERE order_id = ANY($1::uuid[]))`, [ids]);
      await c.query(`DELETE FROM payments WHERE order_id = ANY($1::uuid[])`, [ids]);
      await c.query(`DELETE FROM tips WHERE order_id = ANY($1::uuid[])`, [ids]);
      // A subscription still running keeps going; it just no longer points at its first payment.
      await c.query(`UPDATE creator_subscriptions SET order_id = NULL WHERE order_id = ANY($1::uuid[])`, [ids]);
      // Order lines and drop orders go with the order; bookings and Plus grants forget it.
      await c.query(`DELETE FROM orders WHERE id = ANY($1::uuid[])`, [ids]);
    });
    total += ids.length;
    if (ids.length < 500) break;
  }
  total += await deleteInBatches(db, 'payouts', `status IN ('paid', 'failed') AND created_at < ${cutoff}`);
  total += await deleteInBatches(
    db,
    'creator_subscriptions',
    `status IN ('cancelled', 'expired') AND coalesce(current_period_end, cancelled_at, created_at) < ${cutoff}`,
  );
  total += await deleteInBatches(db, 'payment_webhook_events', `received_at < ${cutoff}`);
  return total;
}

/** Raw live recordings left on the video server's disk after their live ended. */
async function sweepRawRecordings(deps: RetentionDeps): Promise<number> {
  const dir = deps.config.LIVE_RECORDINGS_DIR;
  if (!dir) return 0;
  let names: string[];
  try {
    names = await readdir(path.resolve(dir, 'live'));
  } catch {
    return 0;
  }
  const ids = names.filter((n) => /^[0-9a-f-]{36}$/i.test(n));
  if (!ids.length) return 0;
  // Folders of lives that ended long enough ago, or that no longer exist.
  const { rows } = await deps.db.query<{ id: string }>(
    `SELECT x.id FROM unnest($1::uuid[]) AS x(id) LEFT JOIN live_sessions l ON l.id = x.id
     WHERE l.id IS NULL OR (l.status = 'ended' AND l.ended_at < ${days(RETENTION.rawLiveRecordingDays)})`,
    [ids],
  );
  let n = 0;
  for (const r of rows) {
    // A folder of a live we don't know yet may still be being written: leave recent ones alone.
    const info = await stat(path.resolve(dir, 'live', r.id)).catch(() => null);
    if (!info || Date.now() - info.mtimeMs < RETENTION.rawLiveRecordingDays * 86400_000) continue;
    await removeLiveRecordingFolder(dir, r.id);
    n++;
  }
  return n;
}

/** Folders of resumable uploads that expired or finished (the chunks on disk). */
async function sweepUploadChunks(deps: RetentionDeps, ids: string[]): Promise<void> {
  for (const id of ids) await rm(path.resolve(deps.config.UPLOAD_DIR, '.chunks', id), { recursive: true, force: true }).catch(() => {});
}

/**
 * Delete what we no longer need to keep (periods in RETENTION). Every step runs even when one
 * fails; failures are reported in `errors`. Safe to run at any time and more than once.
 */
export async function runRetention(deps: RetentionDeps): Promise<{ counts: Record<string, number>; errors: string[] }> {
  const { db } = deps;
  const counts: Record<string, number> = {};
  const errors: string[] = [];
  const step = async (name: string, fn: () => Promise<number>) => {
    try {
      counts[name] = await fn();
    } catch (err) {
      errors.push(`${name}: ${(err as Error).message}`);
    }
  };

  await step('sessions', () =>
    deleteInBatches(db, 'sessions', `expires_at < ${days(RETENTION.endedSessionsDays)} OR revoked_at < ${days(RETENTION.endedSessionsDays)}`),
  );
  await step('securityEvents', () => deleteInBatches(db, 'security_events', `created_at < ${days(RETENTION.securityEventsDays)}`));
  await step('auditLogs', () => deleteInBatches(db, 'audit_logs', `created_at < ${days(RETENTION.auditLogsDays)}`));
  await step('analyticsEvents', () => deleteInBatches(db, 'analytics_events', `created_at < ${days(RETENTION.analyticsEventsDays)}`));
  await step('usageDays', () => deleteInBatches(db, 'usage_days', `day < (current_date - ${RETENTION.usageDays})`));
  await step('aiCallLog', () => deleteInBatches(db, 'ai_tool_calls', `created_at < ${days(RETENTION.aiCallLogDays)}`));
  await step('aiCatchups', () => deleteInBatches(db, 'ai_catchups', `created_at < ${days(RETENTION.aiSuggestionsDays)}`));
  await step('aiReplySuggestions', () => deleteInBatches(db, 'ai_reply_suggestions', `created_at < ${days(RETENTION.aiSuggestionsDays)}`));
  await step('notifications', () => deleteInBatches(db, 'notifications', `created_at < ${days(RETENTION.notificationsDays)}`));
  await step('phoneVerifications', () => deleteInBatches(db, 'phone_verifications', `created_at < ${days(RETENTION.phoneVerificationsDays)}`));

  // One-time data, once used or expired.
  const oneTime = days(RETENTION.oneTimeDataDays);
  await step('authTokens', () => deleteInBatches(db, 'auth_tokens', `expires_at < ${oneTime} OR used_at < ${oneTime}`));
  await step('mfaChallenges', () => deleteInBatches(db, 'mfa_challenges', `expires_at < ${oneTime}`));
  await step('webauthnChallenges', () => deleteInBatches(db, 'webauthn_challenges', `expires_at < ${oneTime}`));
  await step('oauthCodes', () => deleteInBatches(db, 'oauth_codes', `expires_at < ${oneTime}`));
  await step('downloadLinks', () => deleteInBatches(db, 'download_links', `expires_at < ${oneTime}`));
  await step('uploadSessions', async () => {
    const { rows } = await db.query<{ id: string }>(
      `DELETE FROM upload_sessions WHERE expires_at < ${oneTime} OR (status IN ('completed', 'failed', 'expired') AND created_at < ${oneTime}) RETURNING id`,
    );
    await sweepUploadChunks(
      deps,
      rows.map((r) => r.id),
    );
    return rows.length;
  });
  await step('jobs', () =>
    deleteInBatches(db, 'jobs', `status IN ('done', 'failed') AND coalesce(finished_at, created_at) < ${days(RETENTION.finishedJobsDays)}`),
  );
  await step('webhookDeliveries', () =>
    deleteInBatches(db, 'webhook_deliveries', `status IN ('delivered', 'failed') AND created_at < ${days(RETENTION.finishedJobsDays)}`),
  );

  // View-once uploads that were never sent: nobody can ever see them.
  await step('unsentPrivateMedia', async () => {
    const { rows } = await db.query<{ id: string }>(
      `SELECT m.id FROM media m WHERE m.private AND m.created_at < now() - interval '${RETENTION.unsentPrivateMediaHours} hours'
         AND NOT EXISTS (SELECT 1 FROM messages x WHERE x.view_once_media_id = m.id) LIMIT 1000`,
    );
    return purgeMedia(
      deps,
      rows.map((r) => r.id),
    );
  });
  // Files already marked deleted (unsent or ended view-once media, revoked chat files).
  await step('deletedMedia', async () => {
    const { rows } = await db.query<{ id: string }>(`SELECT id FROM media WHERE deleted_at < ${days(RETENTION.deletedContentDays)} LIMIT 1000`);
    return purgeMedia(
      deps,
      rows.map((r) => r.id),
    );
  });

  // Deleted content past its grace period, with the files only it used.
  await step('deletedPosts', async () => {
    const r = await eraseDeleted(deps, 'posts', `SELECT media_id AS id FROM post_media WHERE post_id = ANY($1::uuid[])`);
    counts.deletedPostMedia = r.media;
    return r.rows;
  });
  await step('deletedStories', async () => {
    const r = await eraseDeleted(deps, 'moments', `SELECT media_id AS id FROM moments WHERE id = ANY($1::uuid[]) AND media_id IS NOT NULL`);
    counts.deletedStoryMedia = r.media;
    return r.rows;
  });
  await step('deletedMessages', async () => {
    const r = await eraseDeleted(
      deps,
      'messages',
      `SELECT view_once_media_id AS id FROM messages WHERE id = ANY($1::uuid[]) AND view_once_media_id IS NOT NULL
       UNION SELECT (a->>'mediaId')::uuid FROM messages x, jsonb_array_elements(x.attachments) a
       WHERE x.id = ANY($1::uuid[]) AND a->>'mediaId' ~ '^[0-9a-f-]{36}$'`,
    );
    counts.deletedMessageMedia = r.media;
    return r.rows;
  });
  await step('deletedComments', () =>
    deleteInBatches(
      db,
      'comments',
      `deleted_at IS NOT NULL AND ((deleted_at < ${days(RETENTION.deletedContentDays)} AND moderation_status <> 'removed') OR deleted_at < ${days(RETENTION.removedByModerationDays)})`,
    ),
  );
  // Questions people deleted from their box, like comments (removed ones are kept longer for appeals).
  await step('deletedQuestions', () =>
    deleteInBatches(
      db,
      'ask_questions',
      `deleted_at IS NOT NULL AND ((deleted_at < ${days(RETENTION.deletedContentDays)} AND moderation_status <> 'removed') OR deleted_at < ${days(RETENTION.removedByModerationDays)})`,
    ),
  );
  await step('deletedLiveChat', () => deleteInBatches(db, 'live_chat', `deleted_at < ${days(RETENTION.deletedContentDays)}`));
  // Recaps people deleted: their video goes with them (unless it was shared somewhere).
  await step('deletedRecaps', async () => {
    const { rows } = await db.query<{ id: string; media_id: string | null }>(
      `DELETE FROM recaps WHERE deleted_at < ${days(RETENTION.deletedContentDays)} RETURNING id, media_id`,
    );
    await purgeMedia(
      deps,
      await unusedMedia(
        db,
        rows.map((r) => r.media_id).filter((x): x is string => !!x),
      ),
    );
    return rows.length;
  });
  await step('rawLiveRecordings', () => sweepRawRecordings(deps));

  // Payment records, after the accounting period.
  await step('financialRecords', () => eraseFinancialRecords(db, deps.config.FINANCIAL_RECORDS_YEARS ?? RETENTION.financialRecordsYears));

  // Safety records, after the case closed. Kept while the account they're about stays suspended.
  const safety = days(RETENTION.safetyRecordsDays);
  const notSuspended = (col: string) => `NOT EXISTS (SELECT 1 FROM users su WHERE su.id = ${col} AND su.status = 'suspended')`;
  await step('reports', () => deleteInBatches(db, 'reports', `status = 'closed' AND coalesce(closed_at, created_at) < ${safety}`));
  await step('moderationCases', () =>
    // Appeals go with their case.
    deleteInBatches(
      db,
      'moderation_cases',
      `status IN ('decided', 'final') AND decided_at < ${safety} AND ${notSuspended('moderation_cases.subject_user_id')}
       AND NOT EXISTS (SELECT 1 FROM appeals a WHERE a.case_id = moderation_cases.id AND a.status = 'open')`,
    ),
  );
  await step('enforcements', () =>
    deleteInBatches(
      db,
      'enforcements',
      `created_at < ${safety} AND (expires_at IS NULL OR expires_at < ${safety}) AND ${notSuspended('enforcements.user_id')}`,
    ),
  );

  // History with a set period.
  await step('calls', () =>
    deleteInBatches(db, 'calls', `status NOT IN ('ringing', 'active') AND coalesce(ended_at, created_at) < ${days(RETENTION.callHistoryDays)}`),
  );
  await step('watchSessions', () => deleteInBatches(db, 'watch_sessions', `status = 'ended' AND ended_at < ${days(RETENTION.watchSessionsDays)}`));
  await step('ticketScans', () => deleteInBatches(db, 'ticket_scans', `created_at < ${days(RETENTION.ticketScansDays)}`));
  await step('pastTickets', () =>
    deleteInBatches(
      db,
      'event_tickets',
      `event_id IN (SELECT id FROM events WHERE coalesce(deleted_at, ends_at, starts_at + interval '3 hours') < ${days(RETENTION.pastTicketsDays)})`,
    ),
  );
  // A game goes with its card in the chat, as when the card is unsent (the message is then erased like any deleted one).
  await step('endedGames', async () => {
    let n = 0;
    for (let i = 0; i < 200; i++) {
      const { rows } = await db.query<{ message_id: string }>(
        `WITH g AS (DELETE FROM chat_games WHERE id IN (SELECT id FROM chat_games WHERE status <> 'active' AND ended_at < ${days(RETENTION.endedGamesDays)} LIMIT 1000)
                    RETURNING message_id)
         UPDATE messages m SET deleted_at = coalesce(m.deleted_at, now()), body = '' FROM g WHERE m.id = g.message_id RETURNING m.id AS message_id`,
      );
      n += rows.length;
      if (rows.length < 1000) break;
    }
    return n;
  });
  await step('usernameHistory', () =>
    deleteInBatches(db, 'username_history', `held_until < now() - interval '${RETENTION.usernameHistoryDaysAfterHold} days'`),
  );
  const seen = days(RETENTION.signInDevicesDays);
  await step('knownSignIns', () => deleteInBatches(db, 'known_sign_ins', `last_seen_at < ${seen}`));
  await step('devices', () =>
    deleteInBatches(
      db,
      'devices',
      `last_seen_at < ${seen} AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.device_id = devices.id AND s.revoked_at IS NULL AND s.expires_at > now())`,
    ),
  );
  const visits = days(RETENTION.visitsDays);
  await step('businessViews', () => deleteInBatches(db, 'business_views', `day < (current_date - ${RETENTION.visitsDays})`));
  await step('pulseVisits', () => deleteInBatches(db, 'pulse_visits', `last_seen_at < ${visits}`));
  // View counts stay on the post; only who viewed it goes.
  await step('postViews', () => deleteInBatches(db, 'post_views', `viewed_at < ${visits}`));
  // "Hide this ad" is a choice, not an event: it stays while the campaign exists.
  await step('adEvents', () => deleteInBatches(db, 'ad_events', `kind <> 'hide' AND created_at < ${visits}`));
  return { counts, errors };
}

/**
 * Run the retention job at most once a day across every API instance: the first instance to claim
 * the day in maintenance_runs does it. Returns null when it wasn't due.
 */
export async function maybeRunRetention(deps: RetentionDeps, everyHours = 24): Promise<Awaited<ReturnType<typeof runRetention>> | null> {
  const claim = await deps.db.query(
    `INSERT INTO maintenance_runs (name, ran_at) VALUES ('retention', now())
     ON CONFLICT (name) DO UPDATE SET ran_at = now() WHERE maintenance_runs.ran_at < now() - make_interval(hours => $1)
     RETURNING name`,
    [everyHours - 1],
  );
  if (!claim.rowCount) return null;
  return runRetention(deps);
}
