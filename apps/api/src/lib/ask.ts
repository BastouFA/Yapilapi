import type { Pool, PoolClient } from 'pg';
import type { AnswerCard, AskAudience, AskBoxSettings, AskRefusal, InboxQuestion, ProfileAskBox, QuotedQuestion } from '@yapilapi/shared';
import { notBlockedSql } from './visibility.ts';
import { plusCol, publicUserFrom } from './users.ts';

type Q = Pool | PoolClient;

/**
 * "Ask me": question boxes on profiles (modules/ask.ts has the routes).
 *
 * A question asked without a name is never anonymous to YAPILAPI: `asker_id` is always stored and
 * every rule applies to it. Nothing here gives it to anyone but the asker's own account and
 * moderators: the person asked, visitors and the post that shares an answer all get `asker: null`.
 * Keep it that way in anything that reads ask_questions.
 */

/** The asker's public columns (prefixed k_), or NULLs when the question hid their name. Needs `q` and a join `kp`/`ku` on the asker. */
const ASKER_COLS = (v: string) => `
  CASE WHEN NOT q.hide_name AND ku.status = 'active' AND ${notBlockedSql('q.asker_id', v)} THEN kp.user_id END AS k_id,
  CASE WHEN NOT q.hide_name THEN kp.username END AS k_username, CASE WHEN NOT q.hide_name THEN kp.display_name END AS k_display_name,
  CASE WHEN NOT q.hide_name THEN kp.avatar_url END AS k_avatar_url, CASE WHEN NOT q.hide_name THEN kp.mode END AS k_mode,
  CASE WHEN NOT q.hide_name THEN kp.plus_until > now() END AS k_plus`;

const ASKER_JOIN = `JOIN profiles kp ON kp.user_id = q.asker_id JOIN users ku ON ku.id = q.asker_id`;

/** The asker for a card: set only for a question asked with a name, from an account this viewer can see. */
function askerOf(r: Record<string, unknown>) {
  return r.k_id ? publicUserFrom(r, 'k_') : null;
}

/**
 * Answers aliased `q` (owner's profile `op`, owner's user row `ou`) that viewer `v` may see on the
 * owner's Answers tab: answered, not hidden or deleted, cleared by moderation (the owner also sees
 * their own held ones), from an active account that neither blocked the other, not from a box that
 * blocked the viewer from asking, and like posts on a private account: followers only. People
 * without an account never see answers from accounts of people under 18.
 */
export function answerVisibleSql(v: string): string {
  return `(
    q.deleted_at IS NULL AND q.answered_at IS NOT NULL AND q.hidden_at IS NULL
    AND (q.moderation_status = 'normal' OR (q.recipient_id = ${v} AND q.moderation_status IN ('review', 'restricted')))
    AND ou.status = 'active'
    AND ${notBlockedSql('q.recipient_id', v)}
    AND NOT EXISTS (SELECT 1 FROM ask_blocks ab WHERE ab.recipient_id = q.recipient_id AND ab.asker_id = ${v})
    AND (q.recipient_id = ${v} OR NOT op.is_private OR EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = ${v} AND f.followee_id = q.recipient_id))
    AND (${v}::uuid IS NOT NULL OR NOT coalesce(ou.birth_date > current_date - interval '18 years', false))
  )`;
}

export const ANSWER_FROM = `FROM ask_questions q JOIN profiles op ON op.user_id = q.recipient_id JOIN users ou ON ou.id = q.recipient_id ${ASKER_JOIN}`;

