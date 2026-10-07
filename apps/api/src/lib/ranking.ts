import type { Pool, PoolClient } from 'pg';
import { decodeCursor, encodeCursor } from './cursor.ts';
import { fadedScoreSql } from './affinity.ts';
import { trendSql } from './post-stats.ts';
import { postVisibleSql } from './visibility.ts';
import type { FeedReason } from './posts.ts';

type Q = Pool | PoolClient;

/**
 * The recommender behind For you and Reels, in Postgres: no other service, no model to train.
 * docs/product/recommendations.md explains it in plain words; change both together.
 *
 * 1. Candidates: posts from several sources (your connections, the newest posts, your interests,
 *    the topics and creators you engage with, what people like you engaged with, trending,
 *    evergreen, and posts that haven't had a chance to be seen yet), at most a few thousand.
 * 2. Every safety and visibility rule, your mutes and "Not interested", and what you already saw.
 * 3. A score per post from the weights in RANKING (computed here, in scoreOf).
 * 4. An order: the best first, with room for new creators (one slot in RANKING.exploration.every)
 *    and limits on how many come from one creator or topic, and on runs of one format.
 * 5. The order is kept (feed_sessions) and the next pages read from it: what you do while
 *    scrolling never repeats or skips a post.
 */
export const RANKING = {
  weights: {
    /** Per topic of the post you picked as an interest (onboarding, settings): the cold start. */
    interest: 1.2,
    /** Per topic of posts you asked to see more like, and less like (kept until you change it). */
    moreLikeThis: 1.0,
    lessLikeThis: -2.0,
    /** × tanh(sum of your learned scores for the post's topics / topicScale): between −2.5 and +2.5. */
    topicAffinity: 2.5,
    /** × ln(1 + your learned score for the creator), when it's positive (30 at most: about +2.7). */
    creatorAffinity: 0.8,
    /** × your learned score for the creator, when it's negative (−10 at least: −3). */
    creatorDislike: 0.3,
    /** Who it's from: you, a friend (or a co-author who is), someone you follow (or a co-author), a community you're in. */
    own: 1,
    friend: 3,
    follow: 2,
    community: 1.5,
    /** × ln(1 + how strongly people who like what you like engaged with it). */
    similarPeople: 0.6,
    /** × ln(1 + 10 × smoothed engagement rate), see RANKING.quality. */
    quality: 0.3,
    /** × ln(1 + likes + 2 × comments): plain popularity (with quality, about as much as one connection at most for most posts). */
    reach: 0.3,
    /** × ln(1 + momentum): engagement in about the last six hours (lib/post-stats.ts TREND). */
    velocity: 0.1,
    /** Reels: × (smoothed share of views watched to the end − its prior), and the same for skips (subtracted). */
    completion: 2.0,
    skip: 2.0,
    /** × exp(−age in hours / freshnessHours). */
    freshness: 4.0,
  },
  topicScale: 8,
  freshnessHours: 36,
  /**
   * Engagement rate: (likes + 2 comments + 3 shares + 3 saves + 2 finished watches) / (impressions + smoothing).
   * The smoothing keeps a post with 2 likes from 2 views from beating one with 200 from 1,000.
   */
  quality: { smoothing: 20, likes: 1, comments: 2, shares: 3, saves: 3, completes: 2 },
  /** Reels: rates pulled towards these priors until a reel has been seen enough times. */
  reels: { smoothing: 10, completionPrior: 0.3, skipPrior: 0.2 },
  /** Momentum at which a post is "trending now" in its reason. */
  trendingReason: 3,
  /** Learned scores at which a creator or topic is named as the reason. */
  likedCreatorReason: 3,
  likedTopicReason: 2,
  candidates: {
    /** Your connections' posts from this many days (Reels: reelsGraphDays). */
    graphDays: 14,
    reelsGraphDays: 30,
    /** The newest posts (For you, from the last freshDays) and reels. */
    fresh: 1000,
    freshDays: 14,
    reelsFresh: 2000,
    /** Newest posts on your interests, and on your top learned topics. */
    interest: 300,
    learnedTopics: 10,
    learnedTopicPosts: 300,
    /** Your top learned creators and how many of each one's latest posts (from creatorDays). */
    learnedCreators: 50,
    perCreator: 10,
    creatorDays: 30,
    /** People like you: who engaged with what you engaged with (30 days), and what they engaged with since (14 days). */
    peers: 100,
    similarPeople: 300,
    mineDays: 30,
    peersDays: 14,
    /** Most momentum in the last day. */
    trending: 300,
    trendingHours: 24,
    /** Older posts (up to evergreenDays) with an engagement rate of at least evergreenRate. */
    evergreen: 100,
    evergreenDays: 60,
    evergreenRate: 0.15,
    /** Posts that haven't had their chance yet (see exploration). */
    exploration: 200,
  },
  /** What you already saw: hidden for seenDays on the same surface (unless very fresh from a friend); finished reels for completedDays. */
  seen: { days: 3, closeFriendHours: 12, completedDays: 7 },
  /**
   * New creators get seen: one slot in `every` goes to the best post (by a quality prior) from a
   * creator with an account under newCreatorDays or fewer than newCreatorPosts posts, or with fewer
   * than maxImpressions impressions, that hasn't had maxEngagement likes, comments and saves yet.
   */
  exploration: { every: 6, newCreatorDays: 30, newCreatorPosts: 5, maxImpressions: 50, maxEngagement: 3 },
  diversity: {
    /** A creator's posts after their first perAuthor score authorStep less each. */
    perAuthor: 2,
    authorStep: 1.5,
    /** No more than topicMax posts with the same main topic in any topicWindow in a row. */
    topicWindow: 10,
    topicMax: 3,
    /**
     * For you: after formatRun posts of one format (video, photo, text) in a row, the next is another
     * format when one scores within formatMargin of the best (variety never lifts a much weaker post).
     */
    formatRun: 2,
    formatMargin: 1,
    /** How far ahead to look for a post that fits. */
    lookahead: 60,
  },
  /** The ranked list kept for paging: at most this many posts. */
  sessionSize: 1500,
} as const;

