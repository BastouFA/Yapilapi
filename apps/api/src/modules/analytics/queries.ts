import type { AppContext } from '../../lib/context.js';
import {
  MIN_CELL,
  MSA_CAPPED_SQL,
  MWP_MIN_ACTIONS,
  MWP_MIN_DAYS,
  MWP_WINDOW_DAYS,
  suppress,
} from './msa.js';

/**
 * Staff analytics: AGGREGATES only. Nothing here returns a row about a person. Every count that describes a group is
 * passed through `suppress` (cells of 1..4 become null) and, where a sum or percentile describes a small group, it is
 * withheld with the count.
 */

/** Start of the next UTC day: the exclusive end of every "trailing N days including today" window. */
const DAY_END = `((date_trunc('day', now() AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC')`;

/** Users' WRITE actions (the definition of "active": any post, comment, message, reaction, follow or RSVP). */
const WRITE_ACTIONS = (since: string) => `
  SELECT author_id AS user_id, created_at FROM posts WHERE created_at >= ${since} AND deleted_at IS NULL
  UNION ALL SELECT author_id, created_at FROM comments WHERE created_at >= ${since} AND deleted_at IS NULL
  UNION ALL SELECT sender_id, created_at FROM messages WHERE created_at >= ${since} AND deleted_at IS NULL AND kind <> 'system' AND sender_id IS NOT NULL
  UNION ALL SELECT user_id, created_at FROM reactions WHERE created_at >= ${since}
  UNION ALL SELECT follower_id, created_at FROM follows WHERE created_at >= ${since}
  UNION ALL SELECT user_id, created_at FROM event_attendees WHERE created_at >= ${since}`;

function suppressRows<T extends Record<string, unknown>>(
  rows: T[],
  countKey: string,
  alsoHide: string[] = [],
): Array<Record<string, unknown>> {
  return rows.map((r) => {
    const n = Number(r[countKey]);
    const hide = n > 0 && n < MIN_CELL;
    const out: Record<string, unknown> = { ...r, [countKey]: hide ? null : n };
    if (hide) for (const k of alsoHide) out[k] = null;
    return out;
  });
}

export async function acquisition(ctx: AppContext, days: number) {
  const [signups, onboarding, funnel, referrers] = await Promise.all([
    ctx.db.query(
      `SELECT to_char((u.created_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day, count(*)::int AS signups
         FROM users u WHERE u.created_at >= ${DAY_END} - make_interval(days => $1) AND u.status <> 'deleted' GROUP BY 1 ORDER BY 1`,
      [days],
    ),
    ctx.db.query(
      `SELECT count(*)::int AS signups, count(p.onboarding_completed_at)::int AS onboarded
         FROM users u LEFT JOIN profiles p ON p.user_id = u.id
        WHERE u.created_at >= ${DAY_END} - make_interval(days => $1) AND u.status <> 'deleted'`,
      [days],
    ),
    // Funnel from consented client events only: counts of distinct pseudonymous ids, so it under-counts by design.
    ctx.db.query(
      `SELECT properties->>'step' AS step, properties->>'action' AS action, count(DISTINCT COALESCE(user_id::text, anon_id))::int AS people
         FROM analytics_events WHERE name = 'onboarding_step' AND created_at >= ${DAY_END} - make_interval(days => $1) GROUP BY 1, 2 ORDER BY 1, 2`,
      [days],
    ),
    ctx.db.query(
      `SELECT properties->>'referrer_kind' AS referrer, count(*)::int AS opens
         FROM analytics_events WHERE name = 'app_open' AND created_at >= ${DAY_END} - make_interval(days => $1) GROUP BY 1 ORDER BY opens DESC`,
      [days],
    ),
  ]);
  const o = onboarding.rows[0] as { signups: number; onboarded: number };
  return {
    periodDays: days,
    signupsPerDay: suppressRows(signups.rows, 'signups'),
    onboarding: {
      signups: suppress(o.signups),
      onboarded: suppress(o.onboarded),
      completionRate: o.signups >= MIN_CELL ? Number((o.onboarded / o.signups).toFixed(3)) : null,
    },
    onboardingFunnel: {
      basis: 'consented client events only; distinct pseudonymous people',
      steps: suppressRows(funnel.rows, 'people'),
    },
    referrers: {
      basis: 'consented client events only',
      rows: suppressRows(referrers.rows, 'opens'),
    },
  };
}

