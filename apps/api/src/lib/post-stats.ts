import type { Pool, PoolClient } from 'pg';

type Q = Pool | PoolClient;

/**
 * Counts per post for ranking (post_stats), kept up to date as things happen: feed events, saves,
 * shares and reposts. Likes and comments stay on the post itself (like_count, comment_count).
 *
 * `trend` is the post's engagement momentum: each engagement adds its weight and the sum fades by
 * e every TREND.fadeHours, so it says how much is happening now rather than in total.
 */
export const TREND = {
  fadeHours: 6,
  weights: { like: 1, comment: 2, save: 3, share: 3, complete: 2 },
} as const;

export interface StatDelta {
  postId: string;
  impressions?: number;
  viewers?: number;
  dwellMs?: number;
  watchMs?: number;
  completes?: number;
  skips?: number;
  shares?: number;
  /** Shares people see: sent to a chat, through the share sheet or as a copied link (not reposts). */
  sends?: number;
  saves?: number;
  /** Yaps: listens started, time listened and listens to the end. */
  listens?: number;
  listenMs?: number;
  listenCompletes?: number;
  /** Momentum to add (TREND.weights). */
  trend?: number;
}

/** A post's momentum as of `at` (SQL), from post_stats aliased `ps`; 0 without a row. */
export const trendSql = (at: string) => `coalesce(ps.trend * exp(-greatest(0, extract(epoch FROM (${at} - ps.trend_at))) / 3600.0 / ${TREND.fadeHours}), 0)`;

const COLS = [
  'impressions',
  'viewers',
  'dwell_ms',
  'watch_ms',
  'completes',
  'skips',
  'shares',
  'sends',
  'saves',
  'listens',
  'listen_ms',
  'listen_completes',
] as const;
const FIELD: Record<(typeof COLS)[number], keyof StatDelta> = {
  impressions: 'impressions',
  viewers: 'viewers',
  dwell_ms: 'dwellMs',
  watch_ms: 'watchMs',
  completes: 'completes',
  skips: 'skips',
  shares: 'shares',
  sends: 'sends',
  saves: 'saves',
  listens: 'listens',
  listen_ms: 'listenMs',
  listen_completes: 'listenCompletes',
};

/** Add to the counts of one or more posts (negative numbers take away, never below 0). Posts that are gone are skipped. */
export async function bumpStats(db: Q, deltas: StatDelta[]): Promise<void> {
  const byPost = new Map<string, StatDelta>();
  for (const d of deltas) {
    const s = byPost.get(d.postId) ?? { postId: d.postId };
    for (const c of COLS) {
      const f = FIELD[c];
      (s[f] as number | undefined) = ((s[f] as number | undefined) ?? 0) + ((d[f] as number | undefined) ?? 0);
    }
    s.trend = (s.trend ?? 0) + (d.trend ?? 0);
    byPost.set(d.postId, s);
  }
  const rows = [...byPost.values()];
  if (!rows.length) return;
  const arrays = COLS.map((c) => rows.map((r) => Math.round((r[FIELD[c]] as number | undefined) ?? 0)));
  const ids = rows.map((r) => r.postId);
  // A row for each post first (posts that are gone get none), then add: the counts can go down too.
  await db.query(`INSERT INTO post_stats (post_id) SELECT p.id FROM posts p WHERE p.id = ANY($1::uuid[]) ON CONFLICT (post_id) DO NOTHING`, [ids]);
  const fade = `exp(-greatest(0, extract(epoch FROM (now() - ps.trend_at))) / 3600.0 / ${TREND.fadeHours})`;
  await db.query(
    `UPDATE post_stats ps SET
       ${COLS.map((c) => `${c} = greatest(0, ps.${c} + x.${c})`).join(',\n       ')},
       trend = CASE WHEN x.trend > 0 THEN coalesce(ps.trend * ${fade}, 0) + x.trend ELSE ps.trend END,
       trend_at = CASE WHEN x.trend > 0 THEN now() ELSE ps.trend_at END,
       updated_at = now()
     FROM unnest($1::uuid[], ${COLS.map((_, i) => `$${i + 2}::bigint[]`).join(', ')}, $${COLS.length + 2}::real[])
       AS x(post_id, ${COLS.join(', ')}, trend)
     WHERE ps.post_id = x.post_id`,
    [ids, ...arrays, rows.map((r) => r.trend ?? 0)],
  );
}
