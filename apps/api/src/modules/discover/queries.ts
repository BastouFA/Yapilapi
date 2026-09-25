import { boundingBox, haversineKm, haversineSql } from '@yapilapi/search';
import type { AppContext } from '../../lib/context.js';
import { hydratePosts, postFrom, postSelect, type PostView } from '../../lib/post-view.js';
import { topicsFor } from '../communities/service.js';
import {
  businessVisibleSql,
  communityVisibleSql,
  eventVisibleSql,
  followsSql,
  notBlockedSql,
  personVisibleSql,
  postSearchVisibleSql,
  productVisibleSql,
  teenAllowedSql,
  activeUserSql,
} from '../search/guards.js';
import { PERSON_SELECT, personItem } from '../search/views.js';
import {
  P,
  alreadyConnectedSql,
  clip,
  keysetScore,
  listNames,
  notMutedOrHiddenSql,
  roundScore,
  scoreCursorFor,
  type ScoreCursor,
} from './sql.js';
import type { DbRow } from '../../lib/db-row.js';

type Row = DbRow;
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Aggregates about groups of people are only shown when at least this many distinct people are behind them. */
export const K_ANONYMITY = 5;
/** A topic only "trends" when at least this many different people are posting about it (anti-manipulation). */
export const TRENDING_MIN_AUTHORS = 2;

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
const V0 = (p: P, viewerId: string | null) => `${p.add(viewerId)}::uuid`;

// ------------------------------------------------------------------ viewer signals
export interface ViewerSignals {
  personalization: boolean;
  ageBand: 'teen' | 'adult' | null;
  timezone: string;
  interests: Array<{ slug: string; name: string }>;
}

/** Interests + opt-out state. With personalization off nothing derived from the viewer's behaviour is used. */
export async function viewerSignals(
  ctx: AppContext,
  userId: string | null,
): Promise<ViewerSignals> {
  if (!userId) return { personalization: false, ageBand: null, timezone: 'UTC', interests: [] };
  const { rows } = await ctx.db.query<{
    personalization: boolean | null;
    age_band: 'teen' | 'adult';
    timezone: string;
  }>(
    `SELECT up.personalization, u.age_band, u.timezone FROM users u LEFT JOIN user_preferences up ON up.user_id = u.id WHERE u.id = $1`,
    [userId],
  );
  const r = rows[0];
  const personalization = r?.personalization ?? true;
  let interests: ViewerSignals['interests'] = [];
  if (personalization) {
    const i = await ctx.db.query<{ slug: string; name: string }>(
      `SELECT t.slug::text AS slug, t.name FROM topics t WHERE t.id IN (
         SELECT topic_id FROM user_interests WHERE user_id = $1
         UNION SELECT topic_id FROM user_topic_affinity WHERE user_id = $1 AND score >= 1)
       AND NOT EXISTS (SELECT 1 FROM topic_mutes tm WHERE tm.user_id = $1 AND tm.topic_id = t.id) ORDER BY t.name LIMIT 40`,
      [userId],
    );
    interests = i.rows;
  }
  return {
    personalization,
    ageBand: r?.age_band ?? null,
    timezone: r?.timezone ?? 'UTC',
    interests,
  };
}

// ------------------------------------------------------------------ trending
const ACTIONS = (since: string, snap: string) => `
  actions AS (
    SELECT DISTINCT ON (post_id, actor) post_id, actor, w FROM (
      SELECT r.target_id AS post_id, r.user_id AS actor, 1.0 AS w FROM reactions r WHERE r.target_type = 'post' AND r.created_at >= ${since}::timestamptz AND r.created_at <= ${snap}::timestamptz
      UNION ALL SELECT c.post_id, c.author_id, 2.0 FROM comments c WHERE c.deleted_at IS NULL AND c.moderation_status = 'approved' AND c.created_at >= ${since}::timestamptz AND c.created_at <= ${snap}::timestamptz
      UNION ALL SELECT sh.post_id, sh.user_id, 3.0 FROM shares sh WHERE sh.created_at >= ${since}::timestamptz AND sh.created_at <= ${snap}::timestamptz
      UNION ALL SELECT s.target_id, s.user_id, 2.0 FROM saves s WHERE s.target_type = 'post' AND s.created_at >= ${since}::timestamptz AND s.created_at <= ${snap}::timestamptz
    ) a ORDER BY post_id, actor, w DESC
  ),
  eng AS (SELECT post_id, sum(w) AS w, count(*) AS actors FROM actions GROUP BY post_id)`;

const FEED_EXCLUSIONS = (V: string) => `
  AND NOT EXISTS (SELECT 1 FROM user_mutes um WHERE um.muter_id = ${V} AND um.muted_id = p.author_id)
  AND NOT EXISTS (SELECT 1 FROM recommendation_feedback rf WHERE rf.user_id = ${V} AND ((rf.signal = 'not_interested' AND rf.post_id = p.id) OR (rf.signal = 'hide_creator' AND rf.creator_id = p.author_id)))
  AND NOT EXISTS (SELECT 1 FROM post_topics ptx JOIN topic_mutes tm ON tm.topic_id = ptx.topic_id AND tm.user_id = ${V} WHERE ptx.post_id = p.id)`;

const PUBLIC_AUTHOR = `NOT EXISTS (SELECT 1 FROM profiles ppx WHERE ppx.user_id = p.author_id AND ppx.is_private)`;

/** Load posts by id for a viewer (guard applied again) preserving the given order. Videos are included. */
export async function loadPostViews(
  ctx: AppContext,
  viewerId: string | null,
  ids: string[],
): Promise<PostView[]> {
  if (!ids.length) return [];
  const { rows } = await ctx.db.query(
    `SELECT ${postSelect('$1::uuid')} FROM ${postFrom} WHERE p.id = ANY($2::uuid[]) AND ${postSearchVisibleSql('$1::uuid', 'p')}`,
    [viewerId, ids],
  );
  const views = await hydratePosts(ctx, viewerId, rows);
  const byId = new Map(views.map((v) => [v.id, v]));
  return ids.map((id) => byId.get(id)).filter((v): v is PostView => Boolean(v));
}