export async function engagement(ctx: AppContext, days: number) {
  const window = Math.max(days, 30);
  const since = `${DAY_END} - make_interval(days => ${window})`;
  const [series, totals] = await Promise.all([
    ctx.db.query(
      `WITH a AS (${WRITE_ACTIONS(since)})
       SELECT to_char((created_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day, count(DISTINCT user_id)::int AS dau
         FROM a WHERE created_at >= ${DAY_END} - make_interval(days => $1) GROUP BY 1 ORDER BY 1`,
      [days],
    ),
    ctx.db.query(
      `WITH a AS (${WRITE_ACTIONS(since)})
       SELECT count(DISTINCT user_id) FILTER (WHERE created_at >= ${DAY_END} - interval '1 day')::int AS dau,
              count(DISTINCT user_id) FILTER (WHERE created_at >= ${DAY_END} - interval '7 days')::int AS wau,
              count(DISTINCT user_id) FILTER (WHERE created_at >= ${DAY_END} - interval '30 days')::int AS mau
         FROM a`,
    ),
  ]);
  const t = totals.rows[0] as { dau: number; wau: number; mau: number };
  return {
    definition:
      'Active = at least one write action (post, comment, message, reaction, follow, RSVP) in the UTC window. Reads and opens do not count.',
    periodDays: days,
    dauPerDay: suppressRows(series.rows, 'dau'),
    current: {
      dau: suppress(t.dau),
      wau: suppress(t.wau),
      mau: suppress(t.mau),
      stickiness: t.mau >= MIN_CELL ? Number((t.dau / t.mau).toFixed(3)) : null,
    },
  };
}

/** Weekly signup cohorts and the share of each cohort that performed a write action in week 0..N after joining. */
export async function retention(ctx: AppContext, weeks: number) {
  const { rows } = await ctx.db.query(
    `WITH cur AS (SELECT date_trunc('week', now() AT TIME ZONE 'UTC') AS wk),
          cohort AS (
            SELECT u.id, date_trunc('week', u.created_at AT TIME ZONE 'UTC') AS wk
              FROM users u, cur WHERE u.status <> 'deleted' AND u.created_at AT TIME ZONE 'UTC' >= cur.wk - make_interval(weeks => $1)),
          a AS (${WRITE_ACTIONS(`(((SELECT wk FROM cur) - make_interval(weeks => ${weeks})) AT TIME ZONE 'UTC')`)}),
          hits AS (
            SELECT c.wk, ((extract(epoch FROM date_trunc('week', a.created_at AT TIME ZONE 'UTC') - c.wk)) / 604800)::int AS k, count(DISTINCT c.id)::int AS n
              FROM cohort c JOIN a ON a.user_id = c.id AND a.created_at AT TIME ZONE 'UTC' >= c.wk GROUP BY 1, 2),
          sizes AS (SELECT wk, count(*)::int AS size FROM cohort GROUP BY 1)
     SELECT to_char(s.wk, 'YYYY-MM-DD') AS cohort_week, s.size, COALESCE(json_agg(json_build_object('week', h.k, 'active', h.n) ORDER BY h.k) FILTER (WHERE h.k IS NOT NULL), '[]') AS hits,
            (extract(epoch FROM ((SELECT wk FROM cur) - s.wk)) / 604800)::int AS age_weeks
       FROM sizes s LEFT JOIN hits h ON h.wk = s.wk GROUP BY s.wk, s.size ORDER BY s.wk`,
    [weeks],
  );
  return {
    definition:
      'Cohort = accounts created in a UTC week. Retained in week k = performed a write action during the k-th week after the cohort week (week 0 is the signup week).',
    minCell: MIN_CELL,
    cohorts: rows.map((r) => {
      const ageWeeks = Number(r.age_weeks);
      const size = Number(r.size);
      const hits = new Map<number, number>(
        (r.hits as Array<{ week: number; active: number }>).map((h) => [h.week, h.active]),
      );
      const out: Array<{ week: number; retained: number | null; rate: number | null }> = [];
      const last = Math.max(0, Math.min(weeks, ageWeeks));
      for (let k = 0; k <= last; k++) {
        const n = hits.get(k) ?? 0;
        const hide = size < MIN_CELL || (n > 0 && n < MIN_CELL);
        out.push({
          week: k,
          retained: hide ? null : n,
          rate: hide ? null : Number((n / size).toFixed(3)),
        });
      }
      return { cohortWeek: r.cohort_week as string, size: suppress(size), weeks: out };
    }),
  };
}

