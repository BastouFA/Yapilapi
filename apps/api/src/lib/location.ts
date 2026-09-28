import type { Pool, PoolClient } from 'pg';
import type { LocationShare, LocationStopReason, PublicUser } from '@yapilapi/shared';
import type { RealtimeHub } from './realtime.ts';
import { usersByIds } from './users.ts';

type Q = Pool | PoolClient;

/**
 * Sharing where you are with a chat (see migration 0057): what each member sees, the live
 * updates, and ending shares (at their time, on Stop, a block, leaving or someone joining).
 * Ending a share deletes its point; only the fact that it happened stays. Used by
 * modules/location.ts, the messaging module and the job worker.
 *
 * Nothing here logs, tracks or exports a place: coordinates only ever go to the members of the
 * chat, in the share's card and its `location.updated` events.
 */
export interface LocationDeps {
  db: Pool;
  realtime: RealtimeHub;
}

/** Queued for each live share at its end; stops it if it's still running. */
export const LOCATION_EXPIRE_JOB = 'location.expire';

export interface ShareRow {
  id: string;
  message_id: string;
  conversation_id: string;
  user_id: string;
  mode: 'live' | 'once';
  precision: LocationShare['precision'];
  lat: number | null;
  lng: number | null;
  accuracy_m: number | null;
  point_at: Date | null;
  started_at: Date;
  ends_at: Date | null;
  stopped_at: Date | null;
  stop_reason: LocationStopReason | null;
  /** Whether it's running by the database's clock. */
  running: boolean;
}

export const SHARE_COLS = `s.id, s.message_id, s.conversation_id, s.user_id, s.mode, s.precision, s.lat, s.lng, s.accuracy_m, s.point_at, s.started_at,
  s.ends_at, s.stopped_at, s.stop_reason, (s.mode = 'live' AND s.stopped_at IS NULL AND s.ends_at > now()) AS running`;

/** What ending a share does to its row: the point goes, the fact that it happened stays. `$n` holds the reason. */
const stopSet = (n: number) => `lat = NULL, lng = NULL, accuracy_m = NULL, point_at = NULL, stopped_at = now(), stop_reason = $${n}`;

/**
 * Shares as `reader` sees them. A live share past its time shows as stopped even before the job
 * clears it, and nobody sees the place of someone they blocked or who blocked them.
 */
export async function presentShares(db: Q, rows: ShareRow[], reader: string): Promise<LocationShare[]> {
  if (!rows.length) return [];
  const users = await usersByIds(db, [...new Set(rows.map((r) => r.user_id))]);
  const { rows: blocked } = await db.query<{ id: string }>(
    `SELECT CASE WHEN blocker_id = $1 THEN blocked_id ELSE blocker_id END AS id FROM blocks
     WHERE (blocker_id = $1 AND blocked_id = ANY($2::uuid[])) OR (blocked_id = $1 AND blocker_id = ANY($2::uuid[]))`,
    [reader, [...new Set(rows.map((r) => r.user_id))]],
  );
  const hidden = new Set(blocked.map((b) => b.id));
  const gone = (id: string): PublicUser => ({ id, username: '', displayName: '', avatarUrl: null, mode: 'personal' });
  return rows.map((r) => {
    const ended = r.mode === 'live' && !r.running;
    const canSee = r.user_id === reader || !hidden.has(r.user_id);
    const point =
      !ended && canSee && r.lat !== null && r.lng !== null && r.point_at
        ? { lat: r.lat, lng: r.lng, accuracyM: r.accuracy_m, at: r.point_at.toISOString() }
        : null;
    return {
      id: r.id,
      messageId: r.message_id,
      conversationId: r.conversation_id,
      sharer: users.get(r.user_id) ?? gone(r.user_id),
      mode: r.mode,
      precision: r.precision,
      point,
      startedAt: r.started_at.toISOString(),
      endsAt: r.ends_at ? r.ends_at.toISOString() : null,
      live: r.running,
      // Past its time but not yet cleared: it has stopped, at its end.
      stoppedAt: r.stopped_at ? r.stopped_at.toISOString() : ended && r.ends_at ? r.ends_at.toISOString() : null,
      stopReason: r.stop_reason ?? (ended ? 'expired' : null),
    };
  });
}

/** The shares on these messages (by message id), as `reader` sees them. */
export async function sharesFor(db: Q, messageIds: string[], reader: string): Promise<Map<string, LocationShare>> {
  const ids = [...new Set(messageIds)];
  if (!ids.length) return new Map();
  const { rows } = await db.query<ShareRow>(`SELECT ${SHARE_COLS} FROM location_shares s WHERE s.message_id = ANY($1::uuid[])`, [ids]);
  return new Map((await presentShares(db, rows, reader)).map((s) => [s.messageId, s]));
}

export async function shareById(db: Q, id: string, reader: string): Promise<LocationShare | null> {
  const { rows } = await db.query<ShareRow>(`SELECT ${SHARE_COLS} FROM location_shares s WHERE s.id = $1`, [id]);
  return (await presentShares(db, rows, reader))[0] ?? null;
}

