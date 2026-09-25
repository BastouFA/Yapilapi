/**
 * Pure LIVE rules: lifecycle, role permissions, slow mode, chat filters, polls, clips. No I/O, so every branch is unit-tested
 * (rules.unit.test.ts). Visibility of a session (who may SEE it) is SQL in access.ts; this file decides what a viewer who can see it may DO.
 */
export type LiveStatus = 'scheduled' | 'live' | 'ended' | 'cancelled';
export type LiveRole = 'host' | 'cohost' | 'moderator' | 'audience';
export type LiveAction =
  | 'start'
  | 'cancel'
  | 'edit'
  | 'manage_team'
  | 'end'
  | 'settings'
  | 'moderate'
  | 'hide_message'
  | 'poll'
  | 'answer'
  | 'products'
  | 'marker'
  | 'clip'
  | 'recording'
  | 'chat'
  | 'react'
  | 'ask'
  | 'vote';

const TRANSITIONS: Record<LiveStatus, readonly LiveStatus[]> = {
  scheduled: ['live', 'cancelled'],
  live: ['ended'],
  ended: [],
  cancelled: [],
};
export const canTransition = (from: LiveStatus, to: LiveStatus): boolean =>
  TRANSITIONS[from].includes(to);

const ALL_TEAM: readonly LiveAction[] = [
  'end',
  'settings',
  'moderate',
  'hide_message',
  'poll',
  'answer',
  'products',
  'marker',
  'clip',
  'chat',
  'react',
  'ask',
  'vote',
];
const MATRIX: Record<LiveRole, ReadonlySet<LiveAction>> = {
  host: new Set<LiveAction>(['start', 'cancel', 'edit', 'manage_team', 'recording', ...ALL_TEAM]),
  // Co-hosts run the room (and may end it) but cannot start/cancel/edit the session, change the team or attach recordings.
  cohost: new Set<LiveAction>(ALL_TEAM),
  // Moderators keep the room civil and nothing else: no ending, no commerce, no polls.
  moderator: new Set<LiveAction>([
    'moderate',
    'hide_message',
    'answer',
    'chat',
    'react',
    'ask',
    'vote',
  ]),
  audience: new Set<LiveAction>(['chat', 'react', 'ask', 'vote']),
};
export const can = (role: LiveRole, action: LiveAction): boolean => MATRIX[role].has(action);

const RANK: Record<LiveRole, number> = { host: 3, cohost: 2, moderator: 1, audience: 0 };
/** Moderation always goes down the ladder: nobody can mute/ban/hide someone of equal or higher rank (and never the host). */
export const outranks = (actor: LiveRole, target: LiveRole): boolean => RANK[actor] > RANK[target];

// ------------------------------------------------------------------ chat
export const MAX_MESSAGE = 500;
export const MAX_BLOCKED_TERMS = 50;

/** Case, accent and simple leetspeak folding so "B4dword" cannot dodge a filter on "badword". */
export function foldText(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[@]/g, 'a')
    .replace(/[0]/g, 'o')
    .replace(/[1]/g, 'i')
    .replace(/[3]/g, 'e')
    .replace(/[4]/g, 'a')
    .replace(/[5$]/g, 's')
    .replace(/[7]/g, 't')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Hosts' blocked terms: 2-40 chars, folded, unique, at most MAX_BLOCKED_TERMS. Returns null when the list is invalid. */
export function cleanTerms(terms: readonly string[]): string[] | null {
  const out = new Set<string>();
  for (const t of terms) {
    const f = foldText(t);
    if (f.length < 2 || f.length > 40) return null;
    out.add(f);
  }
  return out.size <= MAX_BLOCKED_TERMS ? [...out] : null;
}

/** Does the message contain one of the (already folded) terms? Whole-word for single words, substring for phrases. */
export function matchesBlockedTerm(text: string, terms: readonly string[]): boolean {
  if (!terms.length) return false;
  const folded = foldText(text);
  const words = new Set(folded.split(' '));
  const squashed = folded.replace(/\s+/g, '');
  for (const t of terms) {
    if (
      t.includes(' ') ? folded.includes(t) : words.has(t) || (t.length >= 5 && squashed.includes(t))
    )
      return true;
  }
  return false;
}

