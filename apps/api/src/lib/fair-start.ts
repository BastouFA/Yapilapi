import type { Pool, PoolClient } from 'pg';
import { FAIR_START, type FairStart, type FairStartReport } from '@yapilapi/shared';
import { SPAM_RULES } from './spam.ts';
import { isEnabled, notify } from './services.ts';
import type { RealtimeHub } from './realtime.ts';
import { yapDistributableSql } from './voice.ts';

type Q = Pool | PoolClient;

/**
 * Fair start (docs/product/pass-the-mic.md): a new creator's first reels are shown to up to
 * FAIR_START.target real people, through one slot in FAIR_START.slotEvery of For you and Reels
 * (lib/ranking.ts, withFairStart). The numbers are FAIR_START in packages/shared/src/constants.ts.
 *
 * Who gets one: the first FAIR_START.firstReels reels of an account that can have one, then one
 * every FAIR_START.everyDays days while it has fewer than FAIR_START.underFollowers followers; one
 * running at a time. The reel is public, from a public adult account that confirmed its email or
 * phone, isn't limited or suspended, has no open risk flags adding up to a risky account, and the
 * reel itself isn't held, sensitive or an echo. With spam checks on, accounts made from one
 * address have at most FAIR_START.perSignupAddress running at once. A reel held for review gets
 * its fair start when a moderator clears it, within FAIR_START.clearedWithinDays of its posting.
 *
 * Who counts: each real person once (fair_start_views): someone else, with an active account
 * that isn't limited or flagged as risky, who had it on screen (a feed impression, which only
 * counts posts they can see: blocks either way never count).
 *
 * It stops when it reached its target, after FAIR_START.days, or when it's taken down (then
 * without a report). When early viewers mostly move on at once, or it's reported, it is slowed:
 * it goes to people after the others and only until FAIR_START.minimum.
 */

/** The viewer `v` counts as a real person: an active account, not limited, without risky flags. */
const realViewerSql = (v: string) =>
  `EXISTS (SELECT 1 FROM users ru WHERE ru.id = ${v} AND ru.status = 'active' AND ru.restricted_at IS NULL
           AND (SELECT coalesce(sum(rs.weight), 0) FROM risk_signals rs WHERE rs.user_id = ru.id AND rs.status = 'open') < ${SPAM_RULES.riskyAccountScore})`;

/** The account `a` (users `au`, profiles `ap`) may have a fair start now. `spam`: sign-up addresses are checked too. */
function accountEligibleSql(spam: boolean): string {
  const F = FAIR_START;
  const address = spam
    ? `AND (SELECT count(*) FROM fair_start_reels f2 JOIN security_events se2 ON se2.user_id = f2.author_id AND se2.type = 'account_created'
            WHERE f2.status = 'active' AND se2.ip = (SELECT se.ip FROM security_events se WHERE se.user_id = au.id AND se.type = 'account_created' LIMIT 1)) < ${F.perSignupAddress}`
    : '';
  return `(au.status = 'active' AND au.restricted_at IS NULL AND NOT ap.is_private
    AND (au.email_verified_at IS NOT NULL OR au.phone_verified_at IS NOT NULL)
    AND au.birth_date IS NOT NULL AND au.birth_date <= current_date - interval '18 years'
    AND (SELECT coalesce(sum(rs.weight), 0) FROM risk_signals rs WHERE rs.user_id = au.id AND rs.status = 'open') < ${SPAM_RULES.riskyAccountScore}
    AND NOT EXISTS (SELECT 1 FROM fair_start_reels f WHERE f.author_id = au.id AND f.status = 'active')
    AND ((SELECT count(*) FROM fair_start_reels f WHERE f.author_id = au.id) < ${F.firstReels}
         OR ((SELECT count(*) FROM follows fo WHERE fo.followee_id = au.id) < ${F.underFollowers}
             AND NOT EXISTS (SELECT 1 FROM fair_start_reels f WHERE f.author_id = au.id AND f.started_at > now() - interval '${F.everyDays} days')))
    ${address})`;
}

/** Whether the person's next reel would get a fair start (for the composer's line). */
export async function fairStartOffered(db: Q, userId: string, spam: boolean): Promise<boolean> {
  if (!(await isEnabled(db, 'FAIR_START'))) return false;
  const { rows } = await db.query(`SELECT 1 FROM users au JOIN profiles ap ON ap.user_id = au.id WHERE au.id = $1 AND ${accountEligibleSql(spam)}`, [userId]);
  return !!rows[0];
}

