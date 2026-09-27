import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
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
