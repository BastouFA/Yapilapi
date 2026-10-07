import type { MessageKey, PluralKey } from './i18n-core.ts';

/**
 * The numbers under posts, reels and stories, and the milestones their authors are told about
 * (docs/product/post-stats.md). Pure parts both apps and the API share (no zod: the phone imports
 * this file directly).
 */

/** A post's views or likes passing one of these tells its author once ("Your reel passed 1,000 views"). */
export const POST_MILESTONES = [100, 1_000, 10_000, 100_000] as const;
export const MILESTONE_METRICS = ['views', 'likes'] as const;
export type MilestoneMetric = (typeof MILESTONE_METRICS)[number];

/** The highest milestone at or under `n`, or null under the first. */
export function milestoneFor(n: number): number | null {
  let hit: number | null = null;
  for (const m of POST_MILESTONES) if (n >= m) hit = m;
  return hit;
}

const SUFFIXES: [number, string][] = [
  [1e9, 'B'],
  [1e6, 'M'],
  [1e3, 'K'],
];

/**
 * A count in the reader's language, short: 1.2K in English, 3,4 k in French, 12 M. Counts under
 * 1,000 are written in full. Where the platform can't write short numbers (some phone builds), it
 * falls back to K, M and B with the language's decimal sign.
 */
export function compactCount(n: number, locale: string): string {
  const value = Math.max(0, Math.floor(n));
  if (value < 1000) return full(value, locale);
  try {
    const out = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
    // Engines without compact notation ignore it and write the whole number.
    if (out.replace(/\D/g, '').length < String(value).length) return out;
  } catch {
    // Falls through to the plain version below.
  }
  const [size, suffix] = SUFFIXES.find(([s]) => value >= s)!;
  // Rounded down, so 1,999 never reads as 2K.
  const short = Math.floor((value / size) * 10) / 10;
  let text: string;
  try {
    text = new Intl.NumberFormat(locale, { maximumFractionDigits: short >= 100 ? 0 : 1 }).format(short);
  } catch {
    text = String(short);
  }
  return `${text}${suffix}`;
}

/** A count written in full for labels and screen readers: 1,234. */
export function fullCount(n: number, locale: string): string {
  return full(Math.max(0, Math.floor(n)), locale);
}

function full(n: number, locale: string): string {
  try {
    return new Intl.NumberFormat(locale).format(n);
  } catch {
    return String(n);
  }
}

/** Plural keys for each number under a post, as "{count} views". */
export const POST_STAT_KEYS = {
  views: 'post.stats.views',
  likes: 'post.stats.likes',
  comments: 'post.stats.comments',
  reposts: 'post.stats.reposts',
  shares: 'post.stats.shares',
  replies: 'post.stats.replies',
} as const satisfies Record<string, PluralKey>;
export type PostStatKind = keyof typeof POST_STAT_KEYS;

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

/**
 * The words of a milestone notification ("Your reel passed 1,000 views"), or null when it isn't
 * one. `data` is the notification's: the metric, the milestone and whether it's a reel.
 */
export function milestoneNoticeText(n: { type: string; data: Record<string, unknown> }, t: T, locale: string): string | null {
  if (n.type !== 'post_milestone') return null;
  const metric: MilestoneMetric = n.data.metric === 'likes' ? 'likes' : 'views';
  const reel = n.data.format === 'reel';
  const count = fullCount(Number(n.data.threshold) || POST_MILESTONES[0], locale);
  const key: MessageKey = `milestone.notif.${metric}.${reel ? 'reel' : 'post'}`;
  return t(key, { count });
}
