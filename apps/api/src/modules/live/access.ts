import type { Queryable } from '@yapilapi/database';
import { AppError, forbidden, notFound } from '@yapilapi/shared';
import type { AppContext } from '../../lib/context.js';
import { can, type LiveAction, type LiveRole, type LiveStatus } from './rules.js';

export interface LiveRow {
  id: string;
  host_id: string;
  title: string;
  description: string;
  status: LiveStatus;
  visibility: 'public' | 'followers' | 'subscribers' | 'private';
  scheduled_for: Date | null;
  started_at: Date | null;
  ended_at: Date | null;
  ticket_type_id: string | null;
  event_id: string | null;
  peak_viewers: number;
  media_mode: 'video' | 'interactive';
  ingest_provider: string;
  ingest_ref: string | null;
  ingest_state: string;
  slow_mode_sec: number;
  chat_enabled: boolean;
  blocked_terms: string[];
  viewer_count: number;
  recording_media_id: string | null;
  ended_by: string | null;
  end_reason: string | null;
  language: string | null;
  created_at: Date;
  updated_at: Date;
}
export const LIVE_COLS = `s.id, s.host_id, s.title, s.description, s.status, s.visibility, s.scheduled_for, s.started_at, s.ended_at, s.ticket_type_id, s.event_id, s.peak_viewers,
  s.media_mode, s.ingest_provider, s.ingest_ref, s.ingest_state, s.slow_mode_sec, s.chat_enabled, s.blocked_terms, s.viewer_count, s.recording_media_id, s.ended_by, s.end_reason,
  s.language, s.created_at, s.updated_at`;

/**
 * THE visibility rule for live sessions (listing, detail, chat, gifting all use it): who may SEE a session.
 * Host and appointed team always; otherwise the host must be active, nobody is blocked either way, cancelled sessions are hidden, and
 * public = not a private profile (or followed), followers = follows the host, subscribers = an entitled subscription (same rule as
 * visibility.ts / creator/entitlements.ts), private = team only. Joining additionally needs a ticket when the session has one (see ticketHeld).
 */
export function liveVisibleSql(viewer: string, s = 's'): string {
  const V = `(${viewer})`;
  const follows = `EXISTS (SELECT 1 FROM follows fw WHERE fw.follower_id = ${V} AND fw.followee_id = ${s}.host_id AND fw.status = 'active')`;
  const subscribed = `EXISTS (SELECT 1 FROM subscriptions sb JOIN subscription_plans sbp ON sbp.id = sb.plan_id
      WHERE sb.subscriber_id = ${V} AND sb.creator_id = ${s}.host_id AND sbp.tier >= 1
        AND ((sb.status = 'active' AND sb.current_period_end + interval '1 day' > now()) OR (sb.status = 'past_due' AND sb.current_period_end + interval '3 days' > now())))`;
  const team = `EXISTS (SELECT 1 FROM live_participants tp WHERE tp.live_id = ${s}.id AND tp.user_id = ${V} AND tp.role IN ('cohost','moderator') AND tp.banned_at IS NULL)`;
  return `(
    EXISTS (SELECT 1 FROM users uh WHERE uh.id = ${s}.host_id AND uh.deleted_at IS NULL AND uh.status = 'active')
    AND (${V} IS NULL OR NOT EXISTS (SELECT 1 FROM user_blocks bl WHERE (bl.blocker_id = ${V} AND bl.blocked_id = ${s}.host_id) OR (bl.blocker_id = ${s}.host_id AND bl.blocked_id = ${V})))
    AND (
      (${V} IS NOT NULL AND ${s}.host_id = ${V})
      OR (${V} IS NOT NULL AND ${team})
      OR (${s}.status <> 'cancelled' AND CASE ${s}.visibility
        WHEN 'public' THEN (NOT EXISTS (SELECT 1 FROM profiles pp WHERE pp.user_id = ${s}.host_id AND pp.is_private) OR (${V} IS NOT NULL AND ${follows}))
        WHEN 'followers' THEN (${V} IS NOT NULL AND ${follows})
        WHEN 'subscribers' THEN (${V} IS NOT NULL AND ${subscribed})
        ELSE false
      END)
    )
  )`;
}

export async function loadLiveRaw(
  db: Queryable,
  id: string,
  forUpdate = false,
): Promise<LiveRow | null> {
  return (
    (
      await db.query<LiveRow>(
        `SELECT ${LIVE_COLS} FROM live_sessions s WHERE s.id = $1${forUpdate ? ' FOR UPDATE OF s' : ''}`,
        [id],
      )
    ).rows[0] ?? null
  );
}

