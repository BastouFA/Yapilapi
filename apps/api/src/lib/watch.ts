import type { Pool, PoolClient } from 'pg';
import {
  WATCH_PRESENCE_SECONDS,
  WATCH_QUEUE_MAX,
  WATCH_REOPEN_MINUTES,
  type MediaItem,
  type MessageSystemInfo,
  type Post,
  type PublicUser,
  type WatchPlayback,
  type WatchQueueItem,
  type WatchSession,
  type WatchSkipReason,
  type WatchSummary,
} from '@yapilapi/shared';
import { mediaSizesSql } from './data-saver.ts';
import { enqueue } from './jobs.ts';
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

/** Media aliased `m` that is still there to show: not deleted, not blocked, processing didn't fail. */
const UPLOAD_SHOWABLE_SQL = `(m.deleted_at IS NULL AND m.moderation <> 'blocked' AND m.status <> 'failed' AND m.kind IN ('image', 'video'))`;

/**
 * Of these uploads (photos and videos added from a device), which can go on screen for everyone
 * in the chat. `owner`, when given, must have uploaded them for watch together ('invalid'
 * otherwise). Gone or blocked: 'unavailable'; marked sensitive while someone in the chat doesn't
 * see sensitive media: 'not_visible'.
 */
export async function checkUploads(
  db: Q,
  mediaIds: string[],
  members: string[],
  owner?: string,
): Promise<Map<string, 'ok' | 'invalid' | 'unavailable' | 'not_visible'>> {
  const out = new Map<string, 'ok' | 'invalid' | 'unavailable' | 'not_visible'>(mediaIds.map((id) => [id, owner ? 'invalid' : 'unavailable']));
  if (!mediaIds.length) return out;
  const { rows } = await db.query<{ id: string; mine: boolean; showable: boolean; everyone: boolean }>(
    `SELECT m.id, (m.for_watch AND NOT m.private AND m.owner_id = $3::uuid AND m.kind IN ('image', 'video')) AS mine, ${UPLOAD_SHOWABLE_SQL} AS showable,
            (m.moderation <> 'sensitive' OR NOT EXISTS (SELECT 1 FROM unnest($2::uuid[]) AS ms(id) WHERE NOT ${seesSensitiveSql('ms.id')})) AS everyone
     FROM media m WHERE m.id = ANY($1::uuid[]) AND m.for_watch`,
    [mediaIds, members, owner ?? null],
  );
  for (const r of rows) {
    if (owner && !r.mine) continue;
    out.set(r.id, !r.showable ? 'unavailable' : r.everyone ? 'ok' : 'not_visible');
  }
  return out;
}

/** A YouTube video to add: its id, with what YouTube said about it (when it could be asked). */
export interface YouTubeToAdd {
  videoId: string;
  title: string | null;
  thumbnailUrl: string | null;
}

/** What goes in a queue at once: posts, uploads and YouTube videos. */
export interface QueueInput {
  postIds?: string[];
  mediaIds?: string[];
  youtube?: YouTubeToAdd[];
}

