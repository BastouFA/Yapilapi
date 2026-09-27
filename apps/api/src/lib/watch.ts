import type { Pool, PoolClient } from 'pg';
import {
  WATCH_PRESENCE_SECONDS,
  WATCH_QUEUE_MAX,
  type PublicUser,
  type WatchPlayback,
  type WatchQueueItem,
  type WatchSession,
  type WatchSkipReason,
  type WatchSummary,
} from '@yapilapi/shared';
import { hydratePosts } from './posts.ts';
import type { RealtimeHub } from './realtime.ts';
import { seesSensitiveSql } from './interactions.ts';
import { PUBLIC_USER_COLS, toPublicUser, type PublicUserRow } from './users.ts';
import { postUnlockedSql, postVisibleSql } from './visibility.ts';

type Q = Pool | PoolClient;

export interface WatchDeps {
  db: Q;
  realtime: RealtimeHub;
}

/**
 * Posts aliased `p` (author profile `ap`, author user `au`) that everyone in `members` (a
 * uuid[] placeholder) can see and open: the usual visibility rules for each of them, and
 * media the automated check marked sensitive only when every one of them sees such media.
 */
export function visibleToAllSql(members: string): string {
  return `(
    NOT EXISTS (SELECT 1 FROM unnest(${members}) AS mv(id)
                WHERE NOT (${postVisibleSql('mv.id')} AND ${postUnlockedSql('mv.id')}))
    AND (NOT EXISTS (SELECT 1 FROM post_media spm JOIN media sm ON sm.id = spm.media_id WHERE spm.post_id = p.id AND sm.moderation = 'sensitive')
         OR NOT EXISTS (SELECT 1 FROM unnest(${members}) AS ms(id) WHERE NOT ${seesSensitiveSql('ms.id')}))
  )`;
}

/** Posts aliased `p` that can be watched: a reel or a post with a finished video that wasn't blocked. */
export const WATCHABLE_SQL = `EXISTS (
  SELECT 1 FROM post_media wpm JOIN media wm ON wm.id = wpm.media_id
  WHERE wpm.post_id = p.id AND wm.kind = 'video' AND wm.status = 'ready' AND wm.deleted_at IS NULL AND wm.moderation <> 'blocked')`;

/** People in a chat now (active accounts that haven't left it). */
export async function chatMembers(db: Q, conversationId: string): Promise<string[]> {
  const { rows } = await db.query<{ user_id: string }>(
    `SELECT cm.user_id FROM conversation_members cm JOIN users u ON u.id = cm.user_id
     WHERE cm.conversation_id = $1 AND cm.left_at IS NULL AND u.status = 'active'`,
    [conversationId],
  );
  return rows.map((r) => r.user_id);
}

/** People watching a session now. */
export async function watchingIds(db: Q, sessionId: string): Promise<string[]> {
  const { rows } = await db.query<{ user_id: string }>(`SELECT user_id FROM watch_participants WHERE session_id = $1 AND left_at IS NULL ORDER BY joined_at`, [
    sessionId,
  ]);
  return rows.map((r) => r.user_id);
}

/**
 * Of these posts, which everyone in the chat can watch. Returns why each other one can't:
 * gone or not a video ('unavailable' / 'not_video'), or someone in the chat can't see it
 * ('not_visible'). The reason never says who.
 */
export async function checkWatchable(db: Q, postIds: string[], members: string[]): Promise<Map<string, 'ok' | WatchSkipReason>> {
  const out = new Map<string, 'ok' | WatchSkipReason>(postIds.map((id) => [id, 'unavailable']));
  if (!postIds.length) return out;
  const { rows } = await db.query<{ id: string; video: boolean; everyone: boolean }>(
    `SELECT p.id, ${WATCHABLE_SQL} AS video, ${visibleToAllSql('$2::uuid[]')} AS everyone
     FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
     WHERE p.id = ANY($1::uuid[]) AND p.deleted_at IS NULL AND p.status = 'published'`,
    [postIds, members],
  );
  for (const r of rows) out.set(r.id, !r.video ? 'not_video' : r.everyone ? 'ok' : 'not_visible');
  return out;
}

export function playbackOf(r: Record<string, any>): WatchPlayback {
  return {
    itemId: r.current_item_id ?? null,
    playing: !!r.playing,
    positionMs: Number(r.position_ms ?? 0),
    at: (r.state_at as Date).getTime(),
    seq: Number(r.state_seq ?? 0),
    by: r.state_by ?? null,
  };
}