/** Milliseconds a participant must still wait under slow mode (0 = may post). The team is exempt. */
export function slowModeWaitMs(
  lastPostAt: Date | null,
  now: Date,
  slowSec: number,
  role: LiveRole,
): number {
  if (!slowSec || role !== 'audience' || !lastPostAt) return 0;
  return Math.max(0, lastPostAt.getTime() + slowSec * 1000 - now.getTime());
}

export const isMuted = (mutedUntil: Date | null, now: Date): boolean =>
  Boolean(mutedUntil && mutedUntil.getTime() > now.getTime());

// ------------------------------------------------------------------ reactions, polls, clips
export const REACTIONS = ['like', 'love', 'laugh', 'wow', 'clap', 'fire'] as const;
export const clampReactionCount = (n: number): number =>
  Math.max(1, Math.min(10, Math.floor(Number.isFinite(n) ? n : 1)));

export interface PollInput {
  question: string;
  options: readonly string[];
  multiple?: boolean;
}
/** 2-6 distinct (case-insensitive) non-empty options. Returns the trimmed options or an error message. */
export function validatePoll(
  p: PollInput,
): { ok: true; options: string[] } | { ok: false; error: string } {
  const opts = p.options.map((o) => o.trim());
  if (!p.question.trim()) return { ok: false, error: 'A poll needs a question' };
  if (opts.length < 2 || opts.length > 6) return { ok: false, error: 'A poll has 2 to 6 options' };
  if (opts.some((o) => !o || o.length > 100))
    return { ok: false, error: 'Each option is 1 to 100 characters' };
  if (new Set(opts.map((o) => o.toLowerCase())).size !== opts.length)
    return { ok: false, error: 'Options must be different' };
  return { ok: true, options: opts };
}

/** A vote must pick exactly one option in single-choice polls, 1..n distinct options in multiple-choice polls. */
export function validateVote(
  optionIds: readonly string[],
  valid: ReadonlySet<string>,
  multiple: boolean,
): string | null {
  if (!optionIds.length) return 'Choose an option';
  if (new Set(optionIds).size !== optionIds.length) return 'Choose each option once';
  if (!multiple && optionIds.length !== 1) return 'This poll takes one answer';
  if (optionIds.some((o) => !valid.has(o))) return 'Unknown option';
  return null;
}

export const MAX_CLIP_MS = 600_000;
export const MIN_CLIP_MS = 1_000;
export function validateClipRange(
  startMs: number,
  endMs: number,
  sessionMs: number | null,
): string | null {
  if (endMs - startMs < MIN_CLIP_MS) return 'A clip is at least 1 second';
  if (endMs - startMs > MAX_CLIP_MS) return 'A clip is at most 10 minutes';
  if (sessionMs !== null && endMs > sessionMs + 1000)
    return 'The clip goes past the end of the session';
  return null;
}

/** Elapsed session time in ms (0 before the start; capped at the end for ended sessions). */
export function sessionOffsetMs(startedAt: Date | null, endedAt: Date | null, now: Date): number {
  if (!startedAt) return 0;
  return Math.max(0, (endedAt ?? now).getTime() - startedAt.getTime());
}

// ------------------------------------------------------------------ hosting limits
export interface HostFacts {
  ageBand: 'teen' | 'adult';
  visibility: string;
  ticketed: boolean;
}
/** Who may host what. Teens: never public, never subscriber-only, never ticketed (stricter defaults). */
export function hostingRefusal(f: HostFacts): string | null {
  if (f.ageBand === 'teen') {
    if (f.visibility === 'public' || f.visibility === 'subscribers')
      return 'Accounts under 18 can host live sessions for followers or privately only';
    if (f.ticketed) return 'Accounts under 18 cannot sell tickets';
  }
  return null;
}

export const MAX_SCHEDULE_DAYS = 90;
export const MIN_SCHEDULE_LEAD_MS = 60_000;
export function scheduleRefusal(at: Date, now: Date): string | null {
  if (at.getTime() < now.getTime() + MIN_SCHEDULE_LEAD_MS)
    return 'Schedule at least a minute ahead';
  if (at.getTime() > now.getTime() + MAX_SCHEDULE_DAYS * 86_400_000)
    return `You can schedule at most ${MAX_SCHEDULE_DAYS} days ahead`;
  return null;
}
