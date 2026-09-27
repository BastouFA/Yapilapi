import type { Pool, PoolClient } from 'pg';
import type { PublicUser, RoomDetail, RoomParticipant, RoomSummary } from '@yapilapi/shared';
import { minorRuleSql } from './collabs.ts';
import type { RealtimeHub } from './realtime.ts';
import type { RoomMedia } from './room-media.ts';
import { PUBLIC_USER_COLS, plusCol, publicUserFrom, toPublicUser, type PublicUserRow } from './users.ts';

type Q = Pool | PoolClient;

export interface RoomsDeps {
  db: Q;
  realtime: RealtimeHub;
  media: RoomMedia;
}

/** Clients send a heartbeat every 15 seconds; someone not seen for this long has left. */
export const ROOM_PRESENCE_SECONDS = 45;
/** A live room with no host in it for this long ends on its own. */
export const ROOM_HOSTLESS_SECONDS = 300;

/**
 * Who may bring whom up to speak, for minor safety: the messaging rule. An adult
 * and someone under 18 can do it only once they're friends or linked through a
 * family link the teen accepted. Unknown ages count as adult, as for messages.
 */
export function roomStageRuleSql(a: string, b: string): string {
  return `(${minorRuleSql(a, b)}
           OR EXISTS (SELECT 1 FROM family_links fl WHERE fl.status = 'active'
                      AND ((fl.guardian_id = ${a} AND fl.teen_id = ${b}) OR (fl.guardian_id = ${b} AND fl.teen_id = ${a}))))`;
}

const SUMMARY_SELECT = `
  SELECT r.id, r.title, r.status, r.community_id, r.created_by, r.scheduled_for, r.started_at, r.ended_at, r.peak_listeners,
         c.slug AS c_slug, c.name AS c_name,
         CASE WHEN r.ended_at IS NOT NULL AND r.started_at IS NOT NULL
              THEN greatest(0, floor(extract(epoch FROM r.ended_at - r.started_at)))::int END AS duration_seconds,
         (SELECT count(*) FROM room_participants p WHERE p.room_id = r.id AND p.left_at IS NULL)::int AS listener_count,
         (SELECT count(*) FROM room_participants p WHERE p.room_id = r.id AND p.left_at IS NULL AND p.role = 'speaker')::int AS speaker_count,
         coalesce(EXISTS (SELECT 1 FROM room_reminders rr WHERE rr.room_id = r.id AND rr.user_id = $1), false) AS remind_me,
         pr.user_id AS cb_id, pr.username AS cb_username, pr.display_name AS cb_display_name, pr.avatar_url AS cb_avatar_url, pr.mode AS cb_mode,
         ${plusCol('cb_')}
  FROM rooms r
  JOIN communities c ON c.id = r.community_id
  JOIN profiles pr ON pr.user_id = r.created_by`;

function toSummary(r: Record<string, any>, limits: RoomMedia['limits'], preview: PublicUser[]): RoomSummary {
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    community: { id: r.community_id, slug: r.c_slug, name: r.c_name },
    createdBy: publicUserFrom(r, 'cb_'),
    scheduledFor: r.scheduled_for?.toISOString() ?? null,
    startedAt: r.started_at?.toISOString() ?? null,
    endedAt: r.ended_at?.toISOString() ?? null,
    durationSeconds: r.duration_seconds ?? null,
    peakListeners: r.peak_listeners,
    listenerCount: r.listener_count,
    speakerCount: r.speaker_count,
    speakerPreview: preview,
    remindMe: !!r.remind_me,
    limits,
  };
}

type ParticipantRow = PublicUserRow & {
  room_id: string;
  role: 'speaker' | 'listener';
  is_host: boolean;
  muted: boolean;
  hand_raised_at: Date | null;
  invited_at: Date | null;
  minor: boolean;
};