/** Answer cards by id, in the order given, for viewer $1 (only those they may see). */
export async function answerCards(db: Q, ids: string[], viewer: string | null): Promise<AnswerCard[]> {
  if (!ids.length) return [];
  const { rows } = await db.query(
    `SELECT q.id, q.body, q.hide_name, q.answer, q.answered_at, q.moderation_status,
            op.user_id AS o_id, op.username AS o_username, op.display_name AS o_display_name, op.avatar_url AS o_avatar_url, op.mode AS o_mode, ${plusCol('o_', 'op')},
            ${ASKER_COLS('$1')}
     ${ANSWER_FROM} WHERE q.id = ANY($2::uuid[]) AND ${answerVisibleSql('$1')}`,
    [viewer, ids],
  );
  const byId = new Map<string, AnswerCard>(
    rows.map((r) => [
      r.id as string,
      {
        id: r.id,
        question: r.body,
        askedWithoutName: r.hide_name,
        asker: askerOf(r),
        answer: r.answer,
        answeredAt: new Date(r.answered_at).toISOString(),
        owner: publicUserFrom(r, 'o_'),
        ...(r.moderation_status !== 'normal' ? { held: true } : {}),
      } satisfies AnswerCard,
    ]),
  );
  return ids.map((id) => byId.get(id)).filter((c): c is AnswerCard => !!c);
}

/** Questions in the owner's inbox, by id and in the order given. Never says who asked a question asked without a name. */
export async function inboxQuestions(db: Q, ids: string[], owner: string): Promise<InboxQuestion[]> {
  if (!ids.length) return [];
  const { rows } = await db.query(
    `SELECT q.id, q.body, q.hide_name, q.answer, q.answered_at, q.hidden_at, q.created_at, q.moderation_status,
            ${ASKER_COLS('$1')},
            EXISTS (SELECT 1 FROM ask_blocks ab WHERE ab.question_id = q.id AND ab.recipient_id = $1) AS asker_blocked
     FROM ask_questions q ${ASKER_JOIN}
     WHERE q.id = ANY($2::uuid[]) AND q.recipient_id = $1 AND q.deleted_at IS NULL`,
    [owner, ids],
  );
  const byId = new Map<string, InboxQuestion>(
    rows.map((r) => [
      r.id as string,
      {
        id: r.id,
        question: r.body,
        askedWithoutName: r.hide_name,
        asker: askerOf(r),
        state: r.hidden_at ? 'hidden' : r.answered_at ? 'answered' : 'new',
        answer: r.answer ?? null,
        answeredAt: r.answered_at ? new Date(r.answered_at).toISOString() : null,
        createdAt: new Date(r.created_at).toISOString(),
        held: !!r.answered_at && r.moderation_status !== 'normal',
        askerBlocked: r.asker_blocked,
      } satisfies InboxQuestion,
    ]),
  );
  return ids.map((id) => byId.get(id)).filter((c): c is InboxQuestion => !!c);
}

/** The questions posts quote, for viewer $1: only answered, visible ones; the asker as on an answer card. */
export async function quotedQuestions(db: Q, ids: string[], viewer: string | null): Promise<Map<string, QuotedQuestion>> {
  const cards = await answerCards(db, [...new Set(ids)], viewer);
  return new Map(cards.filter((c) => !c.held).map((c) => [c.id, { id: c.id, question: c.question, askedWithoutName: c.askedWithoutName, asker: c.asker }]));
}

interface BoxRow {
  enabled: boolean;
  prompt: string | null;
  audience: AskAudience;
  allow_hidden_names: boolean;
}

/** Your box as Settings shows it (defaults when you never set one up). */
export async function ownBox(db: Q, userId: string): Promise<AskBoxSettings> {
  const { rows } = await db.query<BoxRow & { minor: boolean }>(
    `SELECT b.enabled, b.prompt, b.audience, b.allow_hidden_names, coalesce(u.birth_date > current_date - interval '18 years', false) AS minor
     FROM users u LEFT JOIN ask_boxes b ON b.user_id = u.id WHERE u.id = $1`,
    [userId],
  );
  const r = rows[0];
  return {
    enabled: !!r?.enabled,
    prompt: r?.prompt ?? null,
    audience: r?.audience ?? 'everyone',
    // People under 18 never get questions without a name, whatever was saved.
    allowHiddenNames: !!r?.allow_hidden_names && !r?.minor,
    hiddenNamesAvailable: !r?.minor,
  };
}

/** What the rules say about one person asking another, from a single query. */
export interface AskCheck {
  box: (BoxRow & { hiddenNamesAllowed: boolean }) | null;
  ownerActive: boolean;
  refusal: AskRefusal | null;
}