/**
 * Give a reel (or a Yap) that was just published a fair start when it and its author may have one. Returns
 * whether it did. `postedWithinDays`: only when it was posted that recently (a reel cleared from review).
 */
export async function enrollFairStart(db: Q, postId: string, spam: boolean, postedWithinDays?: number): Promise<boolean> {
  if (!(await isEnabled(db, 'FAIR_START'))) return false;
  const recent = postedWithinDays === undefined ? '' : `AND p.created_at > now() - make_interval(days => ${Math.floor(postedWithinDays)})`;
  const { rowCount } = await db.query(
    `INSERT INTO fair_start_reels (post_id, author_id, target, ends_at)
     SELECT p.id, p.author_id, $2, now() + make_interval(days => $3)
     FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
     WHERE p.id = $1 AND p.format IN ('reel', 'yap') AND NOT p.is_echo AND p.visibility = 'public' AND p.community_id IS NULL
       AND p.status = 'published' AND p.deleted_at IS NULL AND p.moderation_status = 'normal' ${recent}
       AND NOT EXISTS (SELECT 1 FROM post_media pm JOIN media m ON m.id = pm.media_id WHERE pm.post_id = p.id AND m.moderation IN ('sensitive', 'blocked'))
       -- A Yap only once its words passed the checks (or there will be none to check: lib/voice.ts).
       AND (p.format <> 'yap' OR ${yapDistributableSql('p')})
       AND ${accountEligibleSql(spam)}
     ON CONFLICT DO NOTHING`,
    [postId, FAIR_START.target, FAIR_START.days],
  );
  return !!rowCount;
}

/**
 * Reels held for review that a moderator just cleared: each gets its fair start now, when it and
 * its author still may have one and it was posted in the last FAIR_START.clearedWithinDays days.
 * Its FAIR_START.days start now; one runs at a time, so of several the earliest goes first. Call
 * after the item's (or account's) risk signals are decided.
 */
export async function enrollClearedFairStarts(db: Q, postIds: string[], spam: boolean): Promise<void> {
  if (!postIds.length) return;
  const { rows } = await db.query<{ id: string }>(`SELECT id FROM posts WHERE id = ANY($1::uuid[]) AND format IN ('reel', 'yap') ORDER BY created_at`, [
    postIds,
  ]);
  for (const r of rows) if (await enrollFairStart(db, r.id, spam, FAIR_START.clearedWithinDays)) return;
}

/**
 * Count the real people among `viewer`'s impressions of fair-start reels (once each), then check
 * the reels they saw: slowed, done, stopped. The caller already left out posts the viewer can't see and their own.
 */
export async function countFairStartViews(db: Q, realtime: RealtimeHub, viewer: string, postIds: string[]): Promise<void> {
  if (!postIds.length) return;
  const { rows } = await db.query<{ post_id: string }>(
    `WITH ins AS (
       INSERT INTO fair_start_views (post_id, viewer_id)
       SELECT f.post_id, $1 FROM fair_start_reels f
       WHERE f.post_id = ANY($2::uuid[]) AND f.status = 'active' AND f.author_id <> $1 AND ${realViewerSql('$1')}
       ON CONFLICT DO NOTHING RETURNING post_id)
     UPDATE fair_start_reels f SET reached = f.reached + 1 FROM ins WHERE f.post_id = ins.post_id RETURNING f.post_id`,
    [viewer, postIds],
  );
  if (rows.length)
    await refreshFairStarts(
      db,
      realtime,
      rows.map((r) => r.post_id),
    );
}

/** What a fair start reached so far: real people, and of them who watched to the end, shared and followed. */
async function reportOf(db: Q, postId: string): Promise<FairStartReport> {
  const { rows } = await db.query(
    `SELECT f.reached,
            (SELECT count(DISTINCT e.user_id) FROM feed_events e JOIN fair_start_views v ON v.post_id = e.post_id AND v.viewer_id = e.user_id
             WHERE e.post_id = f.post_id AND e.kind IN ('complete', 'listen_complete'))::int AS finished,
            (SELECT count(DISTINCT e.user_id) FROM feed_events e JOIN fair_start_views v ON v.post_id = e.post_id AND v.viewer_id = e.user_id
             WHERE e.post_id = f.post_id AND e.kind = 'share')::int AS shared,
            (SELECT count(*) FROM fair_start_views v JOIN follows fo ON fo.follower_id = v.viewer_id AND fo.followee_id = f.author_id AND fo.created_at >= v.created_at
             WHERE v.post_id = f.post_id)::int AS followed
     FROM fair_start_reels f WHERE f.post_id = $1`,
    [postId],
  );
  const r = rows[0] ?? {};
  return { reached: r.reached ?? 0, finished: r.finished ?? 0, shared: r.shared ?? 0, followed: r.followed ?? 0 };
}

