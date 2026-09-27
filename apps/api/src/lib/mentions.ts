import type { Pool, PoolClient } from 'pg';
import { extractMentions } from '@yapilapi/shared';
import type { RealtimeHub } from './realtime.ts';
import { minorRuleSql } from './collabs.ts';
import { mentionAllowedSql } from './interactions.ts';
import { notify } from './services.ts';
import { postVisibleSql } from './visibility.ts';

type Q = Pool | PoolClient;

/**
 * Tell people they were @mentioned in a post or comment, but only people who
 * can see that post (a friends-only post doesn't reach a stranger by
 * mentioning them), and not across the minor line between people who aren't
 * friends. Blocks, mutes and notification settings apply as usual.
 * After an edit, `previously` holds the post's earlier texts: people already
 * mentioned in one of them aren't told again.
 */
export async function notifyMentions(
  db: Q,
  realtime: RealtimeHub,
  m: { text: string | null | undefined; actorId: string; postId: string; commentId?: string; skip?: string[]; previously?: string[] },
): Promise<number> {
  const before = new Set((m.previously ?? []).flatMap((t) => extractMentions(t)));
  const names = extractMentions(m.text).filter((n) => !before.has(n));
  if (!names.length) return 0;
  const { rows } = await db.query(
    // Minor protection, as for photo tags: an adult and someone under 18 who aren't friends don't reach each other this way.
    `SELECT pr.user_id FROM profiles pr WHERE lower(pr.username) = ANY($2::text[]) AND pr.user_id <> $3 AND ${minorRuleSql('$3', 'pr.user_id')} AND ${mentionAllowedSql('$3', 'pr.user_id')}
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