export async function trendingPosts(
  ctx: AppContext,
  viewerId: string | null,
  windowHours: number,
  snapshot: Date,
  cursor: ScoreCursor | null,
  limit: number,
): Promise<Page<PostView & { trendingScore: number; engagedBy: number }>> {
  const p = new P();
  const V = V0(p, viewerId);
  const since = p.add(new Date(snapshot.getTime() - windowHours * 3600_000).toISOString());
  const snap = p.add(snapshot.toISOString());
  const inner = `WITH ${ACTIONS(since, snap)},
    cand AS (
      SELECT p.id, p.author_id, eng.actors,
             ${roundScore(`eng.w / power(GREATEST(EXTRACT(EPOCH FROM (${snap}::timestamptz - p.created_at)) / 3600.0, 1.0) + 2, 1.2)`)} AS score
        FROM eng JOIN posts p ON p.id = eng.post_id
       WHERE p.visibility = 'public' AND p.created_at <= ${snap}::timestamptz AND p.created_at > ${snap}::timestamptz - interval '14 days'
         AND ${PUBLIC_AUTHOR} AND (${V} IS NULL OR p.author_id <> ${V})
         AND ${postSearchVisibleSql(V, 'p')} ${FEED_EXCLUSIONS(V)}
    )
    SELECT id, score, actors FROM (SELECT id, score, actors, row_number() OVER (PARTITION BY author_id ORDER BY score DESC, id DESC) AS rn FROM cand) x WHERE rn <= 2`;
  const { rows } = await ctx.db.query<{ id: string; score: number; actors: number }>(
    keysetScore(p, inner, cursor, limit),
    p.values,
  );
  const page = rows.slice(0, limit);
  const views = await loadPostViews(
    ctx,
    viewerId,
    page.map((r) => r.id),
  );
  const meta = new Map(page.map((r) => [r.id, r]));
  const last = page[page.length - 1];
  return {
    items: views.map((v) => ({
      ...v,
      trendingScore: Number(meta.get(v.id)!.score),
      engagedBy: Number(meta.get(v.id)!.actors),
      reasons: ['Trending right now'],
    })),
    nextCursor: scoreCursorFor(
      last && { id: last.id, score: Number(last.score) },
      snapshot,
      rows.length > limit,
    ),
  };
}

export interface TrendingTopic {
  slug: string;
  name: string;
  postCount: number;
  authorCount: number;
  score: number;
}

export async function trendingTopics(
  ctx: AppContext,
  viewerId: string | null,
  windowHours: number,
  snapshot: Date,
  limit: number,
  minAuthors = TRENDING_MIN_AUTHORS,
  aggregate = false,
): Promise<TrendingTopic[]> {
  const p = new P();
  const V = V0(p, viewerId);
  const since = p.add(new Date(snapshot.getTime() - windowHours * 3600_000).toISOString());
  const snap = p.add(snapshot.toISOString());
  const { rows } = await ctx.db.query<Row>(
    `WITH ${ACTIONS(since, snap)}
     SELECT t.slug::text AS slug, t.name, count(DISTINCT p.id)::int AS post_count, count(DISTINCT p.author_id)::int AS author_count, sum(1 + COALESCE(eng.w, 0))::float8 AS score
       FROM posts p JOIN post_topics pt ON pt.post_id = p.id JOIN topics t ON t.id = pt.topic_id LEFT JOIN eng ON eng.post_id = p.id
      WHERE p.visibility = 'public' AND p.created_at <= ${snap}::timestamptz AND p.created_at > ${snap}::timestamptz - interval '14 days'
        AND (p.created_at >= ${since}::timestamptz OR eng.post_id IS NOT NULL)
        AND ${aggregate ? AGGREGATE_AUTHOR : PUBLIC_AUTHOR} AND ${postSearchVisibleSql(V, 'p')}
        AND NOT EXISTS (SELECT 1 FROM topic_mutes tm WHERE tm.user_id = ${V} AND tm.topic_id = t.id)
      GROUP BY t.id HAVING count(DISTINCT p.author_id) >= ${p.add(minAuthors)}::int
      ORDER BY score DESC, t.id LIMIT ${p.add(limit)}`,
    p.values,
  );
  return rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    postCount: r.post_count,
    authorCount: r.author_count,
    score: Math.round(Number(r.score) * 100) / 100,
  }));
}

// ------------------------------------------------------------------ people
export interface SuggestedPerson {
  user: ReturnType<typeof personItem>;
  reasons: string[];
  explanation: string;
  score: number;
}

const suggestion = (r: Row, reasons: string[]): SuggestedPerson => ({
  user: personItem(r),
  reasons,
  explanation: reasons[0] ?? 'Suggested for you',
  score: Math.round(Number(r.score) * 1000) / 1000,
});