export type RankSurface = 'for_you' | 'reels';

export interface RankOptions {
  userId: string;
  /** The feed's moment (the cursor's asOf): everything is ranked as of then. */
  asOf: string;
  surface: RankSurface;
  /** Personalization on: otherwise the same ranking for everyone, by quality, momentum and freshness. */
  personalized: boolean;
  /** The viewer's own filters (posts.ts PERSONAL_FILTERS, with the viewer as $1). */
  personal: string;
  /** For you with "Fewer suggestions": only your connections and communities. */
  reduced?: boolean;
  /** Reels: whether the viewer may see videos marked sensitive. */
  sensitiveOk?: boolean;
}

/** What the scoring needs to know about one candidate. */
export interface Features {
  id: string;
  authorId: string;
  createdAt: Date;
  topics: string[];
  kind: string;
  format: string;
  own: boolean;
  friend: boolean;
  followed: boolean;
  member: boolean;
  collabFriend: boolean;
  collabFollowed: boolean;
  interestN: number;
  moreN: number;
  lessN: number;
  topicAff: number;
  creatorAff: number;
  similarPeople: number;
  likes: number;
  comments: number;
  impressions: number;
  completes: number;
  skips: number;
  shares: number;
  saves: number;
  trend: number;
  ageHours: number;
  newCreator: boolean;
  /** For the reason: names and topics. */
  displayName?: string;
  collabName?: string | null;
  communityName?: string | null;
  matchedTopic?: string | null;
  learnedTopic?: string | null;
}

const ln1p = Math.log1p;

/** Smoothed engagement rate (RANKING.quality). */
export function engagementRate(f: Pick<Features, 'likes' | 'comments' | 'shares' | 'saves' | 'completes' | 'impressions'>): number {
  const q = RANKING.quality;
  return (q.likes * f.likes + q.comments * f.comments + q.shares * f.shares + q.saves * f.saves + q.completes * f.completes) / (f.impressions + q.smoothing);
}

/** What anyone would see in a post: how good, how lively, how new (and for reels, finished or skipped). */
function commonScore(f: Features): number {
  const W = RANKING.weights;
  let s = W.quality * ln1p(10 * engagementRate(f)) + W.reach * ln1p(f.likes + 2 * f.comments) + W.velocity * ln1p(Math.max(0, f.trend));
  if (f.format === 'reel') {
    const r = RANKING.reels;
    const completion = (f.completes + r.completionPrior * r.smoothing) / (f.impressions + r.smoothing);
    const skips = (f.skips + r.skipPrior * r.smoothing) / (f.impressions + r.smoothing);
    s += W.completion * (Math.min(1, completion) - r.completionPrior) - W.skip * (Math.min(1, skips) - r.skipPrior);
  }
  return s + W.freshness * Math.exp(-Math.max(0, f.ageHours) / RANKING.freshnessHours);
}

/** A post's score for this viewer (RANKING.weights). Without personalization only commonScore counts. */
export function scoreOf(f: Features, personalized: boolean): number {
  const s = commonScore(f);
  if (!personalized) return s;
  const W = RANKING.weights;
  let p = W.interest * f.interestN + W.moreLikeThis * f.moreN + W.lessLikeThis * f.lessN;
  p += W.topicAffinity * Math.tanh(f.topicAff / RANKING.topicScale);
  p += f.creatorAff > 0 ? W.creatorAffinity * ln1p(f.creatorAff) : W.creatorDislike * f.creatorAff;
  p += W.similarPeople * ln1p(Math.max(0, f.similarPeople));
  if (f.own) p += W.own;
  if (f.friend || f.collabFriend) p += W.friend;
  if (f.followed || (f.collabFollowed && !f.collabFriend)) p += W.follow;
  if (f.member) p += W.community;
  return s + p;
}

