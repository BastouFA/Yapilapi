import type { Pool, PoolClient } from 'pg';
import { COMMENT_EDIT_MINUTES, type Comment, type CommentPolicy } from '@yapilapi/shared';
import type { Config } from '../config.ts';
import { AppError } from './errors.ts';
import { analyzeText, statusForRisk, type Risk } from './moderation.ts';
import { assessComment, type Assessment } from './spam.ts';
import { langOf } from './translation.ts';
import { plusCol, publicUserFrom } from './users.ts';
import { notBlockedSql } from './visibility.ts';
import { accountCommentsAllowedSql } from './interactions.ts';
import { voiceClipSql } from './voice.ts';

type Q = Pool | PoolClient;

/**
 * Comments on posts: who may comment (the author's comment controls), which
 * comments a viewer sees, hidden words, and the counts shown on posts.
 * Posts are aliased `p` and comments `cm` in the SQL helpers.
 */

/** A comment counts (on the post and its thread) when it's up for everyone: not removed, held from everyone, or hidden. */
const COUNTED = (c: string) => `(${c}.deleted_at IS NULL AND ${c}.hidden_at IS NULL AND ${c}.moderation_status IN ('normal', 'review'))`;

/**
 * Whether viewer `v` may comment on post `p` under its comment controls:
 * everyone who can see it, people the author follows, the author's followers,
 * or no one. The author can comment unless comments are off. Visibility of the
 * post itself (and blocks with its author) is checked separately.
 */
export function commentAllowedSql(v: string): string {
  return `(${v}::uuid IS NOT NULL AND (
    p.comment_policy = 'everyone'
    OR (p.comment_policy <> 'off' AND p.author_id = ${v})
    OR (p.comment_policy = 'following' AND EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = p.author_id AND f.followee_id = ${v}))
    OR (p.comment_policy = 'followers' AND EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = ${v} AND f.followee_id = p.author_id))
  ) AND ${accountCommentsAllowedSql(v)})`;
}

/**
 * Comments aliased `cm` on post `p` that viewer `v` sees: not deleted; held or
 * restricted ones only for their writer; hidden ones (hidden words) only for
 * their writer; nothing from someone the viewer blocked or who blocked them;
 * and comments from people the post's author restricted only for the writer and the author.
 */
export function commentVisibleSql(v: string): string {
  return `(cm.deleted_at IS NULL
    AND (cm.moderation_status IN ('normal', 'review') OR cm.author_id = ${v})
    AND (cm.hidden_at IS NULL OR cm.author_id = ${v})
    AND ${notBlockedSql('cm.author_id', v)}
    AND NOT EXISTS (SELECT 1 FROM restrictions r WHERE r.restrictor_id = p.author_id AND r.restricted_id = cm.author_id
                    AND cm.author_id IS DISTINCT FROM ${v} AND p.author_id IS DISTINCT FROM ${v}))`;
}

/** Columns for toComment(): comment `cm`, its writer's profile `pr`, the post `p`, viewer `v`. */
export function commentCols(v: string): string {
  return `cm.id, cm.post_id, cm.parent_id, cm.reply_to_id, cm.body, cm.lang, cm.at_ms, cm.created_at, cm.edited_at, cm.like_count, cm.reply_count, cm.hidden_at,
          CASE WHEN cm.voice_media_id IS NOT NULL THEN ${voiceClipSql('cm.voice_media_id')} END AS voice,
          pr.user_id AS a_id, pr.username AS a_username, pr.display_name AS a_display_name, pr.avatar_url AS a_avatar_url, pr.mode AS a_mode, ${plusCol('a_')},
          coalesce(p.pinned_comment_id = cm.id, false) AS pinned,
          EXISTS (SELECT 1 FROM ask_city_helpful ah WHERE ah.comment_id = cm.id) AS helpful,
          (cm.author_id <> p.author_id AND EXISTS (SELECT 1 FROM comment_likes cl WHERE cl.comment_id = cm.id AND cl.user_id = p.author_id)) AS author_liked,
          coalesce(EXISTS (SELECT 1 FROM comment_likes cl WHERE cl.comment_id = cm.id AND cl.user_id = ${v}), false) AS liked,
          coalesce(cm.author_id = ${v} AND cm.created_at > now() - make_interval(mins => ${COMMENT_EDIT_MINUTES}), false) AS can_edit,
          coalesce(cm.author_id = ${v} OR p.author_id = ${v}, false) AS can_delete`;
}