/** Friends-of-friends, shared communities and shared interests. Excludes connected, blocked, muted and non-discoverable people. */
export async function suggestPeople(
  ctx: AppContext,
  viewerId: string,
  sig: ViewerSignals,
  cursor: ScoreCursor | null,
  limit: number,
  snapshot: Date,
): Promise<Page<SuggestedPerson>> {
  const p = new P();
  const V = V0(p, viewerId);
  const teen = sig.ageBand === 'teen';
  const inner = `
    WITH my_friends AS (
      SELECT CASE WHEN user_low = ${V} THEN user_high ELSE user_low END AS uid FROM friendships WHERE (user_low = ${V} OR user_high = ${V}) AND status = 'accepted' LIMIT 500),
    fof AS (
      SELECT CASE WHEN f.user_low = mf.uid THEN f.user_high ELSE f.user_low END AS uid, count(*)::int AS n
        FROM my_friends mf JOIN friendships f ON (f.user_low = mf.uid OR f.user_high = mf.uid) AND f.status = 'accepted' GROUP BY 1),
    sc AS (
      SELECT cm2.user_id AS uid, count(*)::int AS n, (array_agg(c.name ORDER BY c.member_count DESC))[1] AS sample
        FROM community_members cm1
        JOIN community_members cm2 ON cm2.community_id = cm1.community_id AND cm2.status = 'active' AND cm2.user_id <> ${V}
        JOIN communities c ON c.id = cm1.community_id AND c.deleted_at IS NULL
       WHERE cm1.user_id = ${V} AND cm1.status = 'active' GROUP BY 1),
    si AS (
      SELECT ui2.user_id AS uid, count(*)::int AS n, array_agg(t.name ORDER BY t.name) AS names
        FROM user_interests ui1 JOIN user_interests ui2 ON ui2.topic_id = ui1.topic_id AND ui2.user_id <> ${V} JOIN topics t ON t.id = ui1.topic_id
       WHERE ui1.user_id = ${V} GROUP BY 1)
    SELECT ${PERSON_SELECT}, COALESCE(fof.n, 0) AS mutual, COALESCE(sc.n, 0) AS shared_communities, sc.sample, COALESCE(si.n, 0) AS shared_interests, si.names,
           ${roundScore(`3.0 * LEAST(COALESCE(fof.n, 0), 10) + 2.0 * LEAST(COALESCE(sc.n, 0), 5) + 1.0 * LEAST(COALESCE(si.n, 0), 5) + 0.3 * ln(1 + pr.follower_count)`)} AS score
      FROM profiles pr
      LEFT JOIN fof ON fof.uid = pr.user_id LEFT JOIN sc ON sc.uid = pr.user_id LEFT JOIN si ON si.uid = pr.user_id
     WHERE (fof.uid IS NOT NULL OR sc.uid IS NOT NULL ${teen ? '' : 'OR si.uid IS NOT NULL'})
       AND pr.user_id <> ${V} AND ${personVisibleSql(V, 'pr')}
       AND NOT ${alreadyConnectedSql(V, 'pr.user_id')} AND ${notMutedOrHiddenSql(V, 'pr.user_id')}`;
  const { rows } = await ctx.db.query<Row>(keysetScore(p, inner, cursor, limit), p.values);
  const page = rows.slice(0, limit);
  const items = page.map((r) => {
    const reasons: string[] = [];
    if (r.mutual > 0)
      reasons.push(r.mutual === 1 ? '1 mutual friend' : `${r.mutual} mutual friends`);
    if (r.shared_communities > 0)
      reasons.push(
        r.shared_communities === 1
          ? `Also in ${r.sample}`
          : `In ${r.shared_communities} communities with you, including ${r.sample}`,
      );
    if (r.shared_interests > 0) reasons.push(`Shares your interest in ${listNames(r.names)}`);
    return suggestion(r, reasons);
  });
  const last = page[page.length - 1];
  return {
    items,
    nextCursor: scoreCursorFor(
      last && { id: last.id, score: Number(last.score) },
      snapshot,
      rows.length > limit,
    ),
  };
}

/**
 * Cold-start suggestions for people with no graph yet: creators and people who post about (or list) the given topics,
 * otherwise simply the most followed creators. Never uses behavioural signals; only the topics passed in.
 */
export async function suggestByInterests(
  ctx: AppContext,
  viewerId: string | null,
  topicSlugs: string[],
  teen: boolean,
  limit: number,
): Promise<SuggestedPerson[]> {
  const p = new P();
  const V = V0(p, viewerId);
  const slugs = p.add(topicSlugs);
  const rows = (
    await ctx.db.query<Row>(
      `WITH ti AS (SELECT id, name FROM topics WHERE slug = ANY(${slugs}::citext[]))
       SELECT * FROM (
         SELECT ${PERSON_SELECT},
                (SELECT array_agg(DISTINCT ti.name) FROM posts p JOIN post_topics pt ON pt.post_id = p.id JOIN ti ON ti.id = pt.topic_id
                  WHERE p.author_id = pr.user_id AND p.visibility = 'public' AND p.deleted_at IS NULL AND p.moderation_status = 'approved' AND p.created_at > now() - interval '90 days') AS post_topics,
                (SELECT array_agg(DISTINCT ti.name) FROM user_interests ui JOIN ti ON ti.id = ui.topic_id WHERE ui.user_id = pr.user_id) AS interest_topics
           FROM profiles pr
          WHERE (${V} IS NULL OR pr.user_id <> ${V}) AND ${personVisibleSql(V, 'pr')} AND NOT ${alreadyConnectedSql(V, 'pr.user_id')} AND ${notMutedOrHiddenSql(V, 'pr.user_id')}
            ${teen ? `AND pr.mode = 'creator'` : ''}
       ) x
       WHERE ${topicSlugs.length ? '(x.post_topics IS NOT NULL OR x.interest_topics IS NOT NULL)' : 'TRUE'}
       ORDER BY ${topicSlugs.length ? '(COALESCE(cardinality(x.post_topics), 0) * 2 + COALESCE(cardinality(x.interest_topics), 0))' : '0::int'} DESC,
                (x.mode = 'creator') DESC, x.follower_count DESC, x.id DESC
       LIMIT ${p.add(limit)}`,
      p.values,
    )
  ).rows;
  return rows.map((r) => {
    const matched = [
      ...new Set([...(r.post_topics ?? []), ...(r.interest_topics ?? [])]),
    ] as string[];
    const reasons: string[] = [];
    if (r.post_topics?.length) reasons.push(`Posts about ${listNames(r.post_topics)}`);
    if (r.interest_topics?.length) reasons.push(`Interested in ${listNames(r.interest_topics)}`);
    if (!matched.length)
      reasons.push(r.mode === 'creator' ? 'Popular creator on YAPILAPI' : 'Popular on YAPILAPI');
    return suggestion({ ...r, score: matched.length * 2 + Math.log1p(r.follower_count) }, reasons);
  });
}