/** Whether a post may take an exploration slot: not from your connections, not proven yet, from someone new or barely seen. */
export function explorable(f: Features): boolean {
  const x = RANKING.exploration;
  if (f.own || f.friend || f.followed || f.member || f.collabFriend || f.collabFollowed) return false;
  if (f.likes + f.comments + f.saves >= x.maxEngagement) return false;
  return f.newCreator || f.impressions < x.maxImpressions;
}

/** The prior an exploration slot ranks by: the post's own (smoothed) quality and how new it is. */
function explorationPrior(f: Features): number {
  const W = RANKING.weights;
  return W.quality * ln1p(10 * engagementRate(f)) + W.freshness * Math.exp(-Math.max(0, f.ageHours) / RANKING.freshnessHours);
}

/** Why a post is in the feed: the strongest true reason, in this order. */
export function reasonOf(f: Features, surface: RankSurface, personalized: boolean): FeedReason {
  if (f.own) return { code: 'own' };
  if (!personalized) return f.communityName ? { code: 'community_popular', params: { community: f.communityName } } : { code: 'popular' };
  if (f.friend) return { code: 'friend', params: { name: f.displayName ?? '' } };
  if (f.collabFriend) return { code: 'friend', params: { name: f.collabName ?? '' } };
  if (f.followed) return { code: 'follow', params: { name: f.displayName ?? '' } };
  if (f.collabFollowed) return { code: 'follow', params: { name: f.collabName ?? '' } };
  if (f.communityName && f.member) return { code: 'community_member', params: { community: f.communityName } };
  if (f.matchedTopic) return { code: 'interest', params: { topic: f.matchedTopic } };
  if (f.creatorAff >= RANKING.likedCreatorReason) return { code: 'liked_creator', params: { name: f.displayName ?? '' } };
  if (f.learnedTopic) return { code: surface === 'reels' ? 'watched_topic' : 'liked_topic', params: { topic: f.learnedTopic } };
  if (f.similarPeople > 0) return { code: 'similar_people' };
  if (f.trend >= RANKING.trendingReason) return { code: 'trending' };
  if (f.communityName) return { code: 'community_popular', params: { community: f.communityName } };
  return { code: 'popular' };
}

const formatOf = (f: Pick<Features, 'kind' | 'format'>) =>
  f.format === 'reel' || f.kind === 'video' ? 'video' : f.kind === 'photo' || f.kind === 'carousel' ? 'photo' : 'text';

export interface Arranged {
  id: string;
  reason: FeedReason;
}

/**
 * The order of a feed from its scored candidates: the best first, every exploration slot to the
 * best explorable post, a creator's posts after their first few lower and lower, no more than
 * topicMax of one main topic (a post's first topic) in any topicWindow, and (mixFormats) no long
 * runs of one format. A post that doesn't fit waits for a place where it does: none is dropped.
 */