/** Who in the chat gets a share's updates: members now, except anyone blocked by or blocking the sharer. */
export async function locationReaders(db: Q, conversationId: string, sharerId: string): Promise<string[]> {
  const { rows } = await db.query<{ user_id: string }>(
    `SELECT cm.user_id FROM conversation_members cm
     WHERE cm.conversation_id = $1 AND cm.left_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = cm.user_id AND b.blocked_id = $2) OR (b.blocker_id = $2 AND b.blocked_id = cm.user_id))`,
    [conversationId, sharerId],
  );
  return rows.map((r) => r.user_id);
}

/**
 * `location.updated` to the members who see the share (see locationReaders), with the card as it
 * is now. Nothing is pushed to phones for an update.
 */
export async function publishShare(deps: LocationDeps, shareId: string): Promise<LocationShare | null> {
  const row = (await deps.db.query<ShareRow>(`SELECT ${SHARE_COLS} FROM location_shares s WHERE s.id = $1`, [shareId])).rows[0];
  if (!row) return null;
  const [share] = await presentShares(deps.db, [row], row.user_id);
  const live = await deps.db.query(`SELECT 1 FROM messages WHERE id = $1 AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > now())`, [
    row.message_id,
  ]);
  if (!live.rowCount || !share) return share ?? null;
  await deps.realtime.publish(await locationReaders(deps.db, row.conversation_id, row.user_id), {
    type: 'location.updated',
    data: { id: row.message_id, conversationId: row.conversation_id, location: share },
  });
  return share;
}

/** Stop one live share (if it's still running), deleting its point. Returns whether it stopped now. */
export async function stopShare(db: Q, shareId: string, reason: LocationStopReason): Promise<boolean> {
  const r = await db.query(`UPDATE location_shares SET ${stopSet(2)} WHERE id = $1 AND mode = 'live' AND stopped_at IS NULL`, [shareId, reason]);
  return !!r.rowCount;
}

/** Stop and announce every live share matched by `where` (a condition on location_shares s, with `params` from $2). */
async function stopWhere(deps: LocationDeps, where: string, params: unknown[], reason: LocationStopReason): Promise<string[]> {
  const { rows } = await deps.db.query<{ id: string }>(
    `UPDATE location_shares s SET ${stopSet(1)} WHERE s.mode = 'live' AND s.stopped_at IS NULL AND ${where} RETURNING s.id`,
    [reason, ...params],
  );
  for (const r of rows) await publishShare(deps, r.id);
  return rows.map((r) => r.id);
}

/** Someone left a chat: their live shares there stop. */
export function stopSharesOnLeave(deps: LocationDeps, conversationId: string, userId: string): Promise<string[]> {
  return stopWhere(deps, `s.conversation_id = $2 AND s.user_id = $3`, [conversationId, userId], 'left');
}

/** Someone new joined a group: live shares there stop (the people sharing chose who saw them; they can start again). */
export function stopSharesOnJoin(deps: LocationDeps, conversationId: string): Promise<string[]> {
  return stopWhere(deps, `s.conversation_id = $2`, [conversationId], 'joined');
}

/**
 * Stop live shares between two people after a block (called inside the block's transaction; see
 * blockUser): each one's shares in any chat the other is in. Returns the shares to announce.
 */
export async function stopSharesOnBlock(c: Q, a: string, b: string): Promise<string[]> {
  const { rows } = await c.query<{ id: string }>(
    `UPDATE location_shares s SET ${stopSet(2)}
     WHERE s.mode = 'live' AND s.stopped_at IS NULL AND s.user_id = ANY($1::uuid[])
       AND EXISTS (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id = s.conversation_id AND cm.left_at IS NULL
                   AND cm.user_id = ANY($1::uuid[]) AND cm.user_id <> s.user_id)
     RETURNING s.id`,
    [[a, b], 'blocked'],
  );
  return rows.map((r) => r.id);
}

/** Announce shares a block stopped, once its transaction is done. */
export async function publishShares(deps: LocationDeps, ids: string[]): Promise<void> {
  for (const id of ids) await publishShare(deps, id);
}

/** Stop live shares past their time (each has its own job; this catches any that were missed). Returns how many. */
export async function expireShares(deps: LocationDeps): Promise<number> {
  return (await stopWhere(deps, `s.ends_at <= now()`, [], 'expired')).length;
}

export function locationJobHandlers(deps: LocationDeps) {
  return {
    [LOCATION_EXPIRE_JOB]: async (payload: { shareId: string }) => {
      const due = await deps.db.query(`SELECT 1 FROM location_shares WHERE id = $1 AND mode = 'live' AND stopped_at IS NULL AND ends_at <= now()`, [
        payload.shareId,
      ]);
      if (due.rowCount && (await stopShare(deps.db, payload.shareId, 'expired'))) await publishShare(deps, payload.shareId);
    },
  };
}