// ------------------------------------------------------------------ creators
export async function discoverCreators(
  ctx: AppContext,
  viewerId: string | null,
  sig: ViewerSignals,
  topic: string | null,
  cursor: ScoreCursor | null,
  limit: number,
  snapshot: Date,
): Promise<Page<SuggestedPerson>> {
  const p = new P();
  const V = V0(p, viewerId);
  const snap = p.add(snapshot.toISOString());
  const interests = p.add(sig.interests.map((i) => i.slug));
  const topicP = p.add(topic);
  const inner = `
    SELECT * FROM (
      SELECT ${PERSON_SELECT},
        (SELECT array_agg(DISTINCT t.name) FROM posts p JOIN post_topics pt ON pt.post_id = p.id JOIN topics t ON t.id = pt.topic_id
          WHERE p.author_id = pr.user_id AND p.visibility = 'public' AND p.deleted_at IS NULL AND p.moderation_status = 'approved' AND p.created_at > ${snap}::timestamptz - interval '90 days'
            AND t.slug = ANY(${interests}::citext[])) AS matched_topics,
        EXISTS (SELECT 1 FROM posts p JOIN post_topics pt ON pt.post_id = p.id JOIN topics t ON t.id = pt.topic_id
          WHERE p.author_id = pr.user_id AND p.visibility = 'public' AND p.deleted_at IS NULL AND p.moderation_status = 'approved' AND p.created_at > ${snap}::timestamptz - interval '90 days'
            AND t.slug = ${topicP}::citext) AS topic_hit,
        (SELECT count(*)::int FROM posts p WHERE p.author_id = pr.user_id AND p.visibility = 'public' AND p.deleted_at IS NULL AND p.moderation_status = 'approved'
            AND p.created_at > ${snap}::timestamptz - interval '30 days' AND p.created_at <= ${snap}::timestamptz) AS recent_posts
        FROM profiles pr
       WHERE pr.mode = 'creator' AND (${V} IS NULL OR pr.user_id <> ${V}) AND ${personVisibleSql(V, 'pr')}
         AND NOT ${alreadyConnectedSql(V, 'pr.user_id')} AND ${notMutedOrHiddenSql(V, 'pr.user_id')}
    ) c
    WHERE (${topicP}::text IS NULL OR c.topic_hit)`;
  const scored = `SELECT c.*, ${roundScore(`0.5 * ln(1 + c.follower_count) + 2.0 * LEAST(COALESCE(cardinality(c.matched_topics), 0), 3) + (CASE WHEN c.topic_hit THEN 2.0 ELSE 0 END) + 0.2 * LEAST(c.recent_posts, 10)`)} AS score FROM (${inner}) c`;
  const { rows } = await ctx.db.query<Row>(keysetScore(p, scored, cursor, limit), p.values);
  const page = rows.slice(0, limit);
  const items = page.map((r) => {
    const reasons: string[] = [];
    if (r.matched_topics?.length) reasons.push(`Posts about ${listNames(r.matched_topics)}`);
    if (r.recent_posts >= 3) reasons.push('Active recently');
    if (r.follower_count > 0)
      reasons.push(`${r.follower_count} follower${r.follower_count === 1 ? '' : 's'}`);
    if (!reasons.length) reasons.push('Creator on YAPILAPI');
    return suggestion(r, reasons);
  });
  const last = page[page.length - 1];
  return {
    items,
    nextCursor: scoreCursorFor(
      last && { id: last.id, score: Number(last.score) },
      snapshot,
      rows.length > limit,
    ),
  };
}

// ------------------------------------------------------------------ communities
export async function discoverCommunities(
  ctx: AppContext,
  viewerId: string | null,
  sig: ViewerSignals,
  topic: string | null,
  cursor: ScoreCursor | null,
  limit: number,
  snapshot: Date,
) {
  const p = new P();
  const V = V0(p, viewerId);
  const snap = p.add(snapshot.toISOString());
  const interests = p.add(sig.interests.map((i) => i.slug));
  const topicP = p.add(topic);
  const inner = `
    WITH my_friends AS (
      SELECT CASE WHEN user_low = ${V} THEN user_high ELSE user_low END AS uid FROM friendships WHERE ${sig.personalization ? `(user_low = ${V} OR user_high = ${V}) AND status = 'accepted'` : 'FALSE'} LIMIT 500)
    SELECT c.id,
           c.slug::text AS slug, c.name, c.description, c.member_count, c.language, c.is_paid, c.price_cents, c.currency, c.join_policy,
           (SELECT array_agg(DISTINCT t.name) FROM community_topics ct JOIN topics t ON t.id = ct.topic_id WHERE ct.community_id = c.id AND t.slug = ANY(${interests}::citext[])) AS matched_topics,
           (SELECT count(*)::int FROM community_members m WHERE m.community_id = c.id AND m.status = 'active' AND m.user_id IN (SELECT uid FROM my_friends)) AS friends_in,
           (SELECT count(*)::int FROM posts p WHERE p.community_id = c.id AND p.deleted_at IS NULL AND p.moderation_status = 'approved' AND p.created_at > ${snap}::timestamptz - interval '7 days' AND p.created_at <= ${snap}::timestamptz) AS posts_7d,
           ${roundScore(`
             3.0 * LEAST(COALESCE((SELECT count(*) FROM community_topics ct JOIN topics t ON t.id = ct.topic_id WHERE ct.community_id = c.id AND t.slug = ANY(${interests}::citext[])), 0), 3)
             + 2.0 * ln(1 + (SELECT count(*) FROM community_members m WHERE m.community_id = c.id AND m.status = 'active' AND m.user_id IN (SELECT uid FROM my_friends)))
             + 0.5 * ln(1 + c.member_count)
             + 0.8 * ln(1 + (SELECT count(*) FROM posts p WHERE p.community_id = c.id AND p.deleted_at IS NULL AND p.moderation_status = 'approved' AND p.created_at > ${snap}::timestamptz - interval '7 days' AND p.created_at <= ${snap}::timestamptz))`)} AS score
      FROM communities c
     WHERE c.visibility = 'public' AND ${communityVisibleSql(V, 'c')}
       AND NOT EXISTS (SELECT 1 FROM community_members me WHERE me.community_id = c.id AND me.user_id = ${V} AND me.status IN ('active','pending','invited','banned'))
       AND (${topicP}::text IS NULL OR EXISTS (SELECT 1 FROM community_topics ct JOIN topics t ON t.id = ct.topic_id WHERE ct.community_id = c.id AND t.slug = ${topicP}::citext))`;
  const { rows } = await ctx.db.query<Row>(keysetScore(p, inner, cursor, limit), p.values);
  const page = rows.slice(0, limit);
  const topics = await topicsFor(
    ctx.db,
    page.map((r) => r.id),
  );
  const items = page.map((r) => {
    const reasons: string[] = [];
    if (r.matched_topics?.length)
      reasons.push(`Matches your interests: ${listNames(r.matched_topics)}`);
    if (r.friends_in > 0)
      reasons.push(
        r.friends_in === 1
          ? '1 of your friends is a member'
          : `${r.friends_in} of your friends are members`,
      );
    if (r.posts_7d >= 3) reasons.push('Active this week');
    if (!reasons.length)
      reasons.push(r.member_count >= 10 ? 'Popular community' : 'New community to explore');
    return {
      id: r.id as string,
      slug: r.slug as string,
      name: r.name as string,
      description: clip(r.description, 300),
      memberCount: r.member_count as number,
      language: r.language as string | null,
      joinPolicy: r.join_policy as string,
      isPaid: r.is_paid as boolean,
      priceCents: r.price_cents as number | null,
      currency: r.currency as string | null,
      topics: topics.get(r.id) ?? [],
      reasons,
      explanation: reasons[0]!,
      score: Number(r.score),
    };
  });
  const last = page[page.length - 1];
  return {
    items,
    nextCursor: scoreCursorFor(
      last && { id: last.id, score: Number(last.score) },
      snapshot,
      rows.length > limit,
    ),
  };
}