export function arrange(cands: Features[], opts: { personalized: boolean; surface: RankSurface; explore: boolean; mixFormats: boolean }): Arranged[] {
  const D = RANKING.diversity;
  const tie = (a: Features, b: Features) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
  const scored = cands.map((f) => ({ f, s: scoreOf(f, opts.personalized), main: f.topics[0] ?? null, format: formatOf(f) }));
  // The creator penalty: each author's posts in score order, the ones after the first perAuthor lower by authorStep each.
  scored.sort((a, b) => b.s - a.s || tie(a.f, b.f));
  const seenAuthor = new Map<string, number>();
  for (const x of scored) {
    const n = (seenAuthor.get(x.f.authorId) ?? 0) + 1;
    seenAuthor.set(x.f.authorId, n);
    x.s -= D.authorStep * Math.max(0, n - D.perAuthor);
  }
  scored.sort((a, b) => b.s - a.s || tie(a.f, b.f));
  type X = (typeof scored)[number];
  const pool: X[] = opts.explore
    ? scored
        .filter((x) => explorable(x.f))
        .map((x) => ({ x, prior: explorationPrior(x.f) }))
        .sort((a, b) => b.prior - a.prior || tie(a.x.f, b.x.f))
        .map((e) => e.x)
    : [];
  const placed = new Set<string>();
  const out: { x: X; explored: boolean }[] = [];
  const topicOk = (x: X) => {
    if (!x.main) return true;
    let n = 0;
    for (let i = Math.max(0, out.length - (D.topicWindow - 1)); i < out.length; i++) if (out[i]!.x.main === x.main) n++;
    return n < D.topicMax;
  };
  const formatOk = (x: X) => {
    if (!opts.mixFormats || out.length < D.formatRun) return true;
    for (let i = out.length - D.formatRun; i < out.length; i++) if (out[i]!.x.format !== x.format) return true;
    return false;
  };
  let head = 0;
  let poolHead = 0;
  while (out.length < scored.length) {
    let pick: X | undefined;
    let explored = false;
    if (pool.length && out.length % RANKING.exploration.every === RANKING.exploration.every - 1) {
      while (poolHead < pool.length && placed.has(pool[poolHead]!.f.id)) poolHead++;
      for (let i = poolHead, looked = 0; i < pool.length && looked < D.lookahead; i++) {
        const x = pool[i]!;
        if (placed.has(x.f.id)) continue;
        looked++;
        if (topicOk(x)) {
          pick = x;
          explored = true;
          break;
        }
      }
    }
    if (!pick) {
      while (head < scored.length && placed.has(scored[head]!.f.id)) head++;
      const window: X[] = [];
      for (let i = head; i < scored.length && window.length < D.lookahead; i++) if (!placed.has(scored[i]!.f.id)) window.push(scored[i]!);
      const best = window.find(topicOk) ?? window[0];
      const mixed = best && !formatOk(best) ? window.find((x) => topicOk(x) && formatOk(x) && x.s >= best.s - D.formatMargin) : undefined;
      pick = mixed ?? best;
    }
    if (!pick) break;
    placed.add(pick.f.id);
    out.push({ x: pick, explored });
  }
  return out.map(({ x, explored }) => {
    const reason = reasonOf(x.f, opts.surface, opts.personalized);
    // A new creator's post in an exploration slot says so, unless there's something more personal to say.
    const general = reason.code === 'popular' || reason.code === 'trending' || reason.code === 'community_popular';
    return { id: x.f.id, reason: explored && x.f.newCreator && general ? { code: 'new_creator' } : reason };
  });
}

