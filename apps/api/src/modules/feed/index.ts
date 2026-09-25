import { z } from 'zod';
import {
  clampLimit,
  decodeCursor,
  encodeCursor,
  forbidden,
  invalid,
  notFound,
} from '@yapilapi/shared';
import { rank, type Candidate } from '@yapilapi/recommendations';
import { route } from '../../lib/route.js';
import { loadVisiblePost, postVisibleSql } from '../../lib/visibility.js';
import { hydratePosts, postFrom, postSelect, type PostView } from '../../lib/post-view.js';
import type { AppContext } from '../../lib/context.js';
import type { ApiModule } from '../types.js';

const V = '$1::uuid';
const MODES = ['for_you', 'following', 'friends', 'communities', 'local', 'custom'] as const;

const feedQuery = z.object({
  mode: z.enum(MODES).default('for_you'),
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  radiusKm: z.coerce.number().min(1).max(200).default(25),
  circleId: z.uuid().optional(),
  topics: z.string().max(400).optional(), // comma-separated topic slugs
});

/** Things a viewer never wants in any feed: blocked/muted users, hidden creators, muted topics, "not interested". */
const EXCLUSIONS = `
  AND NOT EXISTS (SELECT 1 FROM user_mutes um WHERE um.muter_id = ${V} AND um.muted_id = p.author_id)
  AND NOT EXISTS (SELECT 1 FROM recommendation_feedback rf WHERE rf.user_id = ${V} AND ((rf.signal = 'not_interested' AND rf.post_id = p.id) OR (rf.signal = 'hide_creator' AND rf.creator_id = p.author_id)))
  AND NOT EXISTS (SELECT 1 FROM post_topics pt JOIN topic_mutes tm ON tm.topic_id = pt.topic_id AND tm.user_id = ${V} WHERE pt.post_id = p.id)`;

type ChronoCursor = { t: string; id: string };
type RankCursor = { snap: string; off: number };

function haversineSql(
  latParam: string,
  lngParam: string,
  lat = 'COALESCE(p.latitude, pl.latitude)',
  lng = 'COALESCE(p.longitude, pl.longitude)',
) {
  return `(6371 * acos(LEAST(1, GREATEST(-1, cos(radians(${latParam})) * cos(radians(${lat})) * cos(radians(${lng}) - radians(${lngParam})) + sin(radians(${latParam})) * sin(radians(${lat}))))))`;
}

async function forYouCandidates(
  ctx: AppContext,
  viewerId: string | null,
  snapshot: Date,
  onlyPostId?: string,
): Promise<Candidate[]> {
  const base = `
    SELECT p.id, p.author_id, pr.username AS author_username,
           EXTRACT(EPOCH FROM ($2::timestamptz - p.created_at)) / 3600.0 AS age_hours,
           p.like_count, p.comment_count, p.share_count, p.save_count,
           EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = ${V} AND f.followee_id = p.author_id AND f.status = 'active') AS is_following,
           EXISTS (SELECT 1 FROM friendships fr WHERE fr.user_low = LEAST(${V}, p.author_id) AND fr.user_high = GREATEST(${V}, p.author_id) AND fr.status = 'accepted') AS is_friend,
           (p.community_id IS NOT NULL AND EXISTS (SELECT 1 FROM community_members cm WHERE cm.community_id = p.community_id AND cm.user_id = ${V} AND cm.status = 'active')) AS in_my_community,
           COALESCE((SELECT array_agg(DISTINCT t.name) FROM post_topics pt JOIN topics t ON t.id = pt.topic_id
                      WHERE pt.post_id = p.id AND (
                        EXISTS (SELECT 1 FROM user_interests ui WHERE ui.user_id = ${V} AND ui.topic_id = pt.topic_id)
                        OR EXISTS (SELECT 1 FROM user_topic_affinity ta WHERE ta.user_id = ${V} AND ta.topic_id = pt.topic_id AND ta.score >= 1)
                      )), '{}') AS matched_topics,
           EXISTS (SELECT 1 FROM recommendation_feedback rf WHERE rf.user_id = ${V} AND rf.signal = 'less_like_this' AND rf.creator_id = p.author_id) AS less_like_this
      FROM posts p JOIN profiles pr ON pr.user_id = p.author_id
     WHERE ${postVisibleSql(V)} ${EXCLUSIONS}
       AND p.created_at <= $2 AND p.created_at > $2::timestamptz - interval '14 days'
       AND (${V} IS NULL OR p.author_id <> ${V})`;
  const rows = onlyPostId
    ? (await ctx.db.query(`${base} AND p.id = $3`, [viewerId, snapshot, onlyPostId])).rows
    : [
        ...(
          await ctx.db.query(`${base} ORDER BY p.created_at DESC LIMIT 300`, [viewerId, snapshot])
        ).rows,
        ...(
          await ctx.db.query(
            `${base} ORDER BY (p.like_count + 2 * p.comment_count + 3 * p.share_count) DESC, p.created_at DESC LIMIT 100`,
            [viewerId, snapshot],
          )
        ).rows,
      ];
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({
      id: r.id,
      authorId: r.author_id,
      authorUsername: r.author_username,
      ageHours: Number(r.age_hours),
      likeCount: r.like_count,
      commentCount: r.comment_count,
      shareCount: r.share_count,
      saveCount: r.save_count,
      isFollowing: r.is_following,
      isFriend: r.is_friend,
      inMyCommunity: r.in_my_community,
      matchedTopics: r.matched_topics ?? [],
      lessLikeThisAuthor: r.less_like_this,
    });
  }
  return out;
}