// ------------------------------------------------------------------ topics
export async function discoverTopics(
  ctx: AppContext,
  viewerId: string | null,
  sig: ViewerSignals,
  limit: number,
) {
  const { rows } = await ctx.db.query<Row>(
    `SELECT t.slug::text AS slug, t.name,
            (SELECT count(*)::int FROM post_topics pt JOIN posts p ON p.id = pt.post_id
              WHERE pt.topic_id = t.id AND p.visibility = 'public' AND p.deleted_at IS NULL AND p.moderation_status = 'approved' AND p.created_at > now() - interval '7 days'
                AND NOT EXISTS (SELECT 1 FROM profiles pp WHERE pp.user_id = p.author_id AND pp.is_private)
                AND NOT EXISTS (SELECT 1 FROM users tu WHERE tu.id = p.author_id AND tu.age_band = 'teen')) AS posts_7d,
            (SELECT count(*)::int FROM community_topics ct JOIN communities c ON c.id = ct.community_id WHERE ct.topic_id = t.id AND c.visibility = 'public' AND c.deleted_at IS NULL) AS communities
       FROM topics t
      WHERE NOT EXISTS (SELECT 1 FROM topic_mutes tm WHERE tm.user_id = $1::uuid AND tm.topic_id = t.id)`,
    [viewerId],
  );
  const mine = new Set(sig.interests.map((i) => i.slug));
  const scored = rows
    .map((r) => ({
      slug: r.slug as string,
      name: r.name as string,
      postsThisWeek: r.posts_7d as number,
      communities: r.communities as number,
      interested: mine.has(r.slug),
      score: r.posts_7d + 0.5 * r.communities,
    }))
    .sort(
      (a, b) =>
        Number(a.interested) - Number(b.interested) ||
        b.score - a.score ||
        a.name.localeCompare(b.name),
    ) // topics you do not follow yet come first
    .slice(0, limit);
  return {
    items: scored.map((s) => ({
      slug: s.slug,
      name: s.name,
      postsThisWeek: s.postsThisWeek,
      communities: s.communities,
      interested: s.interested,
      reason: s.interested
        ? 'In your interests'
        : s.postsThisWeek > 0
          ? `${s.postsThisWeek} public post${s.postsThisWeek === 1 ? '' : 's'} this week`
          : s.communities > 0
            ? `${s.communities} communit${s.communities === 1 ? 'y' : 'ies'}`
            : 'Explore this topic',
    })),
  };
}

// ------------------------------------------------------------------ geo helpers
export interface Geo {
  lat: number;
  lng: number;
  radiusKm: number;
}
function geoWhere(p: P, geo: Geo, latCol: string, lngCol: string): string {
  const lat = p.add(geo.lat);
  const lng = p.add(geo.lng);
  const parts = [`${latCol} IS NOT NULL`];
  const bb = boundingBox(geo.lat, geo.lng, geo.radiusKm);
  if (bb)
    parts.push(
      `${latCol} BETWEEN ${p.add(bb.minLat)} AND ${p.add(bb.maxLat)}`,
      `${lngCol} BETWEEN ${p.add(bb.minLng)} AND ${p.add(bb.maxLng)}`,
    );
  parts.push(
    `${haversineSql(`${lat}::float8`, `${lng}::float8`, latCol, lngCol)} <= ${p.add(geo.radiusKm)}::float8`,
  );
  return parts.join(' AND ');
}
const distSql = (p: P, geo: Geo, latCol: string, lngCol: string) =>
  haversineSql(`${p.add(geo.lat)}::float8`, `${p.add(geo.lng)}::float8`, latCol, lngCol);
const distKm = (geo: Geo | null, lat: unknown, lng: unknown) =>
  geo && typeof lat === 'number' && typeof lng === 'number'
    ? Math.round(haversineKm(geo.lat, geo.lng, lat, lng) * 10) / 10
    : undefined;

// ------------------------------------------------------------------ places
export async function discoverPlaces(
  ctx: AppContext,
  viewerId: string | null,
  opts: {
    geo: Geo | null;
    kind: string | null;
    cursor: ScoreCursor | null;
    limit: number;
    snapshot: Date;
  },
) {
  const p = new P();
  const V = V0(p, viewerId);
  const where = [`pl.deleted_at IS NULL`, `(${V} IS NULL OR TRUE)`];
  if (opts.kind) where.push(`pl.kind = ${p.add(opts.kind)}::text`);
  let scoreExpr: string;
  if (opts.geo) {
    where.push(geoWhere(p, opts.geo, 'pl.latitude', 'pl.longitude'));
    // Nearest first; rating is only a tie-breaker. Score is negated distance so the shared DESC keyset works.
    scoreExpr = roundScore(
      `-1 * ${distSql(p, opts.geo, 'pl.latitude', 'pl.longitude')} + 0.01 * (pl.rating_avg * ln(1 + pl.rating_count))`,
    );
  } else {
    scoreExpr = roundScore(
      `pl.rating_avg * ln(1 + pl.rating_count) + 0.1 * ln(1 + pl.rating_count)`,
    );
  }
  const inner = `SELECT pl.id, ${scoreExpr} AS score FROM places pl WHERE ${where.join(' AND ')}`;
  const { rows } = await ctx.db.query<{ id: string; score: number }>(
    keysetScore(p, inner, opts.cursor, opts.limit),
    p.values,
  );
  const page = rows.slice(0, opts.limit);
  const full = page.length
    ? await ctx.db.query<Row>(
        `SELECT pl.id, pl.name, pl.kind, pl.description, pl.latitude, pl.longitude, pl.address, pl.capacity, pl.rating_avg, pl.rating_count, pl.business_id FROM places pl WHERE pl.id = ANY($1::uuid[]) AND pl.deleted_at IS NULL`,
        [page.map((r) => r.id)],
      )
    : { rows: [] as Row[] };
  const byId = new Map(full.rows.map((r) => [r.id, r]));
  const items = page.flatMap((c) => {
    const r = byId.get(c.id);
    if (!r) return [];
    return [
      {
        id: r.id as string,
        name: r.name as string,
        kind: r.kind as string,
        description: clip(r.description, 280),
        location: { latitude: r.latitude as number, longitude: r.longitude as number },
        address: r.address,
        capacity: r.capacity as number | null,
        ratingAvg: Number(r.rating_avg),
        ratingCount: r.rating_count as number,
        businessId: r.business_id as string | null,
        distanceKm: distKm(opts.geo, r.latitude, r.longitude),
      },
    ];
  });
  const last = page[page.length - 1];
  return {
    items,
    nextCursor: scoreCursorFor(
      last && { id: last.id, score: Number(last.score) },
      opts.snapshot,
      rows.length > opts.limit,
    ),
  };
}

