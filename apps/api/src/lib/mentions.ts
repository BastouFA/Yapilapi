import type { Pool, PoolClient } from 'pg';
import { extractMentions } from '@yapilapi/shared';
import type { RealtimeHub } from './realtime.ts';
import { notify } from './services.ts';
import { postVisibleSql } from './visibility.ts';

type Q = Pool | PoolClient;

/**
 * Tell people they were @mentioned in a post or comment, but only people who
 * can see that post (a friends-only post doesn't reach a stranger by
 * mentioning them). Blocks, mutes and notification settings apply as usual.
 */
export async function notifyMentions(
  db: Q,
  realtime: RealtimeHub,
  m: { text: string | null | undefined; actorId: string; postId: string; commentId?: string; skip?: string[] },
): Promise<number> {
  const names = extractMentions(m.text);
  if (!names.length) return 0;
  const { rows } = await db.query(
    `SELECT pr.user_id FROM profiles pr WHERE lower(pr.username) = ANY($2::text[]) AND pr.user_id <> $3
       AND EXISTS (SELECT 1 FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
                   WHERE p.id = $1 AND p.moderation_status = 'normal' AND ${postVisibleSql('pr.user_id')})`,
    [m.postId, names, m.actorId],
  );
  let sent = 0;
  for (const r of rows) {
    if (m.skip?.includes(r.user_id)) continue;
    await notify(db, realtime, {
      userId: r.user_id,
      category: 'friends',
      type: m.commentId ? 'comment_mention' : 'post_mention',
      actorId: m.actorId,
      entityType: 'post',
      entityId: m.postId,
      data: m.commentId ? { commentId: m.commentId } : {},
    });
    sent++;
  }
  return sent;
}
