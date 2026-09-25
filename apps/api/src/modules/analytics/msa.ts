/**
 * "Meaningful Social Actions" (MSA): the product's north-star measurement. The full written definition is in
 * docs/product/analytics.md; this file is its single source of truth in code (constants, pure rules and the SQL that
 * applies them), so the doc, the tests and the dashboards cannot drift apart.
 *
 * MSA are computed from the operational tables as AGGREGATES. They are not built from tracking events, so they do not
 * depend on anybody's analytics consent and never produce a per-person record: only counts leave this module, and any
 * cell smaller than MIN_CELL is suppressed.
 */

export const MSA_TYPES = ['message', 'comment', 'post', 'plan'] as const;
export type MsaType = (typeof MSA_TYPES)[number];

/** Per user, per UTC day, per type: actions beyond the cap do not count (a spammer cannot inflate the metric). */
export const MSA_DAILY_CAP: Record<MsaType, number> = {
  message: 10,
  comment: 10,
  post: 5,
  plan: 5,
};

/** A Meaningful Weekly Participant has at least this many (capped) MSA ... */
export const MWP_MIN_ACTIONS = 3;
/** ... on at least this many distinct UTC days ... */
export const MWP_MIN_DAYS = 2;
/** ... within the trailing window. */
export const MWP_WINDOW_DAYS = 7;

/** Aggregate cells below this size are never returned (small-cell suppression). */
export const MIN_CELL = 5;

/** Counts of 1..MIN_CELL-1 are replaced by null; 0 and larger counts are returned as they are. */
export function suppress(n: number | null | undefined): number | null {
  if (n === null || n === undefined) return null;
  return n > 0 && n < MIN_CELL ? null : n;
}

/** Apply the daily cap to one user's per-day, per-type raw counts. */
export function cappedActions(raw: Partial<Record<MsaType, number>>): number {
  let total = 0;
  for (const t of MSA_TYPES) total += Math.min(Math.max(raw[t] ?? 0, 0), MSA_DAILY_CAP[t]);
  return total;
}

/** MWP rule over one user's per-UTC-day capped totals (day key -> capped actions that day). */
export function isMeaningfulWeeklyParticipant(
  perDay: ReadonlyMap<string, number> | Record<string, number>,
): boolean {
  const entries = perDay instanceof Map ? [...perDay.entries()] : Object.entries(perDay);
  let total = 0;
  let days = 0;
  for (const [, n] of entries) {
    if (n > 0) days += 1;
    total += n;
  }
  return total >= MWP_MIN_ACTIONS && days >= MWP_MIN_DAYS;
}

/**
 * Raw MSA rows ($1 = window start inclusive, $2 = window end exclusive, both timestamptz): (user_id, type, created_at).
 *  - message: a real message (not a system notice) that passed moderation, is not deleted, and sits in a conversation
 *    that has another current member (talking to yourself is not social)
 *  - comment: an approved, non-deleted comment on someone ELSE's post
 *  - post: an approved, non-deleted, non-private post
 *  - plan: RSVP "going"/"attended" to someone else's event, or hosting an event that has been published
 * Reactions, follows, saves, views, shares, searches, notification opens and time spent are NOT MSA (they are cheap to
 * produce and say little about people actually connecting).
 */
export const MSA_RAW_SQL = `
  SELECT m.sender_id AS user_id, 'message'::text AS type, m.created_at
    FROM messages m
   WHERE m.created_at >= $1 AND m.created_at < $2
     AND m.sender_id IS NOT NULL AND m.kind <> 'system' AND m.moderation_status = 'approved' AND m.deleted_at IS NULL
     AND EXISTS (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id = m.conversation_id AND cm.user_id <> m.sender_id AND cm.left_at IS NULL)
  UNION ALL
  SELECT c.author_id, 'comment', c.created_at
    FROM comments c JOIN posts p ON p.id = c.post_id
   WHERE c.created_at >= $1 AND c.created_at < $2
     AND c.moderation_status = 'approved' AND c.deleted_at IS NULL AND c.author_id <> p.author_id
  UNION ALL
  SELECT p.author_id, 'post', p.created_at
    FROM posts p
   WHERE p.created_at >= $1 AND p.created_at < $2
     AND p.visibility <> 'private' AND p.moderation_status = 'approved' AND p.deleted_at IS NULL
  UNION ALL
  SELECT ea.user_id, 'plan', ea.created_at
    FROM event_attendees ea JOIN events e ON e.id = ea.event_id
   WHERE ea.created_at >= $1 AND ea.created_at < $2
     AND ea.status IN ('going','attended') AND e.host_id <> ea.user_id AND e.status <> 'draft' AND e.deleted_at IS NULL
  UNION ALL
  SELECT e.host_id, 'plan', COALESCE(e.published_at, e.created_at)
    FROM events e
   WHERE COALESCE(e.published_at, e.created_at) >= $1 AND COALESCE(e.published_at, e.created_at) < $2
     AND e.status <> 'draft' AND e.deleted_at IS NULL AND e.host_id IS NOT NULL`;

/** Capped per-user, per-day, per-type counts. Only active accounts are counted. */
export const MSA_CAPPED_SQL = `
  WITH raw AS (${MSA_RAW_SQL}),
  daily AS (
    SELECT r.user_id, r.type, (r.created_at AT TIME ZONE 'UTC')::date AS day, count(*)::int AS n
      FROM raw r JOIN users u ON u.id = r.user_id AND u.status = 'active'
     GROUP BY 1, 2, 3
  ),
  capped AS (
    SELECT user_id, type, day,
           LEAST(n, CASE type WHEN 'message' THEN ${MSA_DAILY_CAP.message} WHEN 'comment' THEN ${MSA_DAILY_CAP.comment} WHEN 'post' THEN ${MSA_DAILY_CAP.post} ELSE ${MSA_DAILY_CAP.plan} END) AS n
      FROM daily
  )`;
