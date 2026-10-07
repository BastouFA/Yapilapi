import type { FastifyInstance } from 'fastify';
import { feedEventsSchema, type FeedEventKind } from '@yapilapi/shared';
import { parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { AFFINITY, learn, type Learning } from '../lib/affinity.ts';
import { bumpStats, TREND, type StatDelta } from '../lib/post-stats.ts';
import { personalizationAllowed } from '../lib/services.ts';
import { postVisibleSql } from '../lib/visibility.ts';
import { me, requireAuth } from '../plugins/auth.ts';

/** How the apps' feed events are kept honest (docs/product/recommendations.md). */
export const FEED_EVENT_RULES = {
  /** An impression, finish, skip, share or profile visit counts once per person, post and surface in this many minutes. */
  dedupeMinutes: 30,
  /** Time on screen counts up to a minute per event (a phone left on a post isn't a minute more of interest). */
  dwellCapMs: 60_000,
  /** Time watched counts up to three plays of the video, and ten minutes at most. */
  watchCapMs: 600_000,
  watchCapPlays: 3,
} as const;

const ONCE: FeedEventKind[] = ['impression', 'complete', 'skip', 'share', 'profile_open'];

/**
 * What happened to posts on screen, from the apps (lib/feed-events.ts on the web and the phone):
 * seen, how long, watched, finished, skipped, shared, the author's profile opened. Posts you can't
 * see and your own posts are ignored. Every event counts in the post's numbers (post_stats); what
 * you seem to like is learned from them only with Personalization on (lib/affinity.ts).
 */
export default async function recommendationsModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;

  app.post('/v1/feed/events', { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { events } = parse(feedEventsSchema, req.body);
    const ids = [...new Set(events.map((e) => e.postId))];
    const { rows } = await db.query<{ id: string; author_id: string; topics: string[]; duration_ms: number | null }>(
      `SELECT p.id, p.author_id, p.topics,
              (SELECT m.duration_ms FROM post_media pm JOIN media m ON m.id = pm.media_id WHERE pm.post_id = p.id AND m.kind = 'video' ORDER BY pm.position LIMIT 1) AS duration_ms
       FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
       WHERE p.id = ANY($2::uuid[]) AND p.author_id <> $1 AND ${postVisibleSql('$1')}`,
      [u.id, ids],
    );
    const posts = new Map(rows.map((r) => [r.id, r]));
    if (!posts.size) return { accepted: 0 };
    // What was already counted in the last half hour, and which posts this person had ever seen.
    const [recent, seenBefore] = await Promise.all([
      db.query<{ post_id: string; surface: string; kind: string }>(
        `SELECT DISTINCT post_id, surface, kind FROM feed_events
         WHERE user_id = $1 AND post_id = ANY($2::uuid[]) AND kind = ANY($3::text[]) AND created_at > now() - make_interval(mins => $4)`,
        [u.id, [...posts.keys()], ONCE, FEED_EVENT_RULES.dedupeMinutes],
      ),
      db.query<{ post_id: string }>(`SELECT DISTINCT post_id FROM feed_events WHERE user_id = $1 AND post_id = ANY($2::uuid[]) AND kind = 'impression'`, [
        u.id,
        [...posts.keys()],
      ]),
    ]);
    const counted = new Set(recent.rows.map((r) => `${r.post_id}:${r.surface}:${r.kind}`));
    const viewed = new Set(seenBefore.rows.map((r) => r.post_id));

    const kept: { postId: string; surface: string; kind: FeedEventKind; valueMs: number | null }[] = [];
    const stats: StatDelta[] = [];
    const learned: Learning[] = [];
    for (const e of events) {
      const p = posts.get(e.postId);
      if (!p) continue;
      let valueMs: number | null = null;
      if (ONCE.includes(e.kind)) {
        const key = `${e.postId}:${e.surface}:${e.kind}`;
        if (counted.has(key)) continue;
        counted.add(key);
      } else {
        // Dwell and watch need a time; they add up.
        if (e.valueMs === undefined) continue;
        const cap =
          e.kind === 'dwell'
            ? FEED_EVENT_RULES.dwellCapMs
            : Math.min(FEED_EVENT_RULES.watchCapMs, p.duration_ms ? p.duration_ms * FEED_EVENT_RULES.watchCapPlays : FEED_EVENT_RULES.watchCapMs);
        valueMs = Math.min(e.valueMs, cap);
      }
      kept.push({ postId: e.postId, surface: e.surface, kind: e.kind, valueMs });
      const about = { authorId: p.author_id, topics: p.topics };
      switch (e.kind) {
        case 'impression':
          stats.push({ postId: p.id, impressions: 1, viewers: viewed.has(p.id) ? 0 : 1 });
          viewed.add(p.id);
          break;
        case 'dwell':
          stats.push({ postId: p.id, dwellMs: valueMs! });
          if (valueMs! >= AFFINITY.dwellMs) learned.push({ signal: 'dwell', ...about });
          break;
        case 'watch': {
          stats.push({ postId: p.id, watchMs: valueMs! });
          const enough = p.duration_ms ? valueMs! >= p.duration_ms * AFFINITY.watchShare : valueMs! >= AFFINITY.dwellMs;
          if (enough) learned.push({ signal: 'watch', ...about });
          break;
        }
        case 'complete':
          stats.push({ postId: p.id, completes: 1, trend: TREND.weights.complete });
          learned.push({ signal: 'complete', ...about });
          break;
        case 'skip':
          stats.push({ postId: p.id, skips: 1 });
          learned.push({ signal: 'skip', ...about });
          break;
        case 'share':
          stats.push({ postId: p.id, shares: 1, trend: TREND.weights.share });
          learned.push({ signal: 'share', ...about });
          break;
        case 'profile_open':
          learned.push({ signal: 'profile_open', ...about });
          break;
      }
    }
    if (!kept.length) return { accepted: 0 };
    await db.query(
      `INSERT INTO feed_events (user_id, post_id, surface, kind, value_ms)
       SELECT $1, x.post_id, x.surface, x.kind, x.value_ms FROM unnest($2::uuid[], $3::text[], $4::text[], $5::int[]) AS x(post_id, surface, kind, value_ms)`,
      [u.id, kept.map((k) => k.postId), kept.map((k) => k.surface), kept.map((k) => k.kind), kept.map((k) => k.valueMs)],
    );
    await bumpStats(db, stats);
    // The post's numbers count for everyone; what you like is only learned with Personalization on.
    await learn(db, u.id, learned, await personalizationAllowed(db, u.id));
    return { accepted: kept.length };
  });
}