async function presentParticipants(db: Q, roomIds: string[]): Promise<ParticipantRow[]> {
  if (!roomIds.length) return [];
  const { rows } = await db.query<ParticipantRow>(
    `SELECT p.room_id, p.role, p.is_host, p.muted, p.hand_raised_at, p.invited_at, ${PUBLIC_USER_COLS},
            coalesce((SELECT u.birth_date > current_date - interval '18 years' FROM users u WHERE u.id = p.user_id), false) AS minor
     FROM room_participants p JOIN profiles pr ON pr.user_id = p.user_id
     WHERE p.room_id = ANY($1::uuid[]) AND p.left_at IS NULL
     ORDER BY p.is_host DESC, p.hand_raised_at ASC NULLS LAST, p.joined_at ASC`,
    [roomIds],
  );
  return rows;
}

const toParticipant = (r: ParticipantRow): RoomParticipant => ({
  user: toPublicUser(r),
  role: r.role,
  host: r.is_host,
  muted: r.muted,
  handRaised: !!r.hand_raised_at,
  invited: !!r.invited_at,
});

/** Rooms of one community for its page: live first, then scheduled ones by time, then the last few that ended. */
export async function communityRooms(deps: RoomsDeps, communityId: string, viewer: string | null): Promise<RoomSummary[]> {
  const { rows } = await deps.db.query(
    `(${SUMMARY_SELECT} WHERE r.community_id = $2 AND r.status IN ('live', 'scheduled')
       ORDER BY (r.status = 'live') DESC, r.scheduled_for ASC NULLS FIRST LIMIT 25)
     UNION ALL
     (${SUMMARY_SELECT} WHERE r.community_id = $2 AND r.status = 'ended' AND r.ended_at > now() - interval '30 days'
       ORDER BY r.ended_at DESC LIMIT 5)`,
    [viewer, communityId],
  );
  const people = await presentParticipants(
    deps.db,
    rows.filter((r) => r.status === 'live').map((r) => r.id),
  );
  // The list is public for public communities: people without an account never see anyone under 18
  // (as on profiles), and nobody sees people they blocked or who blocked them.
  const blocked = viewer
    ? new Set(
        (
          await deps.db.query<{ id: string }>(
            `SELECT CASE WHEN blocker_id = $1 THEN blocked_id ELSE blocker_id END AS id FROM blocks WHERE blocker_id = $1 OR blocked_id = $1`,
            [viewer],
          )
        ).rows.map((b) => b.id),
      )
    : new Set<string>();
  return rows.map((r) =>
    toSummary(
      r,
      deps.media.limits,
      people
        .filter((p) => p.room_id === r.id && p.role === 'speaker' && (viewer ? !blocked.has(p.id) : !p.minor))
        .slice(0, 3)
        .map(toPublicUser),
    ),
  );
}

export async function roomSummary(deps: RoomsDeps, roomId: string, viewer: string | null): Promise<RoomSummary | null> {
  const d = await roomDetail(deps, roomId, viewer);
  if (!d) return null;
  const { speakers: _s, listeners: _l, ...summary } = d;
  return summary;
}

export async function roomDetail(deps: RoomsDeps, roomId: string, viewer: string | null): Promise<RoomDetail | null> {
  const { rows } = await deps.db.query(`${SUMMARY_SELECT} WHERE r.id = $2`, [viewer, roomId]);
  if (!rows[0]) return null;
  const people = (await presentParticipants(deps.db, [roomId])).map(toParticipant);
  const speakers = people.filter((p) => p.role === 'speaker');
  return {
    ...toSummary(
      rows[0],
      deps.media.limits,
      speakers.slice(0, 3).map((p) => p.user),
    ),
    speakers,
    listeners: people.filter((p) => p.role === 'listener'),
  };
}

/** Everyone in the room now, plus `also` (someone who just left or was removed), gets the room as it is. */
export async function publishRoomState(deps: RoomsDeps, roomId: string, also: string[] = []): Promise<void> {
  const room = await roomDetail(deps, roomId, null);
  if (!room) return;
  const ids = [...room.speakers, ...room.listeners].map((p) => p.user.id);
  await deps.realtime.publish([...new Set([...ids, ...also])], { type: 'room.state', data: room });
}

/**
 * Close a room: a scheduled one is cancelled, a live one ended. `abandoned` ends
 * it at the last time a host was there, so the duration doesn't count the empty
 * minutes after. Returns false when it was already over.
 */