/** MSA totals and Meaningful Weekly Participants for the last `weeks` trailing-7-day windows (the newest ends today). */
export async function msa(ctx: AppContext, weeks: number) {
  const windows: Array<{
    windowEnd: string;
    windowStart: string;
    participants: number | null;
    mwp: number | null;
    mwpShare: number | null;
    actionsByType: Record<string, number | null>;
  }> = [];
  const now = new Date();
  const tomorrow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  for (let i = 0; i < weeks; i++) {
    const endMs = tomorrow - i * MWP_WINDOW_DAYS * 86_400_000;
    const startMs = endMs - MWP_WINDOW_DAYS * 86_400_000;
    const q = await ctx.db.query(
      `${MSA_CAPPED_SQL},
       per_user AS (SELECT user_id, sum(n)::int AS total, count(DISTINCT day)::int AS days FROM capped GROUP BY user_id),
       by_type AS (SELECT type, sum(n)::int AS n FROM capped GROUP BY type)
       SELECT (SELECT count(*)::int FROM per_user) AS participants,
              (SELECT count(*)::int FROM per_user WHERE total >= ${MWP_MIN_ACTIONS} AND days >= ${MWP_MIN_DAYS}) AS mwp,
              (SELECT COALESCE(json_object_agg(type, n), '{}') FROM by_type) AS by_type`,
      [new Date(startMs).toISOString(), new Date(endMs).toISOString()],
    );
    const r = q.rows[0] as { participants: number; mwp: number; by_type: Record<string, number> };
    const end = new Date(endMs - 86_400_000).toISOString().slice(0, 10);
    const start = new Date(startMs).toISOString().slice(0, 10);
    windows.push({
      windowStart: start,
      windowEnd: end,
      participants: suppress(r.participants),
      mwp: suppress(r.mwp),
      mwpShare:
        r.participants >= MIN_CELL && r.mwp >= MIN_CELL
          ? Number((r.mwp / r.participants).toFixed(3))
          : null,
      actionsByType: Object.fromEntries(
        ['message', 'comment', 'post', 'plan'].map((t) => [t, suppress(r.by_type[t] ?? 0)]),
      ),
    });
  }
  return {
    definition: {
      msa: "A message to another member, a comment on someone else's post, a public/limited (non-private) post, or a plan (RSVP going/attended to someone else's event, or hosting a published event). All must be moderation-approved and not deleted.",
      notMsa: [
        'reactions',
        'follows',
        'saves',
        'views',
        'shares',
        'searches',
        'notification opens',
        'time spent',
      ],
      dailyCapPerUserPerType: { message: 10, comment: 10, post: 5, plan: 5 },
      meaningfulWeeklyParticipant: `at least ${MWP_MIN_ACTIONS} capped MSA on at least ${MWP_MIN_DAYS} distinct UTC days in the trailing ${MWP_WINDOW_DAYS} days`,
    },
    minCell: MIN_CELL,
    windows,
  };
}

export async function creators(ctx: AppContext, days: number) {
  const [status, subs, tips] = await Promise.all([
    ctx.db.query(
      `SELECT status, kyc_status, count(*)::int AS creators FROM creators GROUP BY 1, 2 ORDER BY 1, 2`,
    ),
    ctx.db.query(
      `SELECT status, count(*)::int AS subscriptions FROM subscriptions GROUP BY 1 ORDER BY 1`,
    ),
    ctx.db.query(
      `SELECT currency, count(*)::int AS tips, count(DISTINCT creator_id)::int AS creators, COALESCE(sum(amount_cents),0)::bigint AS amount_cents
         FROM tips WHERE created_at >= ${DAY_END} - make_interval(days => $1) GROUP BY 1 ORDER BY 1`,
      [days],
    ),
  ]);
  return {
    periodDays: days,
    creatorsByStatus: suppressRows(status.rows, 'creators'),
    subscriptionsByStatus: suppressRows(subs.rows, 'subscriptions'),
    tips: suppressRows(tips.rows, 'tips', ['creators', 'amount_cents']),
  };
}

