/**
 * Behaviour-based spam scoring. Complements the content classifier: it looks at HOW an account behaves
 * (velocity, repetition, link stuffing, account age), not at what a single message says. Pure and unit tested;
 * the API collects the sample from the database (apps/api/src/lib/safety-signals.ts).
 *
 * Output is a 0-100 score plus explainable reasons. Callers decide what to do:
 *   ok (< 40)          nothing
 *   suspicious (40-69) queue for human review, do not restrict
 *   spam (>= 70)       restrict the content pending review
 * Thresholds are deliberately high: normal (even enthusiastic) usage must never trip them.
 */

export type SpamSurface = 'post' | 'comment' | 'message' | 'follow' | 'review';

export interface BehaviorSample {
  surface: SpamSurface;
  /** Activity counts for the actor, INCLUDING the item being scored. */
  postsLastHour: number;
  commentsLast10Min: number;
  messagesLast10Min: number;
  followsLastHour: number;
  /** How many recent items (same surface, last 24h) by this actor have identical normalized text, including this one. */
  duplicateCount: number;
  /** Distinct recipients/threads the duplicate text went to (messages) - 1 means the same place. */
  duplicateTargets?: number;
  accountAgeHours: number;
  text?: string;
}

export interface SpamAssessment {
  score: number;
  level: 'ok' | 'suspicious' | 'spam';
  reasons: string[];
}

export const SPAM_THRESHOLDS = { suspicious: 40, spam: 70 } as const;

/** Lowercase, strip urls/digits/punctuation and collapse whitespace so trivially varied copies compare equal. */
export function normalizeForDuplicate(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' <url> ')
    .replace(/[0-9]+/g, '#')
    .replace(/[^\p{L}\p{N}#<>\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const countLinks = (text: string): number => (text.match(/https?:\/\/\S+/gi) ?? []).length;
export const countMentions = (text: string): number =>
  (text.match(/(^|\s)@[a-z0-9_]{3,30}/gi) ?? []).length;

interface Rule {
  name: string;
  points: (s: BehaviorSample) => number;
}

const RULES: Rule[] = [
  {
    name: 'post_velocity',
    points: (s) =>
      s.surface === 'post' && s.postsLastHour > 40
        ? 45
        : s.surface === 'post' && s.postsLastHour > 25
          ? 25
          : 0,
  },
  {
    name: 'comment_velocity',
    points: (s) =>
      s.surface === 'comment' && s.commentsLast10Min > 40
        ? 45
        : s.surface === 'comment' && s.commentsLast10Min > 25
          ? 25
          : 0,
  },
  {
    name: 'message_velocity',
    points: (s) =>
      s.surface === 'message' && s.messagesLast10Min > 60
        ? 45
        : s.surface === 'message' && s.messagesLast10Min > 30
          ? 25
          : 0,
  },
  {
    name: 'follow_velocity',
    points: (s) =>
      s.surface === 'follow' && s.followsLastHour > 80
        ? 60
        : s.surface === 'follow' && s.followsLastHour > 40
          ? 40
          : 0,
  },
  {
    // Repeating the same non-trivial text over and over is the classic spam signature.
    name: 'duplicate_content',
    points: (s) => {
      if (!s.text || normalizeForDuplicate(s.text).length < 20) return 0;
      if (s.duplicateCount >= 12) return 75;
      if (s.duplicateCount >= 8) return 60;
      if (s.duplicateCount >= 5) return 40;
      if (s.duplicateCount >= 3) return 15;
      return 0;
    },
  },
  {
    name: 'duplicate_across_targets',
    points: (s) => ((s.duplicateTargets ?? 0) >= 5 && s.duplicateCount >= 5 ? 25 : 0),
  },
  {
    name: 'link_stuffing',
    points: (s) => {
      const n = s.text ? countLinks(s.text) : 0;
      return n >= 8 ? 25 : n >= 4 ? 10 : 0;
    },
  },
  {
    name: 'mention_stuffing',
    points: (s) => ((s.text ? countMentions(s.text) : 0) >= 10 ? 25 : 0),
  },
  {
    // A brand-new account behaving like a bot is more suspicious than an established one doing the same.
    name: 'new_account_with_links',
    points: (s) =>
      s.accountAgeHours < 24 && s.text && countLinks(s.text) >= 2 && s.duplicateCount >= 2 ? 20 : 0,
  },
];

export function scoreSpam(sample: BehaviorSample): SpamAssessment {
  const reasons: string[] = [];
  let score = 0;
  for (const rule of RULES) {
    const p = rule.points(sample);
    if (p > 0) {
      score += p;
      reasons.push(rule.name);
    }
  }
  score = Math.min(100, score);
  const level =
    score >= SPAM_THRESHOLDS.spam
      ? 'spam'
      : score >= SPAM_THRESHOLDS.suspicious
        ? 'suspicious'
        : 'ok';
  return { score, level, reasons };
}
