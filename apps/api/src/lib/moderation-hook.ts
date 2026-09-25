import type { Queryable } from '@yapilapi/database';
import { classifyText, type Classification } from '@yapilapi/moderation';
import type { AppContext } from './context.js';
import { assessBehavior, recordBehaviorSignal } from './safety-signals.js';
import { notify } from './notify.js';
import { enqueuePostCreated } from '../modules/developer/webhooks.js';
import { trackPostCreated } from '../modules/analytics/track.js';

export type ModTargetType = 'post' | 'comment' | 'moment' | 'message' | 'review';
const TABLE: Record<ModTargetType, string> = {
  post: 'posts',
  comment: 'comments',
  moment: 'moments',
  message: 'messages',
  review: 'reviews',
};

/**
 * Screen freshly created text content. Content that the classifier considers risky is restricted or queued for
 * human review and a moderation case is opened, so nothing risky silently goes live. Runs inside the caller's
 * transaction when `db` is a transaction client.
 */
export async function screenText(
  ctx: AppContext,
  db: Queryable,
  target: { type: ModTargetType; id: string; authorId: string; text: string },
): Promise<Classification> {
  const result = classifyText(target.text);
  if (result.status === 'approved') {
    // Content looks fine on its own: check HOW the account behaves (velocity, duplicates, link stuffing).
    if (target.type === 'post' || target.type === 'comment' || target.type === 'review') {
      const spam = await assessBehavior(db, target.type, target.authorId, target.text);
      if (spam.level !== 'ok') {
        const out = await recordBehaviorSignal(ctx, db, {
          surface: target.type,
          userId: target.authorId,
          text: target.text,
          target: { type: target.type, id: target.id },
          assessment: spam,
        });
        if (out.level === 'spam') {
          await db.query(
            `UPDATE ${TABLE[target.type]} SET moderation_status = 'restricted' WHERE id = $1`,
            [target.id],
          );
          return {
            ...result,
            action: 'restrict',
            risk: 'high',
            categories: ['spam'],
            status: 'restricted',
          };
        }
      }
    }
    // Developer webhooks (post.created): only for public, approved posts of users who authorised an app; same transaction.
    if (target.type === 'post') {
      await enqueuePostCreated(db, target.id);
      await trackPostCreated(ctx, db, { id: target.id, authorId: target.authorId });
    }
    return result;
  }
  await db.query(`UPDATE ${TABLE[target.type]} SET moderation_status = $2 WHERE id = $1`, [
    target.id,
    result.status,
  ]);
  if (target.type === 'post')
    await db.query('UPDATE posts SET risk_level = $2 WHERE id = $1', [target.id, result.risk]);
  await db.query(
    `INSERT INTO moderation_cases (target_type, target_id, subject_user_id, source, risk_level, categories, signals, state, content_snapshot)
     VALUES ($1,$2,$3,'automated',$4,$5,$6,$7,$8)`,
    [
      target.type,
      target.id,
      target.authorId,
      result.risk,
      result.categories,
      JSON.stringify({ signals: result.signals }),
      result.action === 'escalate'
        ? 'escalated'
        : result.action === 'restrict'
          ? 'restricted'
          : 'review',
      JSON.stringify({ text: target.text.trim().slice(0, 2000) }),
    ],
  );
  ctx.metrics.events.inc({ name: `moderation_${result.action}` });
  // Self-harm signals: the author (never the content's audience) gets a caring notice pointing to support resources.
  if (result.categories.includes('self_harm')) {
    await notify(
      ctx,
      {
        userId: target.authorId,
        kind: 'safety_support',
        data: { resources: '/v1/safety/resources' },
      },
      db,
    );
  }
  return result;
}