// ------------------------------------------------------------------ events
export interface EventOpts {
  geo: Geo | null;
  window: { from: Date; to: Date } | null;
  cursor: { t: string; id: string } | null;
  limit: number;
  snapshot: Date;
}

const EVENT_END = `COALESCE(e.ends_at, e.starts_at + interval '3 hours')`;

export async function discoverEvents(ctx: AppContext, viewerId: string | null, opts: EventOpts) {
  const p = new P();
  const V = V0(p, viewerId);
  const where = [
    eventVisibleSql(V, 'e'),
    `${EVENT_END} > ${p.add(opts.snapshot.toISOString())}::timestamptz`,
  ];
  if (opts.window)
    where.push(
      `e.starts_at < ${p.add(opts.window.to.toISOString())}::timestamptz`,
      `${EVENT_END} > ${p.add(opts.window.from.toISOString())}::timestamptz`,
    );
  if (opts.geo)
    where.push(
      geoWhere(
        p,
        opts.geo,
        'COALESCE(e.latitude, pl.latitude)',
        'COALESCE(e.longitude, pl.longitude)',
      ),
    );
  if (opts.cursor)
    where.push(
      `(e.starts_at, e.id) > (${p.add(opts.cursor.t)}::timestamptz, ${p.add(opts.cursor.id)}::uuid)`,
    );
  const { rows } = await ctx.db.query<Row>(
    `SELECT e.id, e.title, e.description, e.starts_at, e.ends_at, e.timezone, e.location_text, e.place_id, e.community_id, e.visibility, e.going_count, e.interested_count, e.cover_url,
            e.host_id, COALESCE(e.latitude, pl.latitude) AS lat, COALESCE(e.longitude, pl.longitude) AS lng, hp.username::text AS host_username, hp.display_name AS host_name
       FROM events e LEFT JOIN places pl ON pl.id = e.place_id LEFT JOIN profiles hp ON hp.user_id = e.host_id
      WHERE ${where.join(' AND ')} ORDER BY e.starts_at ASC, e.id ASC LIMIT ${p.add(opts.limit + 1)}`,
    p.values,
  );
  const page = rows.slice(0, opts.limit);
  const items = page.map((r) => ({
    id: r.id as string,
    title: r.title as string,
    description: clip(r.description, 280),
    startsAt: iso(r.starts_at),
    endsAt: iso(r.ends_at),
    timezone: r.timezone as string,
    locationText: r.location_text as string | null,
    location:
      r.lat !== null && r.lat !== undefined
        ? { latitude: r.lat as number, longitude: r.lng as number }
        : null,
    placeId: r.place_id as string | null,
    communityId: r.community_id as string | null,
    visibility: r.visibility as string,
    goingCount: r.going_count as number,
    interestedCount: r.interested_count as number,
    coverUrl: r.cover_url as string | null,
    host: r.host_id
      ? {
          id: r.host_id as string,
          username: r.host_username as string,
          displayName: r.host_name as string,
        }
      : null,
    distanceKm: distKm(opts.geo, r.lat, r.lng),
  }));
  const last = page[page.length - 1];
  return {
    items,
    nextCursor:
      rows.length > opts.limit && last
        ? { t: new Date(last.starts_at).toISOString(), id: last.id as string }
        : null,
  };
}

// ------------------------------------------------------------------ products & businesses
export async function discoverProducts(
  ctx: AppContext,
  viewerId: string | null,
  opts: {
    kind: string | null;
    maxPriceCents: number | null;
    cursor: ScoreCursor | null;
    limit: number;
    snapshot: Date;
  },
) {
  const p = new P();
  const V = V0(p, viewerId);
  const snap = p.add(opts.snapshot.toISOString());
  const where = [productVisibleSql(V, 'pd'), `(pd.stock IS NULL OR pd.stock > 0)`];
  if (opts.kind) where.push(`pd.kind = ${p.add(opts.kind)}::text`);
  if (opts.maxPriceCents !== null)
    where.push(`pd.price_cents <= ${p.add(opts.maxPriceCents)}::int`);
  const inner = `SELECT pd.id, ${roundScore(`0.5 * pd.rating_avg * ln(1 + pd.rating_count) + 0.25 * power(0.5::numeric, GREATEST(0, EXTRACT(EPOCH FROM (${snap}::timestamptz - pd.created_at)) / 3600.0)::numeric / 1440.0)`)} AS score FROM products pd WHERE ${where.join(' AND ')}`;
  const { rows } = await ctx.db.query<{ id: string; score: number }>(
    keysetScore(p, inner, opts.cursor, opts.limit),
    p.values,
  );
  const page = rows.slice(0, opts.limit);
  const full = page.length
    ? await ctx.db.query<Row>(
        `SELECT pd.id, pd.title, pd.description, pd.kind, pd.price_cents, pd.currency, pd.stock, pd.rating_avg, pd.rating_count, pd.business_id, pd.seller_user_id,
                b.name AS business_name, b.slug::text AS business_slug, sp.username::text AS seller_username, sp.display_name AS seller_name
           FROM products pd LEFT JOIN businesses b ON b.id = pd.business_id LEFT JOIN profiles sp ON sp.user_id = pd.seller_user_id
          WHERE pd.id = ANY($2::uuid[]) AND ${productVisibleSql('$1::uuid', 'pd')}`,
        [viewerId, page.map((r) => r.id)],
      )
    : { rows: [] as Row[] };
  const byId = new Map(full.rows.map((r) => [r.id, r]));
  const items = page.flatMap((c) => {
    const r = byId.get(c.id);
    if (!r) return [];
    return [
      {
        id: r.id as string,
        title: r.title as string,
        description: clip(r.description, 280),
        kind: r.kind as string,
        priceCents: r.price_cents as number,
        currency: r.currency as string,
        inStock: r.stock === null || r.stock > 0,
        ratingAvg: Number(r.rating_avg),
        ratingCount: r.rating_count as number,
        seller: r.business_id
          ? { type: 'business', id: r.business_id, name: r.business_name, slug: r.business_slug }
          : {
              type: 'user',
              id: r.seller_user_id,
              name: r.seller_name,
              username: r.seller_username,
            },
      },
    ];
  });
  const last = page[page.length - 1];
  return {
    items,
    nextCursor: scoreCursorFor(
      last && { id: last.id, score: Number(last.score) },
      opts.snapshot,
      rows.length > opts.limit,
    ),
  };
}

