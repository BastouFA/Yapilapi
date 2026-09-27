/**
 * "Ask me": a question box on profiles. The owner turns it on with an optional prompt, chooses
 * who can ask and whether askers may hide their name from the public. Answers show on the
 * profile's Answers tab and can be shared as a post that quotes the question.
 *
 * A question asked "without your name shown" is never anonymous to YAPILAPI: the asker is stored,
 * blocks and limits apply to them and moderators see who it was. Nobody else is told, the person
 * asked included.
 *
 * No zod here: the mobile app imports this file directly. The request schemas are in schemas.ts.
 */
import type { PublicUser } from './types.ts';

/** Who can ask: everyone signed in, people the owner follows, or the owner's friends. */
export const ASK_AUDIENCES = ['everyone', 'following', 'friends'] as const;
export type AskAudience = (typeof ASK_AUDIENCES)[number];

export const ASK_PROMPT_MAX = 120;
export const ASK_QUESTION_MAX = 300;
export const ASK_ANSWER_MAX = 1000;

/** Inbox filters for the owner. */
export const ASK_FILTERS = ['new', 'answered', 'hidden'] as const;
export type AskFilter = (typeof ASK_FILTERS)[number];

/** Who can see an answer shared as a post. */
export const ASK_SHARE_VISIBILITIES = ['public', 'followers', 'friends'] as const;
export type AskShareVisibility = (typeof ASK_SHARE_VISIBILITIES)[number];

/**
 * How many questions can be asked. Per asker: in an hour across everyone, and to one person in a
 * day. Per person asked: in an hour from everyone, so a box can't be flooded.
 */
export const ASK_LIMITS = {
  perAskerPerHour: 20,
  perAskerPerRecipientPerDay: 5,
  perRecipientPerHour: 200,
} as const;

/** Why a signed-in visitor can't ask (shown in plain words by the apps). */
export const ASK_REFUSALS = ['off', 'self', 'audience', 'private', 'blocked', 'minor', 'signed_out'] as const;
export type AskRefusal = (typeof ASK_REFUSALS)[number];

/** Your own box, as Settings shows it. `hiddenNamesAvailable` is false on accounts of people under 18. */
export interface AskBoxSettings {
  enabled: boolean;
  prompt: string | null;
  audience: AskAudience;
  allowHiddenNames: boolean;
  hiddenNamesAvailable: boolean;
}

/**
 * The box on a profile, for the person looking. Null when it's off and there are no answers to
 * show. `canAsk` says whether this visitor may ask; `refusal` says why not.
 */
export interface ProfileAskBox {
  enabled: boolean;
  prompt: string | null;
  /** Whether this visitor may ask without their name shown. */
  hiddenNamesAllowed: boolean;
  canAsk: boolean;
  refusal?: AskRefusal;
  answers: number;
}

/**
 * An answered question as anyone who can see it gets it. `asker` is set only for questions asked
 * with a name, from an account this viewer can see; `askedWithoutName` marks the others.
 */
export interface AnswerCard {
  id: string;
  question: string;
  askedWithoutName: boolean;
  asker: PublicUser | null;
  answer: string;
  answeredAt: string;
  /** Whose box it is. */
  owner: PublicUser;
  /** Only for the owner: still waiting for a moderator, so only they see it. */
  held?: boolean;
}

/** A question in the owner's inbox. `asker` is null for questions asked without a name. */
export interface InboxQuestion {
  id: string;
  question: string;
  askedWithoutName: boolean;
  asker: PublicUser | null;
  state: AskFilter;
  answer: string | null;
  answeredAt: string | null;
  createdAt: string;
  /** The answer is waiting for a moderator, so only the owner sees it. */
  held: boolean;
  /** You blocked whoever asked this from asking you again. */
  askerBlocked: boolean;
}

/** A question as the post that shares its answer quotes it. The post's text is the answer. */
export interface QuotedQuestion {
  id: string;
  question: string;
  askedWithoutName: boolean;
  asker: PublicUser | null;
}

/** The label under a question: "Asked by @name", "Asked without a name", or neither when the asker isn't shown. */
export function askedByKey(q: {
  askedWithoutName: boolean;
  asker: PublicUser | null;
}): 'ask.card.askedBy' | 'ask.card.askedWithoutName' | 'ask.card.askedBySomeone' {
  if (q.askedWithoutName) return 'ask.card.askedWithoutName';
  return q.asker ? 'ask.card.askedBy' : 'ask.card.askedBySomeone';
}