export async function commerce(ctx: AppContext, days: number) {
  const [orders, gmv] = await Promise.all([
    ctx.db.query(
      `SELECT status, count(*)::int AS orders FROM orders WHERE created_at >= ${DAY_END} - make_interval(days => $1) GROUP BY 1 ORDER BY 1`,
      [days],
    ),
    ctx.db.query(
      `SELECT currency, count(*)::int AS orders, COALESCE(sum(total_cents),0)::bigint AS total_cents FROM orders
        WHERE created_at >= ${DAY_END} - make_interval(days => $1) AND status IN ('paid','fulfilled','completed') GROUP BY 1 ORDER BY 1`,
      [days],
    ),
  ]);
  return {
    periodDays: days,
    ordersByStatus: suppressRows(orders.rows, 'orders'),
    paidOrders: suppressRows(gmv.rows, 'orders', ['total_cents']),
  };
}

export async function safety(ctx: AppContext, days: number) {
  const since = `${DAY_END} - make_interval(days => $1)`;
  const [reports, cases, ttd, appeals, enforcements] = await Promise.all([
    ctx.db.query(
      `SELECT reason, status, count(*)::int AS reports FROM reports WHERE created_at >= ${since} GROUP BY 1, 2 ORDER BY reports DESC`,
      [days],
    ),
    ctx.db.query(
      `SELECT source, state, count(*)::int AS cases FROM moderation_cases WHERE created_at >= ${since} GROUP BY 1, 2 ORDER BY cases DESC`,
      [days],
    ),
    ctx.db.query(
      `SELECT count(*)::int AS decided, percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (decided_at - created_at)) / 3600) AS median_hours
         FROM moderation_cases WHERE decided_at IS NOT NULL AND created_at >= ${since}`,
      [days],
    ),
    ctx.db.query(
      `SELECT status, count(*)::int AS appeals FROM appeals WHERE created_at >= ${since} GROUP BY 1 ORDER BY 1`,
      [days],
    ),
    ctx.db.query(
      `SELECT kind, count(*)::int AS enforcements FROM enforcements WHERE created_at >= ${since} GROUP BY 1 ORDER BY enforcements DESC`,
      [days],
    ),
  ]);
  const t = ttd.rows[0] as { decided: number; median_hours: number | null };
  return {
    periodDays: days,
    reports: suppressRows(reports.rows, 'reports'),
    cases: suppressRows(cases.rows, 'cases'),
    timeToDecision: {
      decided: suppress(t.decided),
      medianHours:
        t.decided >= MIN_CELL && t.median_hours !== null
          ? Number(Number(t.median_hours).toFixed(2))
          : null,
    },
    appeals: suppressRows(appeals.rows, 'appeals'),
    enforcements: suppressRows(enforcements.rows, 'enforcements'),
  };
}

export async function technical(ctx: AppContext, days: number) {
  const since = `${DAY_END} - make_interval(days => $1)`;
  const [vitals, errors, volume] = await Promise.all([
    ctx.db.query(
      `SELECT properties->>'metric' AS metric, COALESCE(platform,'unknown') AS platform, count(*)::int AS samples,
              percentile_cont(0.75) WITHIN GROUP (ORDER BY (properties->>'value')::float8) AS p75
         FROM analytics_events WHERE name = 'web_vital' AND created_at >= ${since} GROUP BY 1, 2 ORDER BY 1, 2`,
      [days],
    ),
    ctx.db.query(
      `SELECT properties->>'code' AS code, properties->>'screen' AS screen, count(*)::int AS errors
         FROM analytics_events WHERE name = 'client_error' AND created_at >= ${since} GROUP BY 1, 2 ORDER BY errors DESC LIMIT 50`,
      [days],
    ),
    ctx.db.query(
      `SELECT to_char((created_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day, source, count(*)::int AS events
         FROM analytics_events WHERE created_at >= ${since} GROUP BY 1, 2 ORDER BY 1, 2`,
      [days],
    ),
  ]);
  return {
    periodDays: days,
    basis: 'consented client events only',
    webVitalsP75: suppressRows(
      vitals.rows.map((r) => ({
        ...r,
        p75: r.p75 === null ? null : Number(Number(r.p75).toFixed(3)),
      })),
      'samples',
      ['p75'],
    ),
    clientErrors: suppressRows(errors.rows, 'errors'),
    eventVolume: volume.rows,
  };
}