async function people(db: Q, ids: string[]): Promise<Map<string, PublicUser>> {
  if (!ids.length) return new Map();
  const { rows } = await db.query<PublicUserRow>(`SELECT ${PUBLIC_USER_COLS} FROM profiles pr WHERE pr.user_id = ANY($1::uuid[])`, [ids]);
  return new Map(rows.map((r) => [r.id, toPublicUser(r)]));
}

/** The active session in a chat, as a short summary for the chat screen. */
export async function activeSummary(db: Q, conversationId: string, viewer: string): Promise<WatchSummary | null> {
  const { rows } = await db.query(
    `SELECT id, conversation_id, host_id, started_by, created_at FROM watch_sessions WHERE conversation_id = $1 AND status = 'active'`,
    [conversationId],
  );
  const s = rows[0];
  if (!s) return null;
  const watching = await watchingIds(db, s.id);
  const users = await people(db, [...watching, s.started_by]);
  return {
    id: s.id,
    conversationId: s.conversation_id,
    hostId: s.host_id,
    startedBy: users.get(s.started_by)!,
    watching: orderHostFirst(watching, s.host_id)
      .map((id) => users.get(id))
      .filter((u): u is PublicUser => !!u),
    joined: watching.includes(viewer),
    createdAt: s.created_at.toISOString(),
  };
}

const orderHostFirst = (ids: string[], host: string | null) => (host && ids.includes(host) ? [host, ...ids.filter((i) => i !== host)] : ids);

/** A session as `viewer` (someone in its chat) sees it: the queue hydrated for them. */
export async function sessionFor(db: Q, sessionId: string, viewer: string): Promise<WatchSession | null> {
  const { rows } = await db.query(
    `SELECT s.*, c.title AS conversation_title, c.kind AS conversation_kind FROM watch_sessions s JOIN conversations c ON c.id = s.conversation_id WHERE s.id = $1`,
    [sessionId],
  );
  const s = rows[0];
  if (!s) return null;
  const members = await chatMembers(db, s.conversation_id);
  const watching = await watchingIds(db, s.id);
  const items = (
    await db.query<{ id: string; post_id: string; added_by: string | null; status: 'queued' | 'playing' }>(
      `SELECT id, post_id, added_by, status FROM watch_queue_items WHERE session_id = $1 AND status IN ('queued', 'playing') ORDER BY (status = 'playing') DESC, position`,
      [s.id],
    )
  ).rows;
  const users = await people(db, [...new Set([...members, ...watching, s.started_by, ...items.map((i) => i.added_by).filter((x): x is string => !!x)])]);
  const posts = new Map((await hydratePosts(db, [...new Set(items.map((i) => i.post_id))], viewer)).map((p) => [p.id, p]));
  const queue: WatchQueueItem[] = [];
  for (const i of items) {
    const post = posts.get(i.post_id);
    if (post) queue.push({ id: i.id, post, addedBy: (i.added_by && users.get(i.added_by)) || null, status: i.status });
  }
  return {
    id: s.id,
    conversationId: s.conversation_id,
    conversationTitle: s.conversation_kind === 'group' ? (s.conversation_title ?? null) : null,
    status: s.status,
    hostId: s.host_id,
    startedBy: users.get(s.started_by)!,
    watching: orderHostFirst(watching, s.host_id)
      .map((id) => users.get(id))
      .filter((u): u is PublicUser => !!u),
    members: members.map((id) => users.get(id)).filter((u): u is PublicUser => !!u),
    joined: watching.includes(viewer),
    queue,
    playback: playbackOf(s),
    serverTime: Date.now(),
    createdAt: s.created_at.toISOString(),
  };
}

/**
 * Put posts at the end of a session's queue. Each goes in only when everyone in the chat can
 * watch it; the others come back with the reason. With nothing on screen, the first one added
 * goes on screen (paused unless `play`).
 */