/**
 * Whether `asker` may ask `owner`, and if not, why: the box is off, it's yourself, either blocked
 * the other (or the owner blocked this person from asking), an adult asking someone under 18 they
 * aren't friends with, the box's audience (people the owner follows, or friends), or a private
 * account's box for someone who doesn't follow it. Unknown ages count as adult, as for messages.
 */
export async function checkAsk(db: Q, asker: string | null, owner: string): Promise<AskCheck> {
  const { rows } = await db.query(
    `SELECT b.enabled, b.prompt, b.audience, b.allow_hidden_names, op.is_private, ou.status,
            coalesce(ou.birth_date > current_date - interval '18 years', false) AS owner_minor,
            coalesce((SELECT au.birth_date > current_date - interval '18 years' FROM users au WHERE au.id = $1), false) AS asker_minor,
            (NOT ${notBlockedSql('ou.id', '$1')}
              OR EXISTS (SELECT 1 FROM ask_blocks ab WHERE ab.recipient_id = ou.id AND ab.asker_id = $1)) AS blocked,
            EXISTS (SELECT 1 FROM friendships fr WHERE (fr.user_a = $1 AND fr.user_b = ou.id) OR (fr.user_b = $1 AND fr.user_a = ou.id)) AS friends,
            EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = ou.id AND f.followee_id = $1) AS owner_follows,
            EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followee_id = ou.id) AS follows_owner
     FROM users ou JOIN profiles op ON op.user_id = ou.id LEFT JOIN ask_boxes b ON b.user_id = ou.id WHERE ou.id = $2`,
    [asker, owner],
  );
  const r = rows[0];
  if (!r) return { box: null, ownerActive: false, refusal: 'off' };
  const box = r.enabled === null ? null : { ...(r as BoxRow), hiddenNamesAllowed: !!r.allow_hidden_names && !r.owner_minor };
  const refusal: AskRefusal | null = !box?.enabled
    ? 'off'
    : !asker
      ? 'signed_out'
      : asker === owner
        ? 'self'
        : r.blocked
          ? 'blocked'
          : r.owner_minor && !r.asker_minor && !r.friends
            ? 'minor'
            : (box.audience === 'friends' && !r.friends) || (box.audience === 'following' && !r.owner_follows)
              ? 'audience'
              : r.is_private && !r.follows_owner && !r.friends
                ? 'private'
                : null;
  return { box, ownerActive: r.status === 'active', refusal };
}

/** The box on a profile for this viewer, or null when it's off and there's nothing to show. */
export async function profileAskBox(db: Q, owner: string, viewer: string | null): Promise<ProfileAskBox | null> {
  const check = await checkAsk(db, viewer, owner);
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ask_questions q JOIN profiles op ON op.user_id = q.recipient_id JOIN users ou ON ou.id = q.recipient_id
     WHERE q.recipient_id = $2 AND ${answerVisibleSql('$1')}`,
    [viewer, owner],
  );
  const answers = rows[0]?.n ?? 0;
  const enabled = !!check.box?.enabled;
  // Someone the owner blocked from asking doesn't see the box at all.
  if (check.refusal === 'blocked') return answers ? { enabled: false, prompt: null, hiddenNamesAllowed: false, canAsk: false, answers } : null;
  if (!enabled && !answers) return null;
  return {
    enabled,
    prompt: enabled ? (check.box?.prompt ?? null) : null,
    hiddenNamesAllowed: enabled && !!check.box?.hiddenNamesAllowed,
    canAsk: enabled && !check.refusal,
    ...(check.refusal && enabled ? { refusal: check.refusal } : {}),
    answers,
  };
}

/** Whether the owner's Answers tab has anything to show (to decide if the tab is listed). */
export async function hasAnswersTab(db: Q, owner: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT coalesce((SELECT enabled FROM ask_boxes WHERE user_id = $1), false)
            OR EXISTS (SELECT 1 FROM ask_questions WHERE recipient_id = $1 AND answered_at IS NOT NULL AND hidden_at IS NULL AND deleted_at IS NULL) AS shown`,
    [owner],
  );
  return !!rows[0]?.shown;
}