export type QueueSkip = { postId?: string; mediaId?: string; videoId?: string; reason: WatchSkipReason };

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
    await db.query<{
      id: string;
      kind: 'post' | 'upload' | 'youtube';
      post_id: string | null;
      added_by: string | null;
      status: 'queued' | 'playing';
      youtube_id: string | null;
      title: string | null;
      thumbnail_url: string | null;
      media: (MediaItem & { ready: boolean }) | null;
    }>(
      // Uploads: shown while they're still there and not blocked, and to people who see sensitive
      // media when it was marked so. Ready once processed (a photo's sizes, a video's poster).
      `SELECT q.id, q.kind, q.post_id, q.added_by, q.status, q.youtube_id, q.title, q.thumbnail_url,
              (SELECT json_build_object('id', m.id, 'kind', m.kind, 'url', m.url, 'altText', m.alt_text, 'width', m.width, 'height', m.height,
                        'variants', m.variants, 'sizes', ${mediaSizesSql()}, 'posterUrl', m.poster_url, 'hlsUrl', m.hls_url, 'placeholder', m.blurhash,
                        'sensitive', m.moderation = 'sensitive',
                        'ready', m.status = 'ready' AND (CASE WHEN m.kind = 'video' THEN m.poster_url IS NOT NULL ELSE m.variants <> '{}'::jsonb END))
                 FROM media m WHERE m.id = q.media_id AND ${UPLOAD_SHOWABLE_SQL} AND (m.moderation <> 'sensitive' OR ${seesSensitiveSql('$2::uuid')})) AS media
       FROM watch_queue_items q WHERE q.session_id = $1 AND q.status IN ('queued', 'playing') ORDER BY (q.status = 'playing') DESC, q.position`,
      [s.id, viewer],
    )
  ).rows;
  const users = await people(db, [...new Set([...members, ...watching, s.started_by, ...items.map((i) => i.added_by).filter((x): x is string => !!x)])]);
  const postIds = [...new Set(items.map((i) => i.post_id).filter((x): x is string => !!x))];
  const posts = new Map((await hydratePosts(db, postIds, viewer)).map((p) => [p.id, p]));
  const queue: WatchQueueItem[] = [];
  for (const i of items) {
    const base = { id: i.id, addedBy: (i.added_by && users.get(i.added_by)) || null, status: i.status };
    if (i.kind === 'youtube' && i.youtube_id)
      queue.push({ ...base, kind: 'youtube', youtube: { videoId: i.youtube_id, title: i.title, thumbnailUrl: i.thumbnail_url } });
    else if (i.kind === 'upload' && i.media) {
      const { ready, ...media } = i.media;
      queue.push({ ...base, kind: 'upload', media: { ...media, variants: media.variants ?? {} }, ready });
    } else if (i.kind === 'post' && i.post_id) {
      const post = posts.get(i.post_id);
      if (post) queue.push({ ...base, kind: 'post', post });
    }
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
 * Put posts, uploads and YouTube videos at the end of a session's queue. A post goes in only when
 * everyone in the chat can watch it, an upload only when it's the adder's own (made for watch
 * together; the caller checks that first) and everyone may see it; the others come back with the
 * reason. With nothing on screen, the first one added goes on screen (paused unless `play`).
 */
export async function addToQueue(
  c: PoolClient,
  sessionId: string,
  conversationId: string,
  userId: string,
  input: QueueInput,
  play = false,
): Promise<{ added: string[]; skipped: QueueSkip[]; changedPlayback: boolean }> {
  const members = await chatMembers(c, conversationId);
  const postIds = [...new Set(input.postIds ?? [])];
  const mediaIds = [...new Set(input.mediaIds ?? [])];
  const youtube = [...new Map((input.youtube ?? []).map((y) => [y.videoId, y])).values()];
  const verdicts = await checkWatchable(c, postIds, members);
  const uploads = await checkUploads(c, mediaIds, members);
  const waitingRows = (
    await c.query<{ post_id: string | null; media_id: string | null; youtube_id: string | null }>(
      `SELECT post_id, media_id, youtube_id FROM watch_queue_items WHERE session_id = $1 AND status IN ('queued', 'playing')`,
      [sessionId],
    )
  ).rows;
  const waiting = new Set(waitingRows.map((r) => r.post_id ?? r.media_id ?? r.youtube_id));
  let room = WATCH_QUEUE_MAX - waiting.size;
  const added: string[] = [];
  const skipped: QueueSkip[] = [];
  let next = Number((await c.query(`SELECT coalesce(max(position), 0) + 1 AS n FROM watch_queue_items WHERE session_id = $1`, [sessionId])).rows[0].n);
  type Candidate = { key: string; verdict: 'ok' | WatchSkipReason; skip: Omit<QueueSkip, 'reason'>; kind: 'post' | 'upload' | 'youtube'; yt?: YouTubeToAdd };
  const candidates: Candidate[] = [
    ...postIds.map((postId): Candidate => ({ key: postId, verdict: verdicts.get(postId)!, skip: { postId }, kind: 'post' })),
    ...mediaIds.map((mediaId): Candidate => {
      const v = uploads.get(mediaId)!;
      return { key: mediaId, verdict: v === 'invalid' ? 'unavailable' : v, skip: { mediaId }, kind: 'upload' };
    }),
    ...youtube.map((yt): Candidate => ({ key: yt.videoId, verdict: 'ok', skip: { videoId: yt.videoId }, kind: 'youtube', yt })),
  ];
  for (const cand of candidates) {
    if (cand.verdict !== 'ok') skipped.push({ ...cand.skip, reason: cand.verdict });
    else if (waiting.has(cand.key)) skipped.push({ ...cand.skip, reason: 'already_queued' });
    else if (room <= 0) skipped.push({ ...cand.skip, reason: 'queue_full' });
    else {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO watch_queue_items (session_id, added_by, position, kind, post_id, media_id, youtube_id, title, thumbnail_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [
          sessionId,
          userId,
          next++,
          cand.kind,
          cand.skip.postId ?? null,
          cand.skip.mediaId ?? null,
          cand.yt?.videoId ?? null,
          cand.yt?.title ?? null,
          cand.yt?.thumbnailUrl ?? null,
        ],
      );
      added.push(rows[0]!.id);
      waiting.add(cand.key);
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
    await c.query<{ id: string; post_id: string | null; media_id: string | null }>(
      `SELECT id, post_id, media_id FROM watch_queue_items WHERE session_id = $1 AND status = 'queued' ${target ? 'AND id = $2' : ''} ORDER BY position`,
      target ? [session.id, target] : [session.id],
    )
  ).rows;
  // Posts are checked against everyone in the chat again, and so are uploads (blocked or marked
  // sensitive since they were added); YouTube's own player decides about its videos.
  const verdicts = await checkWatchable(
    c,
    queued.map((q) => q.post_id).filter((x): x is string => !!x),
    members,
  );
  const uploads = await checkUploads(
    c,
    queued.map((q) => q.media_id).filter((x): x is string => !!x),
    members,
  );
  const skipped: WatchSkipReason[] = [];
  let chosen: string | null = null;
  for (const q of queued) {
    const v = q.post_id ? verdicts.get(q.post_id)! : q.media_id ? uploads.get(q.media_id)! : 'ok';
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

/** The job that takes the line of a session nobody else joined out of the chat, once it can't be opened again. */
export const WATCH_TIDY_LINE_JOB = 'watch.tidy_line';

/** Tell everyone in a chat that a line changed (`message.system`). */
async function publishLine(deps: WatchDeps, conversationId: string, lineId: string, system: MessageSystemInfo): Promise<void> {
  await deps.realtime.publish(await chatMembers(deps.db, conversationId), { type: 'message.system', data: { id: lineId, conversationId, system } });
}

/**
 * End a session: everyone leaves, and everyone in the chat hears it ended. Its line says how long
 * people watched together; when nobody else joined, the line leaves the chat after
 * WATCH_REOPEN_MINUTES (unless its starter opens it again before then). Files added from devices
 * are deleted (after the usual grace period for deleted files).
 */
export async function endSession(deps: WatchDeps, sessionId: string): Promise<boolean> {
  const { rows } = await deps.db.query<{ conversation_id: string; line_id: string | null; seconds: number | null }>(
    `UPDATE watch_sessions SET status = 'ended', ended_at = now(), playing = false WHERE id = $1 AND status = 'active'
     RETURNING conversation_id, line_id, CASE WHEN together_at IS NOT NULL THEN greatest(0, round(extract(epoch FROM now() - together_at)))::int END AS seconds`,
    [sessionId],
  );
  const s = rows[0];
  if (!s) return false;
  const left = await deps.db.query<{ user_id: string }>(
    `UPDATE watch_participants SET left_at = now() WHERE session_id = $1 AND left_at IS NULL RETURNING user_id`,
    [sessionId],
  );
  await deleteUploads(deps.db, sessionId);
  const members = await chatMembers(deps.db, s.conversation_id);
  await deps.realtime.publish([...new Set([...members, ...left.rows.map((r) => r.user_id)])], {
    type: 'watch.ended',
    data: { sessionId, conversationId: s.conversation_id },
  });
  if (s.line_id) {
    const system: MessageSystemInfo = { type: 'watch', sessionId, ended: true, seconds: s.seconds };
    const r = await deps.db.query(`UPDATE messages SET meta = $2 WHERE id = $1 AND kind = 'system'`, [s.line_id, system]);
    if (r.rowCount) await publishLine(deps, s.conversation_id, s.line_id, system);
    if (s.seconds === null) await enqueue(deps.db, WATCH_TIDY_LINE_JOB, { sessionId }, WATCH_REOPEN_MINUTES * 60 + 5);
  }
  return true;
}

/**
 * Files added to a session from devices are deleted when it ends, unless they're used somewhere
 * else (a post, a story, a listing, a stash, a Together album or a message of the person who
 * uploaded them, or another session still running). The usual clean-up erases them after the
 * grace period for deleted files.
 */
async function deleteUploads(db: Q, sessionId: string): Promise<void> {
  await db.query(
    `UPDATE media m SET deleted_at = now()
     WHERE m.for_watch AND m.deleted_at IS NULL
       AND m.id IN (SELECT q.media_id FROM watch_queue_items q WHERE q.session_id = $1 AND q.media_id IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM post_media pm WHERE pm.media_id = m.id)
       AND NOT EXISTS (SELECT 1 FROM moments st WHERE st.media_id = m.id)
       AND NOT EXISTS (SELECT 1 FROM market_listing_photos lp WHERE lp.media_id = m.id)
       AND NOT EXISTS (SELECT 1 FROM stashes sh WHERE sh.media_id = m.id)
       AND NOT EXISTS (SELECT 1 FROM together_contributions tc WHERE tc.media_id = m.id)
       AND NOT EXISTS (SELECT 1 FROM messages x WHERE x.sender_id = m.owner_id AND x.attachments @> jsonb_build_array(jsonb_build_object('mediaId', m.id::text)))
       AND NOT EXISTS (SELECT 1 FROM watch_queue_items o JOIN watch_sessions os ON os.id = o.session_id
                       WHERE o.media_id = m.id AND os.status = 'active' AND os.id <> $1)`,
    [sessionId],
  );
}

/** A session opened again: the files added to it from devices come back (they were only marked deleted). */
export async function restoreUploads(db: Q, sessionId: string): Promise<void> {
  await db.query(
    `UPDATE media m SET deleted_at = NULL
     WHERE m.for_watch AND m.deleted_at IS NOT NULL AND m.deleted_at > now() - make_interval(mins => $2)
       AND m.id IN (SELECT q.media_id FROM watch_queue_items q WHERE q.session_id = $1 AND q.media_id IS NOT NULL AND q.status IN ('queued', 'playing'))`,
    [sessionId, WATCH_REOPEN_MINUTES + 1],
  );
}

/**
 * Take the line of an ended session nobody else joined out of the chat: once it can't be opened
 * again (`olderThanMinutes`), or straight away when someone starts a new session in that chat.
 */
export async function tidyLonelyLines(deps: WatchDeps, where: { sessionId: string } | { conversationId: string }): Promise<number> {
  const { rows } = await deps.db.query<{ id: string; conversation_id: string }>(
    // The session's line_id empties itself (ON DELETE SET NULL).
    `DELETE FROM messages m USING watch_sessions s
     WHERE m.id = s.line_id AND m.kind = 'system' AND s.status = 'ended' AND s.together_at IS NULL
       AND ${'sessionId' in where ? `s.id = $1 AND s.ended_at <= now() - make_interval(mins => ${WATCH_REOPEN_MINUTES})` : 's.conversation_id = $1'}
     RETURNING m.id, m.conversation_id`,
    ['sessionId' in where ? where.sessionId : where.conversationId],
  );
  for (const r of rows)
    await deps.realtime.publish(await chatMembers(deps.db, r.conversation_id), {
      type: 'message.deleted',
      data: { id: r.id, conversationId: r.conversation_id },
    });
  return rows.length;
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

/**
 * What to watch next, for everyone in a session's chat to see the same few: reels and video posts
 * every one of them can see and open (the queue's own rule), not watched or waiting in this
 * session yet. First the newest from people in the chat, then the most liked of the last month.
 * Hydrated as `viewer` sees them.
 */
export async function suggestions(db: Q, sessionId: string, conversationId: string, viewer: string, limit = 6): Promise<Post[]> {
  const members = await chatMembers(db, conversationId);
  const { rows } = await db.query<{ id: string }>(
    `SELECT p.id FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
     WHERE p.deleted_at IS NULL AND p.status = 'published' AND p.format IN ('reel', 'post')
       AND p.created_at > now() - interval '30 days'
       AND NOT EXISTS (SELECT 1 FROM watch_queue_items q WHERE q.session_id = $2 AND q.post_id = p.id)
       AND ${WATCHABLE_SQL} AND ${visibleToAllSql('$1::uuid[]')}
     ORDER BY (p.author_id = ANY($1::uuid[])) DESC, CASE WHEN p.author_id = ANY($1::uuid[]) THEN extract(epoch FROM p.created_at) ELSE p.like_count END DESC, p.id
     LIMIT $3`,
    [members, sessionId, limit],
  );
  return hydratePosts(
    db,
    rows.map((r) => r.id),
    viewer,
  );
}