export const feedModule: ApiModule = {
  name: 'feed',
  register(app, ctx) {
    route(app, ctx, {
      method: 'GET',
      url: '/v1/feed',
      summary: 'Home feed (For You, Following, Friends, Communities, Local, Custom)',
      tags: ['feed'],
      auth: 'optional',
      query: feedQuery,
      handler: async ({ auth, query }) => {
        const viewer = auth?.userId ?? null;
        const limit = clampLimit(query.limit);

        // ---------------------------------------------------------------- personalised ranking
        if (query.mode === 'for_you') {
          const cur = decodeCursor<RankCursor>(query.cursor);
          const snapshot = cur ? new Date(cur.snap) : new Date();
          const offset = cur?.off ?? 0;
          // Respect the user's opt-out of personalization: fall back to reverse-chronological public content.
          const pref = viewer
            ? await ctx.db.query<{ personalization: boolean }>(
                'SELECT personalization FROM user_preferences WHERE user_id = $1',
                [viewer],
              )
            : null;
          const personalize = pref?.rows[0]?.personalization ?? true;
          let ranked = rank(await forYouCandidates(ctx, viewer, snapshot));
          if (!personalize) ranked = [...ranked].sort((a, b) => a.ageHours - b.ageHours);
          const pageRank = ranked.slice(offset, offset + limit);
          const ids = pageRank.map((r) => r.id);
          const { rows } = ids.length
            ? await ctx.db.query(
                `SELECT ${postSelect(V)} FROM ${postFrom} WHERE p.id = ANY($2::uuid[])`,
                [viewer, ids],
              )
            : { rows: [] };
          const views = await hydratePosts(ctx, viewer, rows);
          const byId = new Map(views.map((v) => [v.id, v]));
          const items: PostView[] = [];
          for (const r of pageRank) {
            const v = byId.get(r.id);
            if (v) items.push({ ...v, reasons: personalize ? r.reasons : ['Recent'] });
          }
          const next = offset + limit;
          return {
            mode: 'for_you',
            items,
            nextCursor:
              next < ranked.length
                ? encodeCursor({ snap: snapshot.toISOString(), off: next })
                : null,
          };
        }

        // ---------------------------------------------------------------- chronological modes
        if (!viewer && query.mode !== 'local') throw forbidden('Sign in to see this feed');
        const cur = decodeCursor<ChronoCursor>(query.cursor);
        const params: unknown[] = [viewer, cur?.t ?? null, cur?.id ?? null, limit + 1];
        let extra = '';
        let join = '';
        if (query.mode === 'following') {
          extra = `AND (p.author_id = ${V} OR p.author_id IN (SELECT followee_id FROM follows WHERE follower_id = ${V} AND status = 'active'))`;
        } else if (query.mode === 'friends') {
          extra = `AND p.author_id IN (SELECT CASE WHEN user_low = ${V} THEN user_high ELSE user_low END FROM friendships WHERE (user_low = ${V} OR user_high = ${V}) AND status = 'accepted')`;
        } else if (query.mode === 'communities') {
          extra = `AND p.community_id IN (SELECT community_id FROM community_members WHERE user_id = ${V} AND status = 'active')`;
        } else if (query.mode === 'local') {
          if (query.lat === undefined || query.lng === undefined)
            throw invalid('lat and lng are required for the local feed');
          params.push(query.lat, query.lng, query.radiusKm);
          join = 'LEFT JOIN places pl ON pl.id = p.place_id';
          extra = `AND COALESCE(p.latitude, pl.latitude) IS NOT NULL AND ${haversineSql('$5', '$6')} <= $7`;
        } else if (query.mode === 'custom') {
          if (!query.circleId && !query.topics)
            throw invalid('Custom feeds need circleId and/or topics');
          if (query.circleId) {
            const own = await ctx.db.query(
              'SELECT 1 FROM circles WHERE id = $1 AND owner_id = $2',
              [query.circleId, viewer],
            );
            if (!own.rowCount) throw notFound('Circle');
            params.push(query.circleId);
            extra += ` AND p.author_id IN (SELECT user_id FROM circle_members WHERE circle_id = $${params.length})`;
          }
          if (query.topics) {
            params.push(
              query.topics
                .split(',')
                .map((s) => s.trim().toLowerCase())
                .filter(Boolean)
                .slice(0, 10),
            );
            extra += ` AND EXISTS (SELECT 1 FROM post_topics pt JOIN topics t ON t.id = pt.topic_id WHERE pt.post_id = p.id AND t.slug = ANY($${params.length}::citext[]))`;
          }
        }
        const { rows } = await ctx.db.query(
          `SELECT ${postSelect(V)} FROM ${postFrom} ${join}
            WHERE ${postVisibleSql(V)} ${EXCLUSIONS} ${extra}
              AND ($2::timestamptz IS NULL OR (p.created_at, p.id) < ($2::timestamptz, $3::uuid))
            ORDER BY p.created_at DESC, p.id DESC LIMIT $4`,
          params,
        );
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          mode: query.mode,
          items: await hydratePosts(ctx, viewer, page),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ t: (last.created_at as Date).toISOString(), id: last.id })
              : null,
        };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/feed/explain/:postId',
      summary: 'Why am I seeing this post?',
      tags: ['feed'],
      auth: 'user',
      params: z.object({ postId: z.uuid() }),
      handler: async ({ auth, params }) => {
        if (!(await loadVisiblePost(ctx.db, auth.userId, params.postId))) throw notFound('Post');
        const [cand] = await forYouCandidates(ctx, auth.userId, new Date(), params.postId);
        if (!cand)
          return {
            reasons: ['You can see this post because of its audience settings.'],
            controls: ['not_interested', 'less_like_this', 'mute_creator'],
          };
        const [r] = rank([cand]);
        return {
          reasons: r!.reasons,
          controls: [
            'more_like_this',
            'less_like_this',
            'not_interested',
            'mute_creator',
            'mute_topic',
          ],
        };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/feed/feedback',
      summary: 'Tell YAPILAPI what you want more or less of',
      tags: ['feed'],
      auth: 'user',
      body: z.object({
        postId: z.uuid(),
        signal: z.enum(['more_like_this', 'less_like_this', 'not_interested', 'hide_creator']),
      }),
      rateLimit: { limit: 200, windowSec: 600, by: 'user' },
      handler: async ({ auth, body, reply }) => {
        const post = await loadVisiblePost<{ author_id: string }>(ctx.db, auth.userId, body.postId);
        if (!post) throw notFound('Post');
        await ctx.db.query(
          `INSERT INTO recommendation_feedback (user_id, post_id, creator_id, signal) VALUES ($1,$2,$3,$4)`,
          [auth.userId, body.postId, post.author_id, body.signal],
        );
        if (body.signal === 'more_like_this' || body.signal === 'less_like_this') {
          const delta = body.signal === 'more_like_this' ? 0.5 : -0.5;
          await ctx.db.query(
            `INSERT INTO user_topic_affinity (user_id, topic_id, score) SELECT $1, pt.topic_id, $3 FROM post_topics pt WHERE pt.post_id = $2
             ON CONFLICT (user_id, topic_id) DO UPDATE SET score = LEAST(GREATEST(user_topic_affinity.score + EXCLUDED.score, -5), 5), updated_at = now()`,
            [auth.userId, body.postId, delta],
          );
        }
        void reply.code(201);
        return { recorded: true };
      },
    });

    route(app, ctx, {
      method: 'PUT',
      url: '/v1/topics/:slug/mute',
      summary: 'Mute a topic in your feeds',
      tags: ['feed'],
      auth: 'user',
      params: z.object({ slug: z.string().min(1).max(50) }),
      handler: async ({ auth, params }) => {
        const r = await ctx.db.query(
          `INSERT INTO topic_mutes (user_id, topic_id) SELECT $1, id FROM topics WHERE slug = $2 ON CONFLICT DO NOTHING`,
          [auth.userId, params.slug.toLowerCase()],
        );
        const t = await ctx.db.query('SELECT 1 FROM topics WHERE slug = $1', [
          params.slug.toLowerCase(),
        ]);
        if (!t.rowCount) throw notFound('Topic');
        void r;
        return { muted: true };
      },
    });
    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/topics/:slug/mute',
      summary: 'Unmute a topic',
      tags: ['feed'],
      auth: 'user',
      params: z.object({ slug: z.string().min(1).max(50) }),
      handler: async ({ auth, params }) => {
        await ctx.db.query(
          `DELETE FROM topic_mutes tm USING topics t WHERE t.id = tm.topic_id AND tm.user_id = $1 AND t.slug = $2`,
          [auth.userId, params.slug.toLowerCase()],
        );
      },
    });
  },
};