export async function discoverBusinesses(
  ctx: AppContext,
  viewerId: string | null,
  opts: {
    geo: Geo | null;
    category: string | null;
    cursor: ScoreCursor | null;
    limit: number;
    snapshot: Date;
  },
) {
  const p = new P();
  const V = V0(p, viewerId);
  const snap = p.add(opts.snapshot.toISOString());
  const where = [businessVisibleSql(V, 'b')];
  if (opts.category) where.push(`b.category = ${p.add(opts.category)}::text`);
  if (opts.geo)
    where.push(
      `EXISTS (SELECT 1 FROM places bp WHERE bp.business_id = b.id AND bp.deleted_at IS NULL AND ${geoWhere(p, opts.geo, 'bp.latitude', 'bp.longitude')})`,
    );
  const inner = `SELECT b.id, ${roundScore(`(CASE WHEN b.verified_at IS NOT NULL THEN 1.0 ELSE 0 END) + 0.4 * ln(1 + COALESCE((SELECT sum(bp2.rating_count) FROM places bp2 WHERE bp2.business_id = b.id AND bp2.deleted_at IS NULL), 0)) + 0.25 * power(0.5::numeric, GREATEST(0, EXTRACT(EPOCH FROM (${snap}::timestamptz - b.created_at)) / 3600.0)::numeric / 4320.0)`)} AS score FROM businesses b WHERE ${where.join(' AND ')}`;
  const { rows } = await ctx.db.query<{ id: string; score: number }>(
    keysetScore(p, inner, opts.cursor, opts.limit),
    p.values,
  );
  const page = rows.slice(0, opts.limit);
  const full = page.length
    ? await ctx.db.query<Row>(
        `SELECT b.id, b.slug::text AS slug, b.name, b.category, b.description, b.logo_url, (b.verified_at IS NOT NULL) AS verified FROM businesses b WHERE b.id = ANY($2::uuid[]) AND ${businessVisibleSql('$1::uuid', 'b')}`,
        [viewerId, page.map((r) => r.id)],
      )
    : { rows: [] as Row[] };
  const byId = new Map(full.rows.map((r) => [r.id, r]));
  const items = page.flatMap((c) => {
    const r = byId.get(c.id);
    return r
      ? [
          {
            id: r.id as string,
            slug: r.slug as string,
            name: r.name as string,
            category: r.category as string,
            description: clip(r.description, 280),
            logoUrl: r.logo_url as string | null,
            verified: r.verified as boolean,
          },
        ]
      : [];
  });
  const last = page[page.length - 1];
  return {
    items,
    nextCursor: scoreCursorFor(
      last && { id: last.id, score: Number(last.score) },
      opts.snapshot,
      rows.length > opts.limit,
    ),
  };
}

// ------------------------------------------------------------------ live
export async function discoverLive(
  ctx: AppContext,
  viewerId: string | null,
  opts: { cursor: { t: string; id: string } | null; limit: number },
) {
  const p = new P();
  const V = V0(p, viewerId);
  const where = [
    `ls.status = 'live'`,
    `ls.visibility <> 'private'`,
    activeUserSql('ls.host_id'),
    notBlockedSql(V, 'ls.host_id'),
    teenAllowedSql(V, 'ls.host_id'),
    notMutedOrHiddenSql(V, 'ls.host_id'),
    `(ls.visibility = 'public' OR (${V} IS NOT NULL AND (
        ls.host_id = ${V}
        OR (ls.visibility = 'followers' AND ${followsSql(V, 'ls.host_id')})
        OR (ls.visibility = 'subscribers' AND EXISTS (SELECT 1 FROM subscriptions sb WHERE sb.subscriber_id = ${V} AND sb.creator_id = ls.host_id AND sb.status = 'active')))))`,
  ];
  if (opts.cursor)
    where.push(
      `(COALESCE(ls.started_at, ls.created_at), ls.id) < (${p.add(opts.cursor.t)}::timestamptz, ${p.add(opts.cursor.id)}::uuid)`,
    );
  const { rows } = await ctx.db.query<Row>(
    `SELECT ls.id, ls.title, ls.description, ls.visibility, ls.started_at, ls.created_at, ls.peak_viewers, (ls.ticket_type_id IS NOT NULL) AS ticketed, ls.host_id,
            hp.username::text AS host_username, hp.display_name AS host_name, hp.avatar_url AS host_avatar,
            (SELECT count(*)::int FROM live_participants lp WHERE lp.live_id = ls.id AND lp.left_at IS NULL) AS viewer_count
       FROM live_sessions ls JOIN profiles hp ON hp.user_id = ls.host_id
      WHERE ${where.join(' AND ')} ORDER BY COALESCE(ls.started_at, ls.created_at) DESC, ls.id DESC LIMIT ${p.add(opts.limit + 1)}`,
    p.values,
  );
  const page = rows.slice(0, opts.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({
      id: r.id as string,
      title: r.title as string,
      description: clip(r.description, 280),
      visibility: r.visibility as string,
      startedAt: iso(r.started_at ?? r.created_at),
      ticketed: r.ticketed as boolean,
      viewerCount: r.viewer_count as number,
      peakViewers: r.peak_viewers as number,
      host: {
        id: r.host_id as string,
        username: r.host_username as string,
        displayName: r.host_name as string,
        avatarUrl: r.host_avatar as string | null,
      },
    })),
    nextCursor:
      rows.length > opts.limit && last
        ? { t: new Date(last.started_at ?? last.created_at).toISOString(), id: last.id as string }
        : null,
  };
}

