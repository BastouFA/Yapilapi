import type { Pool } from 'pg';
import type { Config } from '../config.ts';
import { enqueue } from './jobs.ts';
import type { RealtimeHub } from './realtime.ts';
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

type LiveDeps = { db: Pool; realtime: RealtimeHub; config: Pick<Config, 'LIVE_RECORDINGS_DIR' | 'LIVE_CONTROL_URL' | 'LIVE_HOOK_SECRET'> };

/**
 * A live ends: everyone watching is told, its recording and highlight clips are made (once the
 * video server has closed the last segment), and nobody is counted as watching any more. Returns
 * false when it had already ended.
 */
export async function finishLive({ db, realtime, config }: LiveDeps, id: string): Promise<boolean> {
  const r = await db.query(`UPDATE live_sessions SET status = 'ended', ended_at = now() WHERE id = $1 AND status <> 'ended' RETURNING id`, [id]);
  if (!r.rowCount) return false;
  const audience = await db.query<{ user_id: string }>(`SELECT user_id FROM live_participants WHERE session_id = $1 AND left_at IS NULL`, [id]);
  await realtime.publish(
    audience.rows.map((x) => x.user_id),
    { type: 'live.status', data: { id, status: 'ended' } },
  );
  if (config.LIVE_RECORDINGS_DIR) {
    await db.query(`UPDATE live_sessions SET recording_status = 'pending' WHERE id = $1`, [id]);
    await enqueue(db, 'live.recording', { sessionId: id }, 15);
  }
  await db.query(`UPDATE live_participants SET left_at = now() WHERE session_id = $1 AND left_at IS NULL`, [id]);
  return true;
}

/** A live that has been on this long ends by itself. */
export const LIVE_MAX_HOURS = 12;
/** A live whose host stopped sending video (and didn't press End) ends after this long without it. */
export const LIVE_QUIET_MINUTES = 10;
/** When each live was first seen without video, in this process. */
const quietSince = new Map<string, number>();

/** Whether the video server is receiving the live's stream; null when it can't be asked. */
async function isPublishing(config: LiveDeps['config'], id: string): Promise<boolean | null> {
  if (!config.LIVE_CONTROL_URL) return null;
  try {
    const auth = { authorization: `Basic ${Buffer.from(`yapilapi:${config.LIVE_HOOK_SECRET}`).toString('base64')}` };
    const res = await fetch(`${config.LIVE_CONTROL_URL}/v3/paths/get/live/${id}`, { headers: auth, signal: AbortSignal.timeout(5000) });
    if (res.status === 404) return false;
    if (!res.ok) return null;
    return ((await res.json()) as { ready?: boolean }).ready === true;
  } catch {
    return null;
  }
}

/**
 * Lives left on: ended after LIVE_MAX_HOURS, or after LIVE_QUIET_MINUTES without video when the
 * video server can be asked (a host who closed their streaming software without pressing End).
 */
export async function sweepLives(deps: LiveDeps, now = Date.now()): Promise<string[]> {
  const { rows } = await deps.db.query<{ id: string; started_at: Date | null }>(`SELECT id, started_at FROM live_sessions WHERE status = 'live'`);
  const ended: string[] = [];
  for (const l of rows) {
    const started = l.started_at?.getTime() ?? now;
    let stale = now - started > LIVE_MAX_HOURS * 3_600_000;
    if (!stale && now - started > LIVE_QUIET_MINUTES * 60_000) {
      const publishing = await isPublishing(deps.config, l.id);
      if (publishing === false) {
        const since = quietSince.get(l.id) ?? now;
        quietSince.set(l.id, since);
        stale = now - since >= LIVE_QUIET_MINUTES * 60_000;
      } else if (publishing) quietSince.delete(l.id);
    }
    if (stale) {
      quietSince.delete(l.id);
      if (await finishLive(deps, l.id)) ended.push(l.id);
    }
  }
  for (const id of quietSince.keys()) if (!rows.some((r) => r.id === id)) quietSince.delete(id);
  return ended;
}