/**
 * Check running fair starts (these, or every one whose time is up): stop the ones taken down,
 * slow the ones early viewers mostly skipped or that were reported, and finish the ones that
 * reached their target (FAIR_START.minimum when slowed) or ran out of time, telling the creator
 * once with the report. Each step is a guarded update, so two at once never tell twice.
 */
export async function refreshFairStarts(db: Q, realtime: RealtimeHub, postIds?: string[]): Promise<void> {
  const F = FAIR_START;
  const which = postIds ? `f.post_id = ANY($1::uuid[])` : `f.ends_at <= now() OR f.reached >= f.target OR (f.slowed AND f.reached >= ${F.minimum})`;
  const params = postIds ? [postIds] : [];
  // Taken down, deleted, made private, held, marked sensitive, or the account limited or suspended: it stops, without a report.
  await db.query(
    `UPDATE fair_start_reels f SET status = 'stopped', finished_at = now()
     WHERE f.status = 'active' AND (${which}) AND NOT EXISTS (
       SELECT 1 FROM posts p JOIN users au ON au.id = p.author_id JOIN profiles ap ON ap.user_id = p.author_id
       WHERE p.id = f.post_id AND p.deleted_at IS NULL AND p.status = 'published' AND p.moderation_status = 'normal' AND p.visibility = 'public'
         AND NOT ap.is_private AND au.status = 'active' AND au.restricted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM post_media pm JOIN media m ON m.id = pm.media_id WHERE pm.post_id = p.id AND m.moderation IN ('sensitive', 'blocked')))`,
    params,
  );
  // Slowed: reported, or most of the first people moved on at once (the apps' skip: left within 2 seconds).
  await db.query(
    `UPDATE fair_start_reels f SET slowed = true
     WHERE f.status = 'active' AND NOT f.slowed AND (${which}) AND (
       EXISTS (SELECT 1 FROM reports r WHERE r.target_type = 'post' AND r.target_id = f.post_id)
       OR (f.reached >= ${F.checkAfter}
           AND (SELECT count(DISTINCT e.user_id) FROM feed_events e JOIN fair_start_views v ON v.post_id = e.post_id AND v.viewer_id = e.user_id
                WHERE e.post_id = f.post_id AND e.kind = 'skip')::real / f.reached > ${F.skipShare}))`,
    params,
  );
  const due = await db.query<{ post_id: string; author_id: string; format: string | null }>(
    `SELECT f.post_id, f.author_id, (SELECT p.format FROM posts p WHERE p.id = f.post_id) AS format FROM fair_start_reels f
     WHERE f.status = 'active' AND (${which}) AND (f.ends_at <= now() OR f.reached >= CASE WHEN f.slowed THEN least(f.target, ${F.minimum}) ELSE f.target END)`,
    params,
  );
  for (const d of due.rows) {
    const report = await reportOf(db, d.post_id);
    const done = await db.query(`UPDATE fair_start_reels SET status = 'done', finished_at = now(), report = $2 WHERE post_id = $1 AND status = 'active'`, [
      d.post_id,
      report,
    ]);
    if (!done.rowCount) continue;
    await notify(db, realtime, {
      userId: d.author_id,
      category: 'creators',
      type: 'fair_start_done',
      entityType: 'post',
      entityId: d.post_id,
      // A Yap's report says "heard your Yap", a reel's "saw your reel".
      data: { ...report, format: d.format === 'yap' ? 'yap' : 'reel' },
    });
  }
}

/** Once a minute: fair starts whose time ran out (and any that reached their target) finish. */
export async function sweepFairStarts(deps: { db: Pool; realtime: RealtimeHub }): Promise<void> {
  await refreshFairStarts(deps.db, deps.realtime);
}

/** A reel's fair start for its creator, or null when it had none. */
export async function fairStartOf(db: Q, postId: string): Promise<FairStart | null> {
  const { rows } = await db.query(`SELECT * FROM fair_start_reels WHERE post_id = $1`, [postId]);
  const f = rows[0];
  if (!f) return null;
  return {
    status: f.status,
    target: f.slowed ? Math.min(f.target, FAIR_START.minimum) : f.target,
    reached: f.reached,
    slowed: f.slowed,
    startedAt: f.started_at.toISOString(),
    endsAt: f.ends_at.toISOString(),
    finishedAt: f.finished_at?.toISOString() ?? null,
    report: (f.report as FairStartReport | null) ?? (await reportOf(db, postId)),
  };
}
