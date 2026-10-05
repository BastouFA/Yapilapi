import type { MessageKey } from './i18n-core.ts';

/**
 * Telling people what happened to something they reported.
 *
 * When a moderator decides a case, everyone whose report on it was open hears back in plain
 * words: the thing was removed, we took action, or it didn't break the rules. It never says how
 * the other person was penalised (a suspension, a limit on their account): only what the reporter
 * could see for themselves. The API, the web app and the phone share this (no zod: the phone
 * imports this file directly).
 */

export type ReportOutcome = 'removed' | 'actioned' | 'no_violation';

/** The plain outcome of a moderator's decision, as the reporter hears it. */
export function reportOutcome(targetType: string, decision: string): ReportOutcome {
  if (decision === 'no_action') return 'no_violation';
  // Removing or restricting a thing takes it out of the reporter's sight; an account is never "removed".
  if ((decision === 'remove' || decision === 'restrict') && targetType !== 'user') return 'removed';
  return 'actioned';
}

type Tr = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** What the notification says, as a whole sentence in the reader's language, or null for other kinds. */
export function reportOutcomeText(n: { type: string; data: Record<string, unknown> }, t: Tr): string | null {
  if (n.type !== 'report_outcome') return null;
  const target = String(n.data.targetType ?? '');
  const outcome = n.data.outcome === 'removed' || n.data.outcome === 'actioned' ? n.data.outcome : 'none';
  const thing = target === 'post' || target === 'comment' || target === 'message' ? target : target === 'user' && outcome !== 'removed' ? 'account' : 'other';
  return t(`report.outcome.${outcome}.${thing}` as MessageKey);
}

/** "Your appeal was reviewed and the decision was reversed": the notification after an appeal is decided, or null for other kinds. */
export function appealDecidedText(n: { type: string; data: Record<string, unknown> }, t: Tr): string | null {
  if (n.type !== 'appeal_decided') return null;
  return t(n.data.outcome === 'overturned' ? 'moderation.appeal.overturned' : 'moderation.appeal.upheld');
}

/** The decisions a moderator makes about something reported (ad reviews are separate: approve or reject). */
export const MODERATION_DECISIONS = ['no_action', 'warn', 'restrict', 'remove', 'suspend_user'] as const;
export type ModerationDecisionCode = (typeof MODERATION_DECISIONS)[number];

/** Things that have a limited state, seen only by their author (a photo or video is covered instead). */
const RESTRICTABLE = new Set(['post', 'comment', 'question', 'answer', 'mix', 'listing', 'market_rating', 'story', 'media']);

/**
 * What a moderator can decide about this kind of thing. An account is warned or suspended, never
 * "removed"; only things with a limited state can be limited. Suspending is for admins (the API checks).
 */
export function decisionsFor(targetType: string): ModerationDecisionCode[] {
  if (targetType === 'user') return ['no_action', 'warn', 'suspend_user'];
  return MODERATION_DECISIONS.filter((d) => d !== 'restrict' || RESTRICTABLE.has(targetType));
}