export interface Participant {
  role: LiveRole;
  joined_at: Date;
  left_at: Date | null;
  muted_until: Date | null;
  banned_at: Date | null;
}
export async function loadParticipant(
  db: Queryable,
  liveId: string,
  userId: string,
): Promise<Participant | null> {
  return (
    (
      await db.query<Participant>(
        'SELECT role, joined_at, left_at, muted_until, banned_at FROM live_participants WHERE live_id = $1 AND user_id = $2',
        [liveId, userId],
      )
    ).rows[0] ?? null
  );
}

/** Does `userId` hold an active grant for the session's ticket type? (Tickets are sold by the existing events/commerce checkout.) */
export async function ticketHeld(
  db: Queryable,
  s: Pick<LiveRow, 'ticket_type_id' | 'event_id'>,
  userId: string,
): Promise<boolean> {
  if (!s.ticket_type_id) return true;
  const { rowCount } = await db.query(
    `SELECT 1 FROM event_ticket_grants WHERE ticket_type_id = $1 AND user_id = $2 AND status = 'active' LIMIT 1`,
    [s.ticket_type_id, userId],
  );
  return (rowCount ?? 0) > 0;
}

export interface LiveAccess {
  session: LiveRow;
  userId: string;
  role: LiveRole;
  participant: Participant | null;
  /** The viewer is the host or team, or holds the ticket (true when the session has none). */
  entitled: boolean;
  /** Present in the room right now. */
  present: boolean;
}

/**
 * Load a session the viewer may see, or throw 404 (hidden and missing are indistinguishable). A banned participant sees nothing.
 * Never used for staff, who go through the staff routes.
 */
export async function loadAccess(
  db: Queryable,
  viewerId: string,
  liveId: string,
): Promise<LiveAccess> {
  const s = (
    await db.query<LiveRow>(
      `SELECT ${LIVE_COLS} FROM live_sessions s WHERE s.id = $2 AND ${liveVisibleSql('$1::uuid')}`,
      [viewerId, liveId],
    )
  ).rows[0];
  if (!s) throw notFound('Live session');
  const participant = await loadParticipant(db, liveId, viewerId);
  if (participant?.banned_at) throw notFound('Live session');
  const role: LiveRole =
    s.host_id === viewerId
      ? 'host'
      : participant && participant.role !== 'host'
        ? participant.role
        : 'audience';
  const team = role !== 'audience';
  return {
    session: s,
    userId: viewerId,
    role,
    participant,
    entitled: team || (await ticketHeld(db, s, viewerId)),
    present: Boolean(participant && !participant.left_at),
  };
}

/** 403 when the role may not do the action (the resource was already proven visible by loadAccess). */
export function requireCan(a: LiveAccess, action: LiveAction): void {
  if (!can(a.role, action)) throw forbidden('Your role in this session does not allow that');
}

/**
 * The seam the creator module uses for live gifts (dynamic import in creator/tips-gifts.ts): may `viewerId` gift `recipientId` in session `liveId`?
 * The session must be visible to the viewer and live right now, the viewer must not be banned or blocked, must hold the ticket when there is one, and
 * the recipient must be the host or an appointed co-host. Money handling stays in the creator module.
 */
export async function assertLiveGiftable(
  ctx: AppContext,
  viewerId: string,
  liveId: string,
  recipientId: string,
): Promise<void> {
  const a = await loadAccess(ctx.db, viewerId, liveId); // 404 when hidden / banned
  if (a.session.status !== 'live')
    throw new AppError('conflict', 'This live session is not on air', {
      reason: 'live_not_live',
      status: a.session.status,
    });
  if (!a.entitled)
    throw new AppError('payment_required', 'You need a ticket for this live session', {
      reason: 'ticket_required',
    });
  if (recipientId !== a.session.host_id) {
    const p = await loadParticipant(ctx.db, liveId, recipientId);
    if (p?.role !== 'cohost' || p.banned_at)
      throw forbidden('Gifts in a live session go to the host or a co-host');
  }
  if (recipientId === viewerId) throw forbidden('You cannot gift yourself');
  const { rowCount } = await ctx.db.query(
    `SELECT 1 FROM user_blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
    [viewerId, recipientId],
  );
  if (rowCount) throw notFound('Live session');
}
