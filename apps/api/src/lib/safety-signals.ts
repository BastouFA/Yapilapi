import type { Queryable } from '@yapilapi/database';
import {
  normalizeForDuplicate,
  scoreSpam,
  type BehaviorSample,
  type SpamAssessment,
  type SpamSurface,
} from '@yapilapi/moderation';
import type { AppContext } from './context.js';

/**
 * Behaviour signals for the anti-spam scorer (packages/moderation/src/spam.ts): collect a sample from the database and
 * raise an explainable moderation case when an account behaves like a bot. Cheap on purpose (a handful of indexed
 * counts + one bounded read) so it can sit on write paths. Errors here must never fail the caller's write; callers
 * that are not inside their own transaction should use `safeRecord`.
 */

const SURFACE_TABLE: Record<'post' | 'comment' | 'review', { table: string; col: string }> = {
  post: { table: 'posts', col: 'body' },
  comment: { table: 'comments', col: 'body' },
  review: { table: 'reviews', col: 'body' },
};

export async function collectBehavior(
  db: Queryable,
  surface: SpamSurface,
  userId: string,
  text: string | undefined,
): Promise<BehaviorSample> {
  const counts = await db.query<{
    posts: number;
    comments: number;
    messages: number;
    follows: number;
    age_hours: number;
  }>(
    `SELECT (SELECT count(*)::int FROM posts WHERE author_id = $1 AND created_at > now() - interval '1 hour') AS posts,
            (SELECT count(*)::int FROM comments WHERE author_id = $1 AND created_at > now() - interval '10 minutes') AS comments,
            (SELECT count(*)::int FROM messages WHERE sender_id = $1 AND created_at > now() - interval '10 minutes') AS messages,
            (SELECT count(*)::int FROM follows WHERE follower_id = $1 AND created_at > now() - interval '1 hour') AS follows,
            (SELECT extract(epoch FROM now() - created_at) / 3600 FROM users WHERE id = $1) AS age_hours`,
    [userId],
  );
  const c = counts.rows[0]!;
  let duplicateCount = 1;
  let duplicateTargets: number | undefined;
  if (text && text.trim()) {
    const norm = normalizeForDuplicate(text);
    if (norm.length >= 20) {
      if (surface === 'message') {
        const { rows } = await db.query<{ body: string; conversation_id: string }>(
          `SELECT body, conversation_id FROM messages WHERE sender_id = $1 AND created_at > now() - interval '24 hours' AND kind = 'text' ORDER BY created_at DESC LIMIT 60`,
          [userId],
        );
        const same = rows.filter((r) => normalizeForDuplicate(r.body) === norm);
        duplicateCount = Math.max(1, same.length);
        duplicateTargets = new Set(same.map((r) => r.conversation_id)).size;
      } else if (surface in SURFACE_TABLE) {
        const t = SURFACE_TABLE[surface as 'post' | 'comment' | 'review'];
        const { rows } = await db.query<{ body: string }>(
          // identifiers come from the constant table above, never from input
          `SELECT ${t.col} AS body FROM ${t.table} WHERE author_id = $1 AND created_at > now() - interval '24 hours' ORDER BY created_at DESC LIMIT 60`,
          [userId],
        );
        duplicateCount = Math.max(
          1,
          rows.filter((r) => normalizeForDuplicate(r.body) === norm).length,
        );
      }
    }
  }
  return {
    surface,
    postsLastHour: c.posts,
    commentsLast10Min: c.comments,
    messagesLast10Min: c.messages,
    followsLastHour: c.follows,
    duplicateCount,
    ...(duplicateTargets !== undefined ? { duplicateTargets } : {}),
    accountAgeHours: Number(c.age_hours ?? 9999),
    ...(text !== undefined ? { text } : {}),
  };
}

export async function assessBehavior(
  db: Queryable,
  surface: SpamSurface,
  userId: string,
  text?: string,
): Promise<SpamAssessment & { sample: BehaviorSample }> {
  const sample = await collectBehavior(db, surface, userId, text);
  return { ...scoreSpam(sample), sample };
}

/** True if we already raised a signal of this kind for the user recently (dedupes case creation). */
async function recentlySignalled(
  db: Queryable,
  userId: string,
  kind: string,
  hours: number,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `SELECT 1 FROM safety_signals WHERE user_id = $1 AND kind = $2 AND created_at > now() - ($3 || ' hours')::interval LIMIT 1`,
    [userId, kind, String(hours)],
  );
  return (rowCount ?? 0) > 0;
}

export interface SignalOutcome {
  level: SpamAssessment['level'];
  score: number;
  caseId: string | null;
}

/**
 * Score an account's behaviour on `surface` and, for suspicious/spam levels, open (or reuse a recent) automated review
 * case against the account. Returns what was decided; does NOT change any content (callers decide that).
 * `target` is what the case points at (defaults to the user).
 */
export async function recordBehaviorSignal(
  ctx: AppContext,
  db: Queryable,
  input: {
    surface: SpamSurface;
    userId: string;
    text?: string;
    target?: { type: string; id: string };
    assessment?: SpamAssessment;
  },
): Promise<SignalOutcome> {
  const a = input.assessment ?? (await assessBehavior(db, input.surface, input.userId, input.text));
  if (a.level === 'ok') return { level: 'ok', score: a.score, caseId: null };
  const kind = `spam_${input.surface}`;
  if (a.level === 'suspicious' && (await recentlySignalled(db, input.userId, kind, 6)))
    return { level: a.level, score: a.score, caseId: null };
  const target = input.target ?? { type: 'user', id: input.userId };
  const risk = a.level === 'spam' ? 'high' : 'medium';
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO moderation_cases (target_type, target_id, subject_user_id, source, risk_level, categories, signals, state, content_snapshot)
     VALUES ($1,$2,$3,'automated',$4,'{spam}',$5,$6,$7) RETURNING id`,
    [
      target.type,
      target.id,
      input.userId,
      risk,
      JSON.stringify({ spam: { score: a.score, reasons: a.reasons, surface: input.surface } }),
      a.level === 'spam' ? 'restricted' : 'review',
      JSON.stringify(input.text ? { text: input.text.trim().slice(0, 2000) } : {}),
    ],
  );
  await db.query(
    'INSERT INTO safety_signals (user_id, kind, score, details, case_id) VALUES ($1,$2,$3,$4,$5)',
    [input.userId, kind, a.score, JSON.stringify({ reasons: a.reasons }), rows[0]!.id],
  );
  ctx.metrics.events.inc({ name: `spam_${a.level}` });
  return { level: a.level, score: a.score, caseId: rows[0]!.id };
}

/** For write paths outside a transaction: never throws. */
export async function safeRecordBehavior(
  ctx: AppContext,
  input: Parameters<typeof recordBehaviorSignal>[2],
): Promise<void> {
  try {
    await recordBehaviorSignal(ctx, ctx.db, input);
  } catch (err) {
    ctx.log.warn({ err }, 'behaviour signal failed');
  }
}