export async function endRoom(deps: RoomsDeps, roomId: string, how: 'now' | 'abandoned' = 'now'): Promise<boolean> {
  const r = await deps.db.query(
    `UPDATE rooms SET status = CASE WHEN status = 'scheduled' THEN 'cancelled' ELSE 'ended' END,
            ended_at = ${how === 'abandoned' ? 'greatest(coalesce(host_seen_at, started_at), started_at)' : 'now()'}
     WHERE id = $1 AND status IN ('scheduled', 'live') RETURNING id`,
    [roomId],
  );
  if (!r.rowCount) return false;
  const left = await deps.db.query<{ user_id: string }>(
    `UPDATE room_participants SET left_at = now(), hand_raised_at = NULL, invited_at = NULL WHERE room_id = $1 AND left_at IS NULL RETURNING user_id`,
    [roomId],
  );
  await deps.media.roomEnded(roomId);
  await publishRoomState(
    deps,
    roomId,
    left.rows.map((x) => x.user_id),
  );
  return true;
}

/** Record the most people in the room at once. */
export async function notePeak(db: Q, roomId: string): Promise<void> {
  await db.query(
    `UPDATE rooms SET peak_listeners = greatest(peak_listeners, (SELECT count(*) FROM room_participants WHERE room_id = $1 AND left_at IS NULL)) WHERE id = $1`,
    [roomId],
  );
}

/**
 * Housekeeping, run by the job worker every few seconds: people whose app
 * stopped sending heartbeats leave their room, and live rooms without a host
 * for five minutes end. Returns how many rooms changed.
 */
export async function sweepRooms(deps: RoomsDeps): Promise<number> {
  const gone = await deps.db.query<{ room_id: string; user_id: string }>(
    `UPDATE room_participants p SET left_at = now(), hand_raised_at = NULL, invited_at = NULL
     FROM rooms r
     WHERE r.id = p.room_id AND r.status = 'live' AND p.left_at IS NULL AND p.last_seen_at < now() - make_interval(secs => $1)
     RETURNING p.room_id, p.user_id`,
    [ROOM_PRESENCE_SECONDS],
  );
  const changed = new Set(gone.rows.map((r) => r.room_id));
  for (const row of gone.rows) await deps.media.participantChanged(row.room_id, row.user_id, null);
  const hostless = await deps.db.query<{ id: string }>(
    `SELECT id FROM rooms WHERE status = 'live' AND coalesce(host_seen_at, started_at) < now() - make_interval(secs => $1)
       AND NOT EXISTS (SELECT 1 FROM room_participants p WHERE p.room_id = rooms.id AND p.left_at IS NULL AND p.is_host)`,
    [ROOM_HOSTLESS_SECONDS],
  );
  for (const r of hostless.rows) {
    await endRoom(deps, r.id, 'abandoned');
    changed.delete(r.id);
  }
  for (const id of changed)
    await publishRoomState(
      deps,
      id,
      gone.rows.filter((g) => g.room_id === id).map((g) => g.user_id),
    );
  return changed.size + hostless.rows.length;
}

/** Someone banned from a community leaves its live room at once and can't come back to it. */
export async function removeFromCommunityRooms(deps: RoomsDeps, communityId: string, userId: string, byUserId: string): Promise<void> {
  const { rows } = await deps.db.query<{ room_id: string }>(
    `UPDATE room_participants p SET left_at = coalesce(p.left_at, now()), removed_at = now(), removed_by = $3, hand_raised_at = NULL, invited_at = NULL
     FROM rooms r
     WHERE r.id = p.room_id AND r.community_id = $1 AND p.user_id = $2 AND r.status IN ('live', 'scheduled') AND p.removed_at IS NULL
     RETURNING p.room_id`,
    [communityId, userId, byUserId],
  );
  for (const r of rows) {
    await deps.media.participantChanged(r.room_id, userId, null);
    await deps.realtime.publish([userId], { type: 'room.removed', data: { roomId: r.room_id } });
    await publishRoomState(deps, r.room_id);
  }
}