/** The candidate and feature query for one viewer (see the module comment). */
function rankingSql(o: RankOptions): { sql: string; params: unknown[] } {
  const C = RANKING.candidates;
  const reels = o.surface === 'reels';
  const at = '$2::timestamptz';
  const fmt = reels ? `AND p.format = 'reel'` : '';
  const live = `p.deleted_at IS NULL AND p.status = 'published' AND p.created_at <= ${at} ${fmt}`;
  const since = (n: number, unit = 'days') => `AND p.created_at > ${at} - interval '${n} ${unit}'`;
  const faded = (t: string) => fadedScoreSql(t, at);
  const P = o.personalized;
  const graphDays = reels ? C.reelsGraphDays : C.graphDays;

  const me = P
    ? `SELECT coalesce((SELECT array_agg(t.slug) FROM user_interests ui JOIN topics t ON t.id = ui.topic_id WHERE ui.user_id = $1), '{}') AS interests,
              coalesce((SELECT array_agg(DISTINCT x) FROM feed_feedback ff JOIN posts p2 ON p2.id = ff.post_id, unnest(p2.topics) x
                        WHERE ff.user_id = $1 AND ff.signal = 'more_like_this'), '{}') AS more,
              coalesce((SELECT array_agg(DISTINCT x) FROM feed_feedback ff JOIN posts p2 ON p2.id = ff.post_id, unnest(p2.topics) x
                        WHERE ff.user_id = $1 AND ff.signal = 'less_like_this'), '{}') AS less,
              coalesce((SELECT jsonb_object_agg(a.topic, ${faded('a')}) FROM user_topic_affinity a WHERE a.user_id = $1), '{}'::jsonb) AS taff,
              coalesce((SELECT array_agg(z.topic) FROM (SELECT a.topic FROM user_topic_affinity a WHERE a.user_id = $1 AND ${faded('a')} > 0.5
                                                         ORDER BY ${faded('a')} DESC LIMIT ${C.learnedTopics}) z), '{}') AS top_topics`
    : `SELECT '{}'::text[] AS interests, '{}'::text[] AS more, '{}'::text[] AS less, '{}'::jsonb AS taff, '{}'::text[] AS top_topics`;

  const personalCtes = P
    ? `caff AS (SELECT a.author_id, ${faded('a')} AS s FROM user_creator_affinity a WHERE a.user_id = $1),
       mine AS (
         (SELECT r.post_id FROM reactions r WHERE r.user_id = $1 AND r.created_at > ${at} - interval '${C.mineDays} days' AND r.created_at <= ${at} ORDER BY r.created_at DESC LIMIT 100)
         UNION (SELECT s.post_id FROM saves s WHERE s.user_id = $1 AND s.created_at > ${at} - interval '${C.mineDays} days' AND s.created_at <= ${at} ORDER BY s.created_at DESC LIMIT 100)
         UNION (SELECT e.post_id FROM feed_events e WHERE e.user_id = $1 AND e.kind = 'complete' AND e.created_at > ${at} - interval '${C.mineDays} days' AND e.created_at <= ${at}
                ORDER BY e.created_at DESC LIMIT 100)
       ),
       -- People who engaged with what you engaged with (and haven't turned Personalization off), the most overlap first.
       peers AS (
         SELECT x.user_id, count(*)::real AS n FROM (
           SELECT r.user_id, r.post_id FROM mine m JOIN reactions r ON r.post_id = m.post_id
           UNION SELECT s.user_id, s.post_id FROM mine m JOIN saves s ON s.post_id = m.post_id
           UNION SELECT e.user_id, e.post_id FROM mine m JOIN feed_events e ON e.post_id = m.post_id AND e.kind = 'complete' AND e.created_at > ${at} - interval '${C.mineDays} days'
         ) x
         WHERE x.user_id <> $1 AND NOT EXISTS (SELECT 1 FROM consents cs WHERE cs.user_id = x.user_id AND cs.purpose = 'personalization' AND NOT cs.granted)
         GROUP BY x.user_id ORDER BY n DESC LIMIT ${C.peers}
       ),
       alike AS (
         SELECT y.post_id, sum(y.n)::real AS n FROM (
           SELECT pe.n, z.post_id FROM peers pe CROSS JOIN LATERAL (
             (SELECT r.post_id FROM reactions r WHERE r.user_id = pe.user_id AND r.created_at > ${at} - interval '${C.peersDays} days' AND r.created_at <= ${at} ORDER BY r.created_at DESC LIMIT 50)
             UNION (SELECT s.post_id FROM saves s WHERE s.user_id = pe.user_id AND s.created_at > ${at} - interval '${C.peersDays} days' AND s.created_at <= ${at} ORDER BY s.created_at DESC LIMIT 50)
             UNION (SELECT e.post_id FROM feed_events e WHERE e.user_id = pe.user_id AND e.kind = 'complete' AND e.created_at > ${at} - interval '${C.peersDays} days' AND e.created_at <= ${at}
                    ORDER BY e.created_at DESC LIMIT 50)
           ) z
         ) y
         WHERE y.post_id NOT IN (SELECT post_id FROM mine)
         GROUP BY y.post_id ORDER BY 2 DESC LIMIT ${C.similarPeople}
       ),`
    : `caff AS (SELECT NULL::uuid AS author_id, 0::real AS s WHERE false),
       alike AS (SELECT NULL::uuid AS post_id, 0::real AS n WHERE false),`;

  const people = reels
    ? `SELECT id FROM followed UNION SELECT id FROM friends`
    : `SELECT $1::uuid AS id UNION SELECT id FROM followed UNION SELECT id FROM friends`;
  const sources: string[] = [];
  if (P) {
    sources.push(
      `SELECT p.id FROM (${people}) a JOIN posts p ON p.author_id = a.id WHERE ${live} ${since(graphDays)}`,
      `SELECT pc.post_id FROM (${people}) a JOIN post_collaborators pc ON pc.user_id = a.id AND pc.status = 'accepted'
       JOIN posts p ON p.id = pc.post_id WHERE ${live} ${since(graphDays)}`,
    );
    if (!reels)
      sources.push(`SELECT p.id FROM community_members cm JOIN posts p ON p.community_id = cm.community_id
                    WHERE cm.user_id = $1 AND cm.status = 'active' AND ${live} ${since(C.graphDays)}`);
    sources.push(
      // Your interests (cold start) and your top learned topics, through the topics GIN index.
      `(SELECT p.id FROM posts p CROSS JOIN me WHERE cardinality(me.interests) > 0 AND p.topics && me.interests AND ${live} ${since(C.freshDays)}
        ORDER BY p.created_at DESC, p.id DESC LIMIT ${C.interest})`,
      `(SELECT p.id FROM posts p CROSS JOIN me WHERE cardinality(me.top_topics) > 0 AND p.topics && me.top_topics AND ${live} ${since(C.freshDays)}
        ORDER BY p.created_at DESC, p.id DESC LIMIT ${C.learnedTopicPosts})`,
      `SELECT x.id FROM (SELECT author_id FROM caff WHERE s > 0.5 ORDER BY s DESC LIMIT ${C.learnedCreators}) tc
       CROSS JOIN LATERAL (SELECT p.id FROM posts p WHERE p.author_id = tc.author_id AND ${live} ${since(C.creatorDays)}
                           ORDER BY p.created_at DESC LIMIT ${C.perCreator}) x`,
      `SELECT p.id FROM alike sm JOIN posts p ON p.id = sm.post_id WHERE ${live}`,
      `(SELECT p.id FROM posts p JOIN users au ON au.id = p.author_id LEFT JOIN post_stats ps ON ps.post_id = p.id
        WHERE ${live} ${since(C.freshDays)} AND p.author_id <> $1
          AND p.like_count + p.comment_count + coalesce(ps.saves, 0) < ${RANKING.exploration.maxEngagement}
          AND (au.created_at > ${at} - interval '${RANKING.exploration.newCreatorDays} days' OR coalesce(ps.impressions, 0) < ${RANKING.exploration.maxImpressions})
        ORDER BY p.created_at DESC, p.id DESC LIMIT ${C.exploration})`,
    );
  } else if (!reels) {
    sources.push(`SELECT p.id FROM posts p WHERE p.author_id = $1 AND ${live} ${since(C.freshDays)}`);
  }
  sources.push(
    reels
      ? `(SELECT p.id FROM posts p WHERE ${live} ORDER BY p.created_at DESC, p.id DESC LIMIT ${C.reelsFresh})`
      : `(SELECT p.id FROM posts p WHERE ${live} ${since(C.freshDays)} ORDER BY p.created_at DESC, p.id DESC LIMIT ${C.fresh})`,
    `(SELECT p.id FROM post_stats ps JOIN posts p ON p.id = ps.post_id
      WHERE ps.trend > 0 AND ps.trend_at > ${at} - interval '${C.trendingHours} hours' AND ${live} ${since(C.creatorDays)}
      ORDER BY ${trendSql(at)} DESC LIMIT ${C.trending})`,
    `(SELECT p.id FROM posts p LEFT JOIN post_stats ps ON ps.post_id = p.id
      WHERE ${live} ${since(C.evergreenDays)} AND p.created_at <= ${at} - interval '${C.freshDays} days'
        AND ${rateSql} >= ${C.evergreenRate}
      ORDER BY ${rateSql} DESC LIMIT ${C.evergreen})`,
  );

  const connectionOnly =
    o.reduced && !reels
      ? `AND (p.author_id = $1 OR p.author_id IN (SELECT id FROM followed)
              OR EXISTS (SELECT 1 FROM community_members cm WHERE cm.community_id = p.community_id AND cm.user_id = $1))`
      : '';
  const S = RANKING.seen;
  const unseen = P
    ? `AND (NOT EXISTS (SELECT 1 FROM feed_events fe WHERE fe.user_id = $1 AND fe.post_id = p.id AND fe.kind = 'impression' AND fe.surface = '${o.surface}'
                         AND fe.created_at > ${at} - interval '${S.days} days' AND fe.created_at <= ${at})
         OR (p.created_at > ${at} - interval '${S.closeFriendHours} hours'
             AND (p.author_id IN (SELECT id FROM friends) OR EXISTS (SELECT 1 FROM close_friends cf WHERE cf.owner_id = $1 AND cf.friend_id = p.author_id))))
       AND (p.format <> 'reel' OR NOT EXISTS (SELECT 1 FROM feed_events fe WHERE fe.user_id = $1 AND fe.post_id = p.id AND fe.kind = 'complete'
                                               AND fe.created_at > ${at} - interval '${S.completedDays} days'))`
    : '';
  const reelRules = reels
    ? `AND p.format = 'reel' AND p.moderation_status = 'normal'
       AND ($3 OR NOT EXISTS (SELECT 1 FROM post_media pm JOIN media m ON m.id = pm.media_id WHERE pm.post_id = p.id AND m.moderation = 'sensitive'))`
    : '';
  const X = RANKING.exploration;

  const sql = `WITH me AS (${me}),
    followed AS (SELECT followee_id AS id FROM follows WHERE follower_id = $1),
    friends AS (SELECT user_b AS id FROM friendships WHERE user_a = $1 UNION ALL SELECT user_a FROM friendships WHERE user_b = $1),
    ${personalCtes}
    candidates AS (${sources.join('\n UNION \n')})
    SELECT p.id, p.author_id, p.created_at, p.topics, p.kind, p.format, ap.display_name, cm_c.name AS community_name, (cm_self.user_id IS NOT NULL) AS member,
           p.author_id IN (SELECT id FROM followed) AS followed,
           p.author_id IN (SELECT id FROM friends) AS friend,
           -- A co-author you follow or are friends with counts like the author.
           (SELECT cpr.display_name FROM post_collaborators pc JOIN profiles cpr ON cpr.user_id = pc.user_id
            WHERE pc.post_id = p.id AND pc.status = 'accepted' AND (pc.user_id IN (SELECT id FROM followed) OR pc.user_id IN (SELECT id FROM friends))
            ORDER BY (pc.user_id IN (SELECT id FROM friends)) DESC, pc.created_at LIMIT 1) AS collab_name,
           EXISTS (SELECT 1 FROM post_collaborators pc WHERE pc.post_id = p.id AND pc.status = 'accepted' AND pc.user_id IN (SELECT id FROM friends)) AS collab_friend,
           (SELECT count(*) FROM unnest(p.topics) t WHERE t = ANY(me.interests))::int AS interest_n,
           (SELECT count(*) FROM unnest(p.topics) t WHERE t = ANY(me.more))::int AS more_n,
           (SELECT count(*) FROM unnest(p.topics) t WHERE t = ANY(me.less))::int AS less_n,
           (SELECT t FROM unnest(p.topics) t WHERE t = ANY(me.interests) LIMIT 1) AS matched_topic,
           coalesce((SELECT sum((me.taff ->> t)::real) FROM unnest(p.topics) t), 0)::real AS topic_aff,
           (SELECT t FROM unnest(p.topics) t WHERE (me.taff ->> t)::real >= ${RANKING.likedTopicReason} ORDER BY (me.taff ->> t)::real DESC LIMIT 1) AS learned_topic,
           coalesce(ca.s, 0)::real AS creator_aff,
           coalesce(sm.n, 0)::real AS similar_n,
           p.like_count, p.comment_count,
           coalesce(ps.impressions, 0) AS impressions, coalesce(ps.completes, 0) AS completes, coalesce(ps.skips, 0) AS skips,
           coalesce(ps.shares, 0) AS shares, coalesce(ps.saves, 0) AS saves,
           ${trendSql(at)}::real AS trend,
           (extract(epoch FROM (${at} - p.created_at)) / 3600.0)::real AS age_hours,
           (au.created_at > ${at} - interval '${X.newCreatorDays} days'
            OR (SELECT count(*) FROM (SELECT 1 FROM posts p3 WHERE p3.author_id = p.author_id AND p3.deleted_at IS NULL AND p3.status = 'published' LIMIT ${X.newCreatorPosts}) z) < ${X.newCreatorPosts}) AS new_creator
    -- Driven by the candidates (each looked up by id), so the checks below run on them only, however many posts there are.
    FROM (SELECT id FROM candidates) c JOIN posts p ON p.id = c.id
    JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
    CROSS JOIN me
    LEFT JOIN communities cm_c ON cm_c.id = p.community_id
    LEFT JOIN community_members cm_self ON cm_self.community_id = p.community_id AND cm_self.user_id = $1 AND cm_self.status = 'active'
    LEFT JOIN post_stats ps ON ps.post_id = p.id
    LEFT JOIN caff ca ON ca.author_id = p.author_id
    LEFT JOIN alike sm ON sm.post_id = p.id
    WHERE ${postVisibleSql('$1')} ${o.personal} ${connectionOnly} ${reelRules} ${unseen}
      AND (p.community_id IS NULL OR cm_self.user_id IS NOT NULL OR cm_c.visibility = 'public')`;
  return { sql, params: reels ? [o.userId, o.asOf, !!o.sensitiveOk] : [o.userId, o.asOf] };
}