export const COMMENT_FROM = `FROM comments cm JOIN posts p ON p.id = cm.post_id JOIN profiles pr ON pr.user_id = cm.author_id`;

/**
 * Top: likes, a like from the post's author, replies, and freshness (a new
 * comment gets a boost that halves in about eight hours), scored as of `asOf`
 * so paging stays stable.
 */
export function topScoreSql(asOf: string): string {
  return `(ln(1 + cm.like_count) * 2.0
    + CASE WHEN cm.author_id <> p.author_id AND EXISTS (SELECT 1 FROM comment_likes cl WHERE cl.comment_id = cm.id AND cl.user_id = p.author_id) THEN 1.5 ELSE 0 END
    + ln(1 + cm.reply_count) * 1.5
    + 2.0 * exp(-greatest(extract(epoch FROM (${asOf}::timestamptz - cm.created_at)), 0) / 43200.0))`;
}

export function toComment(r: Record<string, any>, opts: { hidden?: boolean } = {}): Comment {
  return {
    id: r.id,
    postId: r.post_id,
    parentId: r.parent_id,
    replyToId: r.reply_to_id ?? null,
    body: r.body,
    // Comments written before language detection get it now.
    lang: r.lang ?? langOf(r.body),
    author: publicUserFrom(r, 'a_'),
    createdAt: r.created_at.toISOString(),
    editedAt: r.edited_at?.toISOString() ?? null,
    likes: r.like_count,
    replies: r.parent_id ? 0 : r.reply_count,
    pinned: !!r.pinned,
    likedByAuthor: !!r.author_liked,
    ...(opts.hidden ? { hidden: true } : {}),
    ...(r.at_ms === null || r.at_ms === undefined ? {} : { atMs: r.at_ms }),
    ...(r.voice ? { voice: r.voice } : {}),
    ...(r.helpful ? { helpful: true } : {}),
    viewer: { liked: !!r.liked, canEdit: !!r.can_edit, canDelete: !!r.can_delete },
  };
}

/** Load comments by id with everything toComment() needs (already authorized by the caller), keeping the order. */
export async function loadComments(db: Q, ids: string[], viewer: string | null, opts: { hidden?: boolean } = {}): Promise<Comment[]> {
  if (!ids.length) return [];
  const { rows } = await db.query(`SELECT ${commentCols('$2')} ${COMMENT_FROM} WHERE cm.id = ANY($1)`, [ids, viewer]);
  const byId = new Map(rows.map((r) => [r.id as string, toComment(r, opts)]));
  return ids.map((id) => byId.get(id)).filter((c): c is Comment => !!c);
}

/**
 * Recount a post's comments and its threads' replies: removed, held and
 * hidden comments don't count, and neither do replies in a thread whose
 * top-level comment doesn't.
 */
export async function syncCommentCounts(db: Q, postId: string): Promise<void> {
  await db.query(
    `UPDATE comments t SET reply_count = n.n
     FROM (SELECT tl.id, (SELECT count(*)::int FROM comments r WHERE r.parent_id = tl.id AND ${COUNTED('r')}) AS n
           FROM comments tl WHERE tl.post_id = $1 AND tl.parent_id IS NULL) n
     WHERE t.id = n.id AND t.reply_count <> n.n`,
    [postId],
  );
  await db.query(
    `UPDATE posts SET comment_count = (
       SELECT count(*)::int FROM comments cm
       WHERE cm.post_id = $1 AND ${COUNTED('cm')}
         AND (cm.parent_id IS NULL OR EXISTS (SELECT 1 FROM comments pc WHERE pc.id = cm.parent_id AND ${COUNTED('pc')})))
     WHERE id = $1`,
    [postId],
  );
}

// ── Hidden words ─────────────────────────────────────────────────────────

