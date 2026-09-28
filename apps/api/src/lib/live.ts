import type { Pool } from 'pg';
import { roomStageRuleSql } from './rooms.ts';
import { notBlockedSql } from './visibility.ts';

/**
 * Whether `reader` sees a message `author` wrote in the chat of the live `session` (all SQL; the
 * live is aliased `l`). Live chat follows the rule for messages: between an adult and someone
 * under 18, a chat message only reaches the other when they are friends or linked through a
 * family link the teen accepted, like a direct message would. What the host, co-hosts and
 * moderators write reaches everyone watching, and they see everything, so they can moderate it.
 * Blocks apply both ways.
 */
export function liveChatVisibleSql(author: string, reader: string, session: string): string {
  const team = (x: string) =>
    `EXISTS (SELECT 1 FROM live_participants lt WHERE lt.session_id = ${session} AND lt.user_id = ${x} AND lt.role IN ('cohost', 'moderator'))`;
  return `(${author} = ${reader} OR (
    ${notBlockedSql(author, reader)} AND (
      ${author} = l.host_id OR ${reader} = l.host_id OR ${team(author)} OR ${team(reader)}
      OR ${roomStageRuleSql(author, reader)})))`;
}

/** The people watching a live now who see a chat message (or gift) from `authorId`. */
export async function liveChatAudience(db: Pick<Pool, 'query'>, sessionId: string, authorId: string): Promise<string[]> {
  const { rows } = await db.query<{ user_id: string }>(
    `SELECT p.user_id FROM live_participants p JOIN live_sessions l ON l.id = p.session_id
     WHERE p.session_id = $1 AND p.left_at IS NULL AND ${liveChatVisibleSql('$2::uuid', 'p.user_id', '$1::uuid')}`,
    [sessionId, authorId],
  );
  return rows.map((r) => r.user_id);
}