/** The smoothed engagement rate in SQL (posts `p`, post_stats `ps`), as engagementRate. */
const rateSql = (() => {
  const q = RANKING.quality;
  return `((${q.likes} * p.like_count + ${q.comments} * p.comment_count + ${q.shares} * coalesce(ps.shares, 0) + ${q.saves} * coalesce(ps.saves, 0)
            + ${q.completes} * coalesce(ps.completes, 0))::real / (coalesce(ps.impressions, 0) + ${q.smoothing}))`;
})();

/** Rank a feed for one viewer: every candidate in order, with its reason. */
export async function rankFeed(db: Q, o: RankOptions): Promise<Arranged[]> {
  const { sql, params } = rankingSql(o);
  const { rows } = await db.query(sql, params);
  const feats: Features[] = rows.map((r) => ({
    id: r.id,
    authorId: r.author_id,
    createdAt: new Date(r.created_at),
    topics: r.topics ?? [],
    kind: r.kind,
    format: r.format,
    own: r.author_id === o.userId,
    friend: r.friend,
    followed: r.followed,
    member: r.member,
    collabFriend: r.collab_friend,
    collabFollowed: !!r.collab_name && !r.collab_friend,
    interestN: r.interest_n,
    moreN: r.more_n,
    lessN: r.less_n,
    topicAff: Number(r.topic_aff),
    creatorAff: Number(r.creator_aff),
    similarPeople: Number(r.similar_n),
    likes: r.like_count,
    comments: r.comment_count,
    impressions: Number(r.impressions),
    completes: Number(r.completes),
    skips: Number(r.skips),
    shares: Number(r.shares),
    saves: Number(r.saves),
    trend: Number(r.trend),
    ageHours: Number(r.age_hours),
    newCreator: r.new_creator,
    displayName: r.display_name,
    collabName: r.collab_name,
    communityName: r.community_name,
    matchedTopic: r.matched_topic,
    learnedTopic: r.learned_topic,
  }));
  return arrange(feats, { personalized: o.personalized, surface: o.surface, explore: o.personalized, mixFormats: o.surface === 'for_you' }).slice(
    0,
    RANKING.sessionSize,
  );
}

