import type { Pool, PoolClient } from 'pg';
import { personalizationAllowed } from './services.ts';

type Q = Pool | PoolClient;

/**
 * What the recommender learns about each person: a score per topic (user_topic_affinity) and per
 * creator (user_creator_affinity), from what they do. Every write goes through here.
 *
 * Each signal adds its delta to the scores of the post's topics and its author. Scores fade with
 * time: new = old × exp(−days since the last change / fadeDays) + delta, kept within [min, max],
 * so what you did last week counts more than what you did in spring, and one burst can't run away.
 * Nothing is learned while Personalization is off (and turning it off forgets it all, see
 * forgetLearnedTaste); your own posts teach nothing. docs/product/recommendations.md explains the
 * numbers in plain words: change them there too.
 */
export const AFFINITY = {
  /** Scores fade by e every this many days (about half in two weeks). */
  fadeDays: 21,
  min: -10,
  max: 30,
  /** A dwell counts once the post stayed on screen this long. */
  dwellMs: 8000,
  /** A watch counts once this share of the video played. */
  watchShare: 0.5,
  /** At most this many of a post's topics learn from it. */
  topicsPerPost: 8,
  /** How much each signal moves the post's topics and its creator. */
  deltas: {
    like: { topic: 1, creator: 1 },
    unlike: { topic: -1, creator: -1 },
    comment: { topic: 2, creator: 2 },
    save: { topic: 2.5, creator: 2.5 },
    unsave: { topic: -2.5, creator: -2.5 },
    share: { topic: 3, creator: 3 },
    complete: { topic: 1.5, creator: 1.5 },
    dwell: { topic: 0.5, creator: 0.5 },
    watch: { topic: 0.8, creator: 0.8 },
    profile_open: { topic: 0, creator: 0.7 },
    follow: { topic: 0, creator: 4 },
    unfollow: { topic: 0, creator: -4 },
    skip: { topic: -0.6, creator: -0.6 },
    not_interested: { topic: -3, creator: -3 },
    more_like_this: { topic: 2, creator: 0 },
    less_like_this: { topic: -2, creator: 0 },
    // Muted creators and topics are already left out of every feed; this keeps them out of what
    // the recommender reaches for (top topics and creators) too.
    mute_creator: { topic: 0, creator: -10 },
    mute_topic: { topic: -10, creator: 0 },
  },
} as const;

export type AffinitySignal = keyof typeof AFFINITY.deltas;

/** One thing someone did, about a post (its author and topics) or straight about a creator or topics. */
export interface Learning {
  signal: AffinitySignal;
  authorId?: string | null;
  topics?: string[];
}

/** A score as of `at` (SQL): faded since it last changed. `t` is the affinity table's alias. */
export const fadedScoreSql = (t: string, at: string) =>
  `(${t}.score * exp(-greatest(0, extract(epoch FROM (${at} - ${t}.updated_at))) / 86400.0 / ${AFFINITY.fadeDays}))`;

/**
 * Learn from what someone did. `allowed` is whether Personalization is on, when the caller already
 * knows (otherwise it's looked up). Signals about the person's own posts are ignored.
 */
export async function learn(db: Q, userId: string, items: Learning[], allowed?: boolean): Promise<void> {
  if (!items.length) return;
  if (!(allowed ?? (await personalizationAllowed(db, userId)))) return;
  const topics = new Map<string, number>();
  const creators = new Map<string, number>();
  for (const it of items) {
    if (it.authorId === userId) continue;
    const d = AFFINITY.deltas[it.signal];
    if (d.creator && it.authorId) creators.set(it.authorId, (creators.get(it.authorId) ?? 0) + d.creator);
    if (d.topic)
      for (const t of [...new Set(it.topics ?? [])].slice(0, AFFINITY.topicsPerPost)) {
        const k = t.toLowerCase();
        topics.set(k, (topics.get(k) ?? 0) + d.topic);
      }
  }
  const fade = `exp(-greatest(0, extract(epoch FROM (now() - a.updated_at))) / 86400.0 / ${AFFINITY.fadeDays})`;
  const clamp = (x: string) => `greatest(${AFFINITY.min}, least(${AFFINITY.max}, ${x}))`;
  if (topics.size)
    await db.query(
      `INSERT INTO user_topic_affinity AS a (user_id, topic, score, updated_at)
       SELECT $1, x.topic, ${clamp('x.delta')}, now() FROM unnest($2::text[], $3::real[]) AS x(topic, delta)
       ON CONFLICT (user_id, topic) DO UPDATE SET score = ${clamp(`a.score * ${fade} + EXCLUDED.score`)}, updated_at = now()`,
      [userId, [...topics.keys()], [...topics.values()]],
    );
  if (creators.size)
    await db.query(
      `INSERT INTO user_creator_affinity AS a (user_id, author_id, score, updated_at)
       SELECT $1, x.author_id, ${clamp('x.delta')}, now() FROM unnest($2::uuid[], $3::real[]) AS x(author_id, delta)
       WHERE x.author_id <> $1 AND EXISTS (SELECT 1 FROM users u WHERE u.id = x.author_id)
       ON CONFLICT (user_id, author_id) DO UPDATE SET score = ${clamp(`a.score * ${fade} + EXCLUDED.score`)}, updated_at = now()`,
      [userId, [...creators.keys()], [...creators.values()]],
    );
}

/** Learn from something done to a post: its author and topics are read here. */
export async function learnFromPost(db: Q, userId: string, postId: string, signal: AffinitySignal, allowed?: boolean): Promise<void> {
  if (!(allowed ?? (await personalizationAllowed(db, userId)))) return;
  const p = (await db.query<{ author_id: string; topics: string[] }>(`SELECT author_id, topics FROM posts WHERE id = $1`, [postId])).rows[0];
  if (p) await learn(db, userId, [{ signal, authorId: p.author_id, topics: p.topics }], true);
}

/** Learn without letting a failure undo what the person did (the like, the follow…): logged and dropped. */
export function learnQuietly(work: Promise<void>, log?: { warn: (o: object, msg: string) => void }): Promise<void> {
  return work.catch((err) => log?.warn({ err: (err as Error).message }, 'affinity'));
}

/** Forget what was learned about someone (Personalization turned off): their scores and their ranked feeds. */
export async function forgetLearnedTaste(db: Q, userId: string): Promise<void> {
  await db.query(`DELETE FROM user_topic_affinity WHERE user_id = $1`, [userId]);
  await db.query(`DELETE FROM user_creator_affinity WHERE user_id = $1`, [userId]);
  await db.query(`DELETE FROM feed_sessions WHERE user_id = $1`, [userId]);
}