export async function addToQueue(
  c: PoolClient,
  sessionId: string,
  conversationId: string,
  userId: string,
  postIds: string[],
  play = false,
): Promise<{ added: string[]; skipped: { postId: string; reason: WatchSkipReason }[]; changedPlayback: boolean }> {
  const members = await chatMembers(c, conversationId);
  const unique = [...new Set(postIds)];
  const verdicts = await checkWatchable(c, unique, members);
  const waiting = new Set(
    (
      await c.query<{ post_id: string }>(`SELECT post_id FROM watch_queue_items WHERE session_id = $1 AND status IN ('queued', 'playing')`, [sessionId])
    ).rows.map((r) => r.post_id),
  );
  let room = WATCH_QUEUE_MAX - waiting.size;
  const added: string[] = [];
  const skipped: { postId: string; reason: WatchSkipReason }[] = [];
  let next = Number((await c.query(`SELECT coalesce(max(position), 0) + 1 AS n FROM watch_queue_items WHERE session_id = $1`, [sessionId])).rows[0].n);
  for (const postId of unique) {
    const v = verdicts.get(postId)!;
    if (v !== 'ok') skipped.push({ postId, reason: v });
    else if (waiting.has(postId)) skipped.push({ postId, reason: 'already_queued' });
    else if (room <= 0) skipped.push({ postId, reason: 'queue_full' });
    else {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO watch_queue_items (session_id, post_id, added_by, position) VALUES ($1,$2,$3,$4) RETURNING id`,
        [sessionId, postId, userId, next++],
      );
      added.push(rows[0]!.id);
      waiting.add(postId);
      room--;
    }
  }
  let changedPlayback = false;
  if (added.length) {
    const cur = (await c.query(`SELECT current_item_id FROM watch_sessions WHERE id = $1 FOR UPDATE`, [sessionId])).rows[0];
    if (!cur.current_item_id) {
      await c.query(`UPDATE watch_queue_items SET status = 'playing' WHERE id = $1`, [added[0]]);
      await c.query(
        `UPDATE watch_sessions SET current_item_id = $2, playing = $3, position_ms = 0, state_at = now(), state_seq = state_seq + 1, state_by = $4 WHERE id = $1`,
        [sessionId, added[0], play, userId],
      );
      changedPlayback = true;
    }
  }
  return { added, skipped, changedPlayback };
}

/**
 * Move on from the item on screen: it's done, and the next queued item everyone in the chat can
 * still see goes on screen and plays. Items that stopped being visible to someone are skipped
 * (their reason is returned; the post isn't). With nothing left, the screen empties and pauses.
 */
export async function advance(
  c: PoolClient,
  session: { id: string; conversation_id: string; current_item_id: string | null },
  userId: string | null,
  target?: string,
): Promise<{ skipped: WatchSkipReason[]; itemId: string | null; moved: boolean }> {
  const members = await chatMembers(c, session.conversation_id);
  const queued = (
    await c.query<{ id: string; post_id: string }>(
      `SELECT id, post_id FROM watch_queue_items WHERE session_id = $1 AND status = 'queued' ${target ? 'AND id = $2' : ''} ORDER BY position`,
      target ? [session.id, target] : [session.id],
    )
  ).rows;
  const verdicts = await checkWatchable(
    c,
    queued.map((q) => q.post_id),
    members,
  );
  const skipped: WatchSkipReason[] = [];
  let chosen: string | null = null;
  for (const q of queued) {
    const v = verdicts.get(q.post_id)!;
    if (v === 'ok') {
      chosen = q.id;
      break;
    }
    const reason: 'not_visible' | 'unavailable' = v === 'not_visible' ? 'not_visible' : 'unavailable';
    await c.query(`UPDATE watch_queue_items SET status = 'skipped', skip_reason = $2 WHERE id = $1`, [q.id, reason]);
    skipped.push(reason);
  }
  // Jumping to an item that can't be shown leaves the screen as it is.
  if (target && !chosen) return { skipped, itemId: session.current_item_id, moved: false };
  if (session.current_item_id) await c.query(`UPDATE watch_queue_items SET status = 'played' WHERE id = $1 AND status = 'playing'`, [session.current_item_id]);
  if (chosen) await c.query(`UPDATE watch_queue_items SET status = 'playing' WHERE id = $1`, [chosen]);
  await c.query(
    `UPDATE watch_sessions SET current_item_id = $2, playing = $3, position_ms = 0, state_at = now(), state_seq = state_seq + 1, state_by = $4 WHERE id = $1`,
    [session.id, chosen, !!chosen, userId],
  );
  return { skipped, itemId: chosen, moved: true };
}

/** Send the shared playback to everyone watching. */
export async function publishPlayback(deps: WatchDeps, sessionId: string, extra: { skipped?: WatchSkipReason[] } = {}): Promise<WatchPlayback | null> {
  const { rows } = await deps.db.query(`SELECT current_item_id, playing, position_ms, state_at, state_seq, state_by FROM watch_sessions WHERE id = $1`, [
    sessionId,
  ]);
  if (!rows[0]) return null;
  const playback = playbackOf(rows[0]);
  await deps.realtime.publish(await watchingIds(deps.db, sessionId), {
    type: 'watch.playback',
    data: { sessionId, playback, serverTime: Date.now(), ...(extra.skipped?.length ? { skipped: extra.skipped } : {}) },
  });
  return playback;
}

/** Tell everyone watching (plus `also`) to read the session again: the queue, the people or the host changed. */
export async function publishUpdated(deps: WatchDeps, sessionId: string, reason: 'queue' | 'people' | 'host', also: string[] = []): Promise<void> {
  const ids = await watchingIds(deps.db, sessionId);
  await deps.realtime.publish([...new Set([...ids, ...also])], { type: 'watch.updated', data: { sessionId, reason } });
}

/** End a session: everyone leaves, and everyone in the chat hears it ended. */
export async function endSession(deps: WatchDeps, sessionId: string): Promise<boolean> {
  const { rows } = await deps.db.query<{ conversation_id: string }>(
    `UPDATE watch_sessions SET status = 'ended', ended_at = now(), playing = false WHERE id = $1 AND status = 'active' RETURNING conversation_id`,
    [sessionId],
  );
  if (!rows[0]) return false;
  const left = await deps.db.query<{ user_id: string }>(
    `UPDATE watch_participants SET left_at = now() WHERE session_id = $1 AND left_at IS NULL RETURNING user_id`,
    [sessionId],
  );
  const members = await chatMembers(deps.db, rows[0].conversation_id);
  await deps.realtime.publish([...new Set([...members, ...left.rows.map((r) => r.user_id)])], {
    type: 'watch.ended',
    data: { sessionId, conversationId: rows[0].conversation_id },
  });
  return true;
}

/**
 * After someone left: when the host is gone, the person watching longest becomes host; with
 * nobody watching, the session ends. Returns what happened.
 */
export async function settleHost(deps: WatchDeps, sessionId: string, gone: string[] = []): Promise<'ended' | 'host' | 'same'> {
  const s = (await deps.db.query(`SELECT host_id, status FROM watch_sessions WHERE id = $1`, [sessionId])).rows[0];
  if (!s || s.status !== 'active') return 'same';
  const watching = await watchingIds(deps.db, sessionId);
  if (!watching.length) {
    await endSession(deps, sessionId);
    return 'ended';
  }
  if (s.host_id && watching.includes(s.host_id)) {
    await publishUpdated(deps, sessionId, 'people', gone);
    return 'same';
  }
  await deps.db.query(`UPDATE watch_sessions SET host_id = $2 WHERE id = $1`, [sessionId, watching[0]]);
  await publishUpdated(deps, sessionId, 'host', gone);
  return 'host';
}

/** Leave a session (a no-op when not watching). */
export async function leaveSession(deps: WatchDeps, sessionId: string, userId: string): Promise<boolean> {
  const r = await deps.db.query(`UPDATE watch_participants SET left_at = now() WHERE session_id = $1 AND user_id = $2 AND left_at IS NULL`, [
    sessionId,
    userId,
  ]);
  if (!r.rowCount) return false;
  await settleHost(deps, sessionId, [userId]);
  return true;
}

/**
 * Housekeeping, run by the job worker every few seconds: people whose player went quiet, who
 * left the chat or whose account is no longer active stop watching; the host passes on; sessions
 * nobody watches end. Returns how many sessions changed.
 */
export async function sweepWatch(deps: WatchDeps): Promise<number> {
  const gone = await deps.db.query<{ session_id: string; user_id: string }>(
    `UPDATE watch_participants wp SET left_at = now()
     FROM watch_sessions s
     WHERE s.id = wp.session_id AND s.status = 'active' AND wp.left_at IS NULL AND (
       wp.last_seen_at < now() - make_interval(secs => $1)
       OR NOT EXISTS (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id = s.conversation_id AND cm.user_id = wp.user_id AND cm.left_at IS NULL)
       OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = wp.user_id AND u.status = 'active'))
     RETURNING wp.session_id, wp.user_id`,
    [WATCH_PRESENCE_SECONDS],
  );
  const changed = new Set(gone.rows.map((r) => r.session_id));
  // Sessions nobody is watching (everyone left without saying so) end too.
  const empty = await deps.db.query<{ id: string }>(
    `SELECT s.id FROM watch_sessions s WHERE s.status = 'active' AND s.created_at < now() - make_interval(secs => $1)
       AND NOT EXISTS (SELECT 1 FROM watch_participants wp WHERE wp.session_id = s.id AND wp.left_at IS NULL)`,
    [WATCH_PRESENCE_SECONDS],
  );
  for (const e of empty.rows) changed.add(e.id);
  for (const id of changed)
    await settleHost(
      deps,
      id,
      gone.rows.filter((g) => g.session_id === id).map((g) => g.user_id),
    );
  return changed.size;
}