/** A feed's cursor: the moment it was ranked, where the next page starts, and its kept order (feed_sessions). */
interface RankCursor {
  asOf: string;
  o: number;
  s?: string;
}

/**
 * One page of a ranked feed. The first page ranks (rankFeed) and keeps the order; the next pages
 * read from it, so nothing repeats or is skipped while you scroll. Each page is checked again
 * against who may see what and your filters (someone you blocked a moment ago stays out). A
 * cursor whose kept order is gone (a day old, or from before) ranks again as of its moment.
 */
export async function rankedPage(
  db: Q,
  o: Omit<RankOptions, 'asOf'>,
  cursor: string | undefined,
  limit: number,
): Promise<{ items: Arranged[]; nextCursor: string | null }> {
  const c = decodeCursor<RankCursor>(cursor) ?? {
    // The window starts at the database's clock, not this process's: a post written a moment ago must be inside it.
    asOf: ((await db.query<{ t: Date }>(`SELECT now() AS t`)).rows[0]!.t as Date).toISOString(),
    o: 0,
  };
  let session = c.s ?? null;
  if (session) {
    const { rows } = await db.query<{ post_ids: string[]; reasons: FeedReason[]; total: number }>(
      `SELECT post_ids[$3 + 1 : $3 + $4] AS post_ids,
              (SELECT coalesce(jsonb_agg(e ORDER BY i), '[]') FROM jsonb_array_elements(reasons) WITH ORDINALITY x(e, i) WHERE i > $3 AND i <= $3 + $4) AS reasons,
              cardinality(post_ids) AS total
       FROM feed_sessions WHERE id = $1 AND user_id = $2 AND surface = $5`,
      [session, o.userId, c.o, limit, o.surface],
    );
    const r = rows[0];
    if (r) {
      const items = r.post_ids.map((id, i) => ({ id, reason: r.reasons[i] ?? { code: 'popular' as const } }));
      return { items: await stillShown(db, o, items), nextCursor: c.o + limit < r.total ? encodeCursor({ asOf: c.asOf, o: c.o + limit, s: session }) : null };
    }
    session = null;
  }
  const list = await rankFeed(db, { ...o, asOf: c.asOf });
  const page = list.slice(c.o, c.o + limit);
  if (c.o + limit >= list.length) return { items: page, nextCursor: null };
  // Keep the order for the next pages (and clear this person's old ones on the way).
  await db.query(`DELETE FROM feed_sessions WHERE user_id = $1 AND surface = $2 AND created_at < now() - interval '1 day'`, [o.userId, o.surface]);
  session = (
    await db.query<{ id: string }>(`INSERT INTO feed_sessions (user_id, surface, post_ids, reasons) VALUES ($1, $2, $3::uuid[], $4::jsonb) RETURNING id`, [
      o.userId,
      o.surface,
      list.map((x) => x.id),
      JSON.stringify(list.map((x) => x.reason)),
    ])
  ).rows[0]!.id;
  return { items: page, nextCursor: encodeCursor({ asOf: c.asOf, o: c.o + limit, s: session }) };
}

/** The posts of a kept page that the viewer may still see, in order. */
async function stillShown(db: Q, o: Omit<RankOptions, 'asOf'>, items: Arranged[]): Promise<Arranged[]> {
  if (!items.length) return items;
  const reels = o.surface === 'reels';
  const { rows } = await db.query<{ id: string }>(
    `SELECT p.id FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
     WHERE p.id = ANY($2::uuid[]) AND ${postVisibleSql('$1')} ${o.personal}
       ${reels ? `AND p.moderation_status = 'normal' AND ($3 OR NOT EXISTS (SELECT 1 FROM post_media pm JOIN media m ON m.id = pm.media_id WHERE pm.post_id = p.id AND m.moderation = 'sensitive'))` : ''}`,
    reels ? [o.userId, items.map((x) => x.id), !!o.sensitiveOk] : [o.userId, items.map((x) => x.id)],
  );
  const ok = new Set(rows.map((r) => r.id));
  return items.filter((x) => ok.has(x.id));
}
