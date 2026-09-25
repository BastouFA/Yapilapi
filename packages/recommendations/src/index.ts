/**
 * YAPILAPI ranking. A deliberately simple, explainable, tunable scoring function.
 * It is pure (no I/O) so it can be unit-tested, evaluated offline, and swapped for an ML ranker later
 * behind the same `rank()` signature.
 *
 * Design goals (see docs/product/feed.md): relationships first, topics you chose second,
 * quality signals third, freshness throughout, plus diversity and a small exploration bonus so
 * the feed does not collapse into an echo chamber. Every score carries human-readable reasons
 * ("Why am I seeing this?").
 */

export interface Candidate {
  id: string;
  authorId: string;
  authorUsername: string;
  ageHours: number;
  likeCount: number;
  commentCount: number;
  shareCount: number;
  saveCount: number;
  isFollowing: boolean;
  isFriend: boolean;
  inMyCommunity: boolean;
  /** Names of topics that are both on the post and in the viewer's interests. */
  matchedTopics: string[];
  /** The viewer previously tapped "less like this" on this author's content. */
  lessLikeThisAuthor: boolean;
  /** Distance to the viewer in km when known. */
  distanceKm?: number;
}

export interface RankedCandidate extends Candidate {
  score: number;
  reasons: string[];
}

export interface Weights {
  friend: number;
  following: number;
  community: number;
  topicEach: number;
  topicMax: number;
  engagement: number;
  freshness: number;
  freshnessHalfLifeHours: number;
  exploration: number;
  lessLikeThis: number;
  nearby: number;
}

export const DEFAULT_WEIGHTS: Weights = {
  friend: 3,
  following: 2,
  community: 1,
  topicEach: 0.8,
  topicMax: 3,
  engagement: 0.6,
  freshness: 2,
  freshnessHalfLifeHours: 36,
  exploration: 0.4,
  lessLikeThis: -3,
  nearby: 0.6,
};

export function scoreCandidate(
  c: Candidate,
  w: Weights = DEFAULT_WEIGHTS,
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  if (c.isFriend) {
    score += w.friend;
    reasons.push(`@${c.authorUsername} is your friend`);
  } else if (c.isFollowing) {
    score += w.following;
    reasons.push(`You follow @${c.authorUsername}`);
  }
  if (c.inMyCommunity) {
    score += w.community;
    reasons.push('From a community you are in');
  }

  const topics = Math.min(c.matchedTopics.length, w.topicMax);
  if (topics > 0) {
    score += topics * w.topicEach;
    reasons.push(`Matches your interests: ${c.matchedTopics.slice(0, 3).join(', ')}`);
  }

  const engagement = c.likeCount + 2 * c.commentCount + 3 * c.shareCount + 2 * c.saveCount;
  if (engagement > 0) {
    score += w.engagement * Math.log1p(engagement);
    if (engagement >= 20) reasons.push('Popular right now');
  }

  const fresh = Math.pow(0.5, Math.max(0, c.ageHours) / w.freshnessHalfLifeHours);
  score += w.freshness * fresh;

  if (c.distanceKm !== undefined && c.distanceKm <= 25) {
    score += w.nearby * (1 - c.distanceKm / 25);
    reasons.push('Near you');
  }

  // Exploration: a small nudge for on-topic posts from people you don't follow yet.
  if (!c.isFollowing && !c.isFriend && topics > 0) score += w.exploration;
  if (c.lessLikeThisAuthor) {
    score += w.lessLikeThis;
    reasons.push('You asked for less like this from this account');
  }

  if (reasons.length === 0) reasons.push('Recent post from your network of interests');
  return { score, reasons };
}

/** Reorder so no author appears more than `maxRun` times in a row where alternatives exist. */
export function diversify<T extends { authorId: string }>(items: T[], maxRun = 2): T[] {
  const remaining = [...items];
  const out: T[] = [];
  while (remaining.length) {
    const tail = out.slice(-maxRun);
    const blocked =
      tail.length === maxRun && tail.every((t) => t.authorId === tail[0]!.authorId)
        ? tail[0]!.authorId
        : null;
    let idx = blocked ? remaining.findIndex((r) => r.authorId !== blocked) : 0;
    if (idx === -1) idx = 0; // nothing else left; accept the run
    out.push(remaining.splice(idx, 1)[0]!);
  }
  return out;
}

export function rank(
  candidates: Candidate[],
  weights: Weights = DEFAULT_WEIGHTS,
  maxRun = 2,
): RankedCandidate[] {
  const scored = candidates.map((c) => ({ ...c, ...scoreCandidate(c, weights) }));
  scored.sort((a, b) => b.score - a.score || (a.id < b.id ? 1 : -1));
  return diversify(scored, maxRun);
}