// ------------------------------------------------------------------ local bundle & NOW
export async function localPosts(
  ctx: AppContext,
  viewerId: string | null,
  geo: Geo,
  limit: number,
  snapshot: Date,
): Promise<PostView[]> {
  const p = new P();
  const V = V0(p, viewerId);
  const snap = p.add(snapshot.toISOString());
  const { rows } = await ctx.db.query<{ id: string }>(
    `SELECT p.id FROM posts p LEFT JOIN places pl ON pl.id = p.place_id
      WHERE p.visibility = 'public' AND ${PUBLIC_AUTHOR} AND ${postSearchVisibleSql(V, 'p')} ${FEED_EXCLUSIONS(V)}
        AND p.created_at > ${snap}::timestamptz - interval '3 days' AND p.created_at <= ${snap}::timestamptz
        AND ${geoWhere(p, geo, 'COALESCE(p.latitude, pl.latitude)', 'COALESCE(p.longitude, pl.longitude)')}
      ORDER BY (p.like_count + 2 * p.comment_count + 3 * p.share_count) DESC, p.created_at DESC, p.id DESC LIMIT ${p.add(limit)}`,
    p.values,
  );
  return loadPostViews(
    ctx,
    viewerId,
    rows.map((r) => r.id),
  );
}

/** Authors whose activity may be counted in aggregates: adults, public profile, and not opted out of discoverability. */
const AGGREGATE_AUTHOR = `EXISTS (SELECT 1 FROM users au WHERE au.id = p.author_id AND au.deleted_at IS NULL AND au.status = 'active' AND au.age_band = 'adult')
  AND ${PUBLIC_AUTHOR}
  AND COALESCE((SELECT aup.discoverable FROM user_preferences aup WHERE aup.user_id = p.author_id), true)`;

export interface NowSnapshot {
  eventsNow: Awaited<ReturnType<typeof discoverEvents>>['items'];
  trendingTopics: TrendingTopic[];
  activeCommunities: Array<{
    id: string;
    slug: string;
    name: string;
    memberCount: number;
    activePeople: number;
    approximate: true;
  }>;
  nearby: null | {
    people: { count: number; approximate: true } | null;
    places: Array<{
      id: string;
      name: string;
      kind: string;
      distanceKm: number | undefined;
      activePeople: number;
      approximate: true;
    }>;
  };
}

/** Round down to a multiple of 5 so exact head-counts (and differences between two calls) are not observable. */
export const bucketCount = (n: number) => Math.floor(n / 5) * 5;

export async function nowSnapshot(
  ctx: AppContext,
  viewerId: string,
  geo: Geo | null,
  snapshot: Date,
  limit: number,
): Promise<NowSnapshot> {
  const soon = new Date(snapshot.getTime() + 3 * 3600_000);
  const events = await discoverEvents(ctx, viewerId, {
    geo,
    window: { from: snapshot, to: soon },
    cursor: null,
    limit,
    snapshot,
  });
  const topics = await trendingTopics(ctx, viewerId, 6, snapshot, 8, K_ANONYMITY, true);

  // Public communities where at least K different adults posted in the last 6 hours.
  const cp = new P();
  const CV = V0(cp, viewerId);
  const since6 = cp.add(new Date(snapshot.getTime() - 6 * 3600_000).toISOString());
  const csnap = cp.add(snapshot.toISOString());
  const comm = await ctx.db.query<Row>(
    `SELECT c.id, c.slug::text AS slug, c.name, c.member_count, count(DISTINCT p.author_id)::int AS authors
       FROM communities c JOIN posts p ON p.community_id = c.id
      WHERE c.visibility = 'public' AND ${communityVisibleSql(CV, 'c')} AND p.deleted_at IS NULL AND p.moderation_status = 'approved' AND p.visibility = 'community'
        AND p.created_at >= ${since6}::timestamptz AND p.created_at <= ${csnap}::timestamptz AND ${AGGREGATE_AUTHOR}
      GROUP BY c.id HAVING count(DISTINCT p.author_id) >= ${cp.add(K_ANONYMITY)}::int
      ORDER BY count(DISTINCT p.author_id) DESC, c.id LIMIT ${cp.add(limit)}`,
    cp.values,
  );

  let nearby: NowSnapshot['nearby'] = null;
  if (geo) {
    const p = new P();
    const since3 = p.add(new Date(snapshot.getTime() - 3 * 3600_000).toISOString());
    const snap = p.add(snapshot.toISOString());
    const base = `FROM posts p LEFT JOIN places pl ON pl.id = p.place_id
       WHERE p.visibility = 'public' AND p.deleted_at IS NULL AND p.moderation_status = 'approved' AND p.created_at >= ${since3}::timestamptz AND p.created_at <= ${snap}::timestamptz
         AND ${AGGREGATE_AUTHOR} AND ${geoWhere(p, geo, 'COALESCE(p.latitude, pl.latitude)', 'COALESCE(p.longitude, pl.longitude)')}`;
    const total = await ctx.db.query<{ n: number }>(
      `SELECT count(DISTINCT p.author_id)::int AS n ${base}`,
      p.values,
    );
    const n = total.rows[0]?.n ?? 0;
    const pp = new P();
    const since3b = pp.add(new Date(snapshot.getTime() - 3 * 3600_000).toISOString());
    const snapb = pp.add(snapshot.toISOString());
    const dist = distSql(pp, geo, 'pl.latitude', 'pl.longitude');
    const places = await ctx.db.query<Row>(
      `SELECT pl.id, pl.name, pl.kind, pl.latitude, pl.longitude, ${dist} AS dist, count(DISTINCT p.author_id)::int AS authors
         FROM posts p JOIN places pl ON pl.id = p.place_id AND pl.deleted_at IS NULL
        WHERE p.visibility = 'public' AND p.deleted_at IS NULL AND p.moderation_status = 'approved' AND p.created_at >= ${since3b}::timestamptz AND p.created_at <= ${snapb}::timestamptz
          AND ${AGGREGATE_AUTHOR} AND ${geoWhere(pp, geo, 'pl.latitude', 'pl.longitude')}
        GROUP BY pl.id HAVING count(DISTINCT p.author_id) >= ${pp.add(K_ANONYMITY)}::int ORDER BY count(DISTINCT p.author_id) DESC, pl.id LIMIT ${pp.add(limit)}`,
      pp.values,
    );
    nearby = {
      people: n >= K_ANONYMITY ? { count: bucketCount(n), approximate: true } : null,
      places: places.rows.map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind,
        distanceKm: distKm(geo, r.latitude, r.longitude),
        activePeople: bucketCount(r.authors),
        approximate: true as const,
      })),
    };
  }
  return {
    eventsNow: events.items,
    trendingTopics: topics,
    activeCommunities: comm.rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      memberCount: r.member_count,
      activePeople: bucketCount(r.authors),
      approximate: true as const,
    })),
    nearby,
  };
}
