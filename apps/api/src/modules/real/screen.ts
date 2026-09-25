import type { Queryable } from '@yapilapi/database';
import { classifyText } from '@yapilapi/moderation';
import type { AppContext } from '../../lib/context.js';
import { notify } from '../../lib/notify.js';

/** Tables whose rows carry a moderation_status and may hold user text that needs screening (constants: safe to interpolate). */
const TABLES = {
  real_capture: 'real_captures',
  experience_contribution: 'shared_experience_contributions',
} as const;
export type ScreenTarget = keyof typeof TABLES;

/**
 * Screen freshly created text with the same classifier and case pipeline as posts (lib/moderation-hook.ts handles fixed target types; Real and
 * Together content is screened here, opening the same `moderation_cases` rows). Risky content is held (not visible to anyone but its author)
 * and queued for human review. Returns the resulting moderation status.
 */
export async function screenOwnText(
  ctx: AppContext,
  db: Queryable,
  target: { type: ScreenTarget; id: string; authorId: string; text: string },
): Promise<string> {
  const text = target.text.trim();
  if (!text) return 'approved';
  const result = classifyText(text);
  if (result.status === 'approved') return 'approved';
  await db.query(`UPDATE ${TABLES[target.type]} SET moderation_status = $2 WHERE id = $1`, [
    target.id,
    result.status,
  ]);
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
      JSON.stringify({ text: text.slice(0, 2000) }),
    ],
  );
  ctx.metrics.events.inc({ name: `moderation_${result.action}` });
  if (result.categories.includes('self_harm'))
    await notify(
      ctx,
      {
        userId: target.authorId,
        kind: 'safety_support',
        data: { resources: '/v1/safety/resources' },
      },
      db,
    );
  return result.status;
}