/** How hidden words and comment text are compared: Unicode-normalized, lower case, single spaces. */
export function normalizeWords(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether `text` contains one of `words` as a whole word or phrase ("ass" hides
 * "ass" and "#ass", not "class"). Case and accents as typed; spacing doesn't matter.
 */
export function hasHiddenWord(text: string, words: string[]): boolean {
  if (!words.length) return false;
  const hay = normalizeWords(text);
  return words.some((w) => {
    const word = normalizeWords(w);
    if (!word) return false;
    const start = WORD_CHAR.test(word[0]!) ? '(?<![\\p{L}\\p{N}_])' : '';
    const end = WORD_CHAR.test(word.at(-1)!) ? '(?![\\p{L}\\p{N}_])' : '';
    return new RegExp(`${start}${escapeRegex(word)}${end}`, 'u').test(hay);
  });
}

export async function hiddenWordsOf(db: Q, userId: string): Promise<string[]> {
  const { rows } = await db.query<{ word: string }>(`SELECT word FROM hidden_words WHERE user_id = $1 ORDER BY created_at, word`, [userId]);
  return rows.map((r) => r.word);
}

/** How many recent comments on someone's posts are checked again when they change their hidden words. */
const RESCAN_LIMIT = 5000;

/**
 * Apply someone's hidden words to the comments already on their posts (the
 * most recent ones): newly matching comments are hidden, and comments that no
 * longer match come back. Comments they let through stay visible, and their
 * own comments are never hidden.
 */
export async function applyHiddenWords(db: Q, userId: string): Promise<void> {
  const words = await hiddenWordsOf(db, userId);
  const { rows } = await db.query<{ id: string; body: string; hidden: boolean; post_id: string }>(
    `SELECT cm.id, cm.body, cm.hidden_at IS NOT NULL AS hidden, cm.post_id FROM comments cm JOIN posts p ON p.id = cm.post_id
     WHERE p.author_id = $1 AND cm.author_id <> $1 AND cm.deleted_at IS NULL AND cm.unhidden_at IS NULL
     ORDER BY cm.created_at DESC LIMIT ${RESCAN_LIMIT}`,
    [userId],
  );
  const hide: string[] = [];
  const show: string[] = [];
  const posts = new Set<string>();
  for (const r of rows) {
    const match = hasHiddenWord(r.body, words);
    if (match === r.hidden) continue;
    (match ? hide : show).push(r.id);
    posts.add(r.post_id);
  }
  if (hide.length) await db.query(`UPDATE comments SET hidden_at = now() WHERE id = ANY($1::uuid[])`, [hide]);
  if (show.length) await db.query(`UPDATE comments SET hidden_at = NULL WHERE id = ANY($1::uuid[])`, [show]);
  if (hide.length) await db.query(`UPDATE posts SET pinned_comment_id = NULL WHERE pinned_comment_id = ANY($1::uuid[])`, [hide]);
  for (const postId of posts) await syncCommentCounts(db, postId);
}

// ── Checks before a comment is saved ────────────────────────────────────

export interface CommentScreening {
  risk: Risk;
  signals: string[];
  spam: Assessment;
  /** normal: out for everyone; review: out, and a moderator looks; restricted: only its writer sees it. */
  status: 'normal' | 'review' | 'restricted';
  /** Contains one of the post author's hidden words. */
  hidden: boolean;
}

/** The checks every new or edited comment goes through: safety, spam, a limited account, and the post author's hidden words. */
export async function screenComment(
  db: Q,
  config: Config,
  c: { userId: string; postId: string; postAuthorId: string; body: string },
): Promise<CommentScreening> {
  const analysis = analyzeText(c.body);
  if (analysis.risk === 'escalate') throw new AppError(422, 'content_blocked', "This comment can't be posted because it may put someone at risk.");
  const spam = await assessComment(db, config, c.userId, c.postId, c.body);
  const status = spam.restricted ? 'restricted' : analysis.risk !== 'normal' ? statusForRisk(analysis.risk) : spam.flags.length ? 'review' : 'normal';
  const hidden = c.userId !== c.postAuthorId && hasHiddenWord(c.body, await hiddenWordsOf(db, c.postAuthorId));
  return { risk: analysis.risk, signals: analysis.signals, spam, status, hidden };
}

/** Whether a comment with this screening reaches other people (and so notifies them). */
export const reachesOthers = (s: CommentScreening) => !s.hidden && (s.status === 'normal' || s.status === 'review');

/** Plain reasons for a closed comment box, by the post's comment controls. */
export function closedMessage(policy: CommentPolicy): string {
  return policy === 'off'
    ? 'Comments are turned off for this post.'
    : policy === 'everyone'
      ? 'The author limits who can comment on their posts.'
      : policy === 'following'
        ? 'Only people the author follows can comment on this post.'
        : 'Only people who follow the author can comment on this post.';
}
