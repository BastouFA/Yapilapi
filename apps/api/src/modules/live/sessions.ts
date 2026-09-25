import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTransaction, type Queryable } from '@yapilapi/database';
import { AppError, conflict, forbidden, invalid, notFound } from '@yapilapi/shared';
import type { AppContext } from '../../lib/context.js';
import type { AuthContext } from '../../lib/auth-context.js';
import { audit } from '../../lib/audit.js';
import { assertTextAllowed } from '../../lib/text-guard.js';
import { requireCreator } from '../creator/profile.js';
import { publishLive } from './events.js';
import {
  LIVE_COLS,
  liveVisibleSql,
  loadAccess,
  loadLiveRaw,
  loadParticipant,
  requireCan,
  ticketHeld,
  type LiveAccess,
  type LiveRow,
} from './access.js';
import {
  canTransition,
  cleanTerms,
  hostingRefusal,
  scheduleRefusal,
  type LiveRole,
} from './rules.js';
import { getLiveRuntime } from './runtime.js';

const visibilitySchema = z.enum(['public', 'followers', 'subscribers', 'private']);
const languageSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/);

export const createBody = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).default(''),
  visibility: visibilitySchema.default('followers'),
  mediaMode: z.enum(['video', 'interactive']).default('interactive'),
  scheduledFor: z.iso.datetime().optional(),
  ticketTypeId: z.uuid().optional(),
  language: languageSchema.optional(),
});
export const patchBody = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    description: z.string().trim().max(2000).optional(),
    scheduledFor: z.iso.datetime().nullable().optional(),
    language: languageSchema.nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');
export const settingsBody = z
  .object({
    chatEnabled: z.boolean().optional(),
    slowModeSec: z.number().int().min(0).max(300).optional(),
    blockedTerms: z.array(z.string().trim().min(1).max(60)).max(60).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');
export const endBody = z.object({ reason: z.string().trim().max(200).optional() });
export const teamBody = z.object({ role: z.enum(['cohost', 'moderator']) });

const MAX_OPEN_PER_HOST = 20;

export function sessionView(
  s: LiveRow,
  o: {
    role?: LiveRole;
    entitled?: boolean;
    team?: boolean;
    host?: { id: string; username: string; displayName: string } | null;
  } = {},
) {
  const team = o.team ?? (o.role !== undefined && o.role !== 'audience');
  return {
    id: s.id,
    hostId: s.host_id,
    host: o.host ?? undefined,
    title: s.title,
    description: s.description,
    status: s.status,
    visibility: s.visibility,
    mediaMode: s.media_mode,
    scheduledFor: s.scheduled_for?.toISOString() ?? null,
    startedAt: s.started_at?.toISOString() ?? null,
    endedAt: s.ended_at?.toISOString() ?? null,
    language: s.language,
    viewerCount: s.viewer_count,
    peakViewers: s.peak_viewers,
    chatEnabled: s.chat_enabled,
    slowModeSec: s.slow_mode_sec,
    ticket: s.ticket_type_id
      ? {
          required: true,
          ticketTypeId: s.ticket_type_id,
          eventId: s.event_id,
          held: o.entitled ?? false,
        }
      : { required: false },
    // Video: whether a stream is connected; never claims video that is not there.
    video: s.media_mode === 'video' ? { ingestState: s.ingest_state } : null,
    hasRecording: Boolean(s.recording_media_id),
    ...(o.role ? { viewerRole: o.role } : {}),
    ...(team ? { blockedTerms: s.blocked_terms, endReason: s.end_reason } : {}),
    createdAt: s.created_at.toISOString(),
  };
}

async function hostSummary(
  db: Queryable,
  ids: string[],
): Promise<Map<string, { id: string; username: string; displayName: string }>> {
  if (!ids.length) return new Map();
  const { rows } = await db.query<{ user_id: string; username: string; display_name: string }>(
    'SELECT user_id, username::text, display_name FROM profiles WHERE user_id = ANY($1::uuid[])',
    [ids],
  );
  return new Map(
    rows.map((r) => [
      r.user_id,
      { id: r.user_id, username: r.username, displayName: r.display_name },
    ]),
  );
}

// ------------------------------------------------------------------ create / edit
export async function createSession(
  ctx: AppContext,
  auth: AuthContext,
  b: z.infer<typeof createBody>,
  req?: FastifyRequest,
): Promise<LiveRow> {
  await ctx.flags.require('LIVE', auth.userId);
  assertTextAllowed(b.title, b.description);
  const refusal = hostingRefusal({
    ageBand: auth.ageBand,
    visibility: b.visibility,
    ticketed: Boolean(b.ticketTypeId),
  });
  if (refusal) throw forbidden(refusal);
  let at: Date | null = null;
  if (b.scheduledFor) {
    at = new Date(b.scheduledFor);
    const s = scheduleRefusal(at, new Date());
    if (s) throw invalid(s);
  }
  // Subscriber-only sessions need an active creator account: that is where plans and payouts live.
  if (b.visibility === 'subscribers') await requireCreator(ctx.db, auth.userId);
  let eventId: string | null = null;
  if (b.ticketTypeId) {
    // Tickets ride on the events module: the ticket type must belong to an event the host runs.
    const t = (
      await ctx.db.query<{ event_id: string }>(
        `SELECT tt.event_id FROM event_ticket_types tt JOIN events e ON e.id = tt.event_id WHERE tt.id = $1 AND e.host_id = $2 AND tt.archived_at IS NULL AND e.deleted_at IS NULL`,
        [b.ticketTypeId, auth.userId],
      )
    ).rows[0];
    if (!t) throw invalid('That ticket type is not one of your events');
    eventId = t.event_id;
  }
  const row = await withTransaction(ctx.db, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`live-host:${auth.userId}`]);
    const open = Number(
      (
        await tx.query(
          `SELECT count(*)::int AS n FROM live_sessions WHERE host_id = $1 AND status IN ('scheduled','live')`,
          [auth.userId],
        )
      ).rows[0]!.n,
    );
    if (open >= MAX_OPEN_PER_HOST)
      throw conflict('You have too many open live sessions: end or cancel some first', {
        reason: 'too_many_sessions',
      });
    const { rows } = await tx.query<LiveRow>(
      `INSERT INTO live_sessions AS s (host_id, title, description, visibility, scheduled_for, media_mode, ticket_type_id, event_id, language)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${LIVE_COLS}`,
      [
        auth.userId,
        b.title,
        b.description,
        b.visibility,
        at,
        b.mediaMode,
        b.ticketTypeId ?? null,
        eventId,
        b.language ?? null,
      ],
    );
    await tx.query(
      `INSERT INTO live_participants (live_id, user_id, role, left_at) VALUES ($1,$2,'host', now())`,
      [rows[0]!.id, auth.userId],
    );
    return rows[0]!;
  });
  await audit(
    ctx,
    {
      actorId: auth.userId,
      action: 'live.created',
      targetType: 'live_session',
      targetId: row.id,
      metadata: {
        visibility: b.visibility,
        mediaMode: b.mediaMode,
        ticketed: Boolean(b.ticketTypeId),
      },
    },
    req,
  );
  return row;
}

export async function patchSession(
  ctx: AppContext,
  auth: AuthContext,
  id: string,
  b: z.infer<typeof patchBody>,
  req?: FastifyRequest,
): Promise<LiveRow> {
  await ctx.flags.require('LIVE', auth.userId);
  const a = await loadAccess(ctx.db, auth.userId, id);
  requireCan(a, 'edit');
  if (a.session.status !== 'scheduled' && b.scheduledFor !== undefined)
    throw conflict('Only a scheduled session can be rescheduled', { reason: 'invalid_state' });
  if (a.session.status === 'ended' || a.session.status === 'cancelled')
    throw conflict('This session is over', { reason: 'invalid_state' });
  assertTextAllowed(b.title, b.description);
  let at: Date | null | undefined;
  if (b.scheduledFor !== undefined) {
    at = b.scheduledFor === null ? null : new Date(b.scheduledFor);
    if (at) {
      const s = scheduleRefusal(at, new Date());
      if (s) throw invalid(s);
    }
  }
  const { rows } = await ctx.db.query<LiveRow>(
    `UPDATE live_sessions s SET title = COALESCE($2, title), description = COALESCE($3, description), scheduled_for = CASE WHEN $4::boolean THEN $5 ELSE scheduled_for END, language = CASE WHEN $6::boolean THEN $7 ELSE language END
      WHERE id = $1 RETURNING ${LIVE_COLS}`,
    [
      id,
      b.title ?? null,
      b.description ?? null,
      at !== undefined,
      at ?? null,
      b.language !== undefined,
      b.language ?? null,
    ],
  );
  await audit(
    ctx,
    {
      actorId: auth.userId,
      action: 'live.updated',
      targetType: 'live_session',
      targetId: id,
      metadata: { fields: Object.keys(b) },
    },
    req,
  );
  publishLive(ctx, id, { type: 'live.updated', title: rows[0]!.title });
  return rows[0]!;
}

export async function updateSettings(
  ctx: AppContext,
  auth: AuthContext,
  id: string,
  b: z.infer<typeof settingsBody>,
  req?: FastifyRequest,
): Promise<LiveRow> {
  await ctx.flags.require('LIVE', auth.userId);
  const a = await loadAccess(ctx.db, auth.userId, id);
  requireCan(a, 'settings');
  if (a.session.status === 'ended' || a.session.status === 'cancelled')
    throw conflict('This session is over', { reason: 'invalid_state' });
  let terms: string[] | null = null;
  if (b.blockedTerms) {
    terms = cleanTerms(b.blockedTerms);
    if (!terms) throw invalid('Blocked terms are 2 to 40 characters each, at most 50');
  }
  const { rows } = await ctx.db.query<LiveRow>(
    `UPDATE live_sessions s SET chat_enabled = COALESCE($2, chat_enabled), slow_mode_sec = COALESCE($3, slow_mode_sec), blocked_terms = COALESCE($4::text[], blocked_terms) WHERE id = $1 RETURNING ${LIVE_COLS}`,
    [id, b.chatEnabled ?? null, b.slowModeSec ?? null, terms],
  );
  await audit(
    ctx,
    {
      actorId: auth.userId,
      action: 'live.settings_changed',
      targetType: 'live_session',
      targetId: id,
      metadata: {
        chatEnabled: b.chatEnabled,
        slowModeSec: b.slowModeSec,
        blockedTermCount: terms?.length,
      },
    },
    req,
  );
  publishLive(ctx, id, {
    type: 'live.updated',
    chatEnabled: rows[0]!.chat_enabled,
    slowModeSec: rows[0]!.slow_mode_sec,
  });
  return rows[0]!;
}

// ------------------------------------------------------------------ lifecycle
export interface StartResult {
  session: LiveRow;
  ingest: { url: string; streamKey: string; playbackUrl: string | null } | null;
}

/**
 * scheduled -> live. Interactive sessions start immediately; video sessions need an ingest provider (501 ingest_unavailable otherwise, and the
 * session stays scheduled). The stream key is returned once and never stored (only the provider's opaque handle is).
 */
export async function startSession(
  ctx: AppContext,
  auth: AuthContext,
  id: string,
  req?: FastifyRequest,
): Promise<StartResult> {
  await ctx.flags.require('LIVE', auth.userId);
  const a = await loadAccess(ctx.db, auth.userId, id);
  requireCan(a, 'start');
  if (!canTransition(a.session.status, 'live'))
    throw conflict(`This session is ${a.session.status}`, {
      reason: 'invalid_state',
      status: a.session.status,
    });
  let ingest: StartResult['ingest'] = null;
  let ref: string | null = null;
  let provider = 'none';
  if (a.session.media_mode === 'video') {
    const p = getLiveRuntime(ctx).ingest;
    const stream = await p.createStream({ liveId: id, hostId: auth.userId }); // throws 501 with the `none` provider
    ref = stream.ref;
    provider = p.name;
    ingest = {
      url: stream.ingestUrl,
      streamKey: stream.streamKey,
      playbackUrl: stream.playbackUrl,
    };
  }
  const row = await withTransaction(ctx.db, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`live-host:${auth.userId}`]);
    const other = await tx.query(
      `SELECT 1 FROM live_sessions WHERE host_id = $1 AND status = 'live' AND id <> $2`,
      [auth.userId, id],
    );
    if (other.rowCount)
      throw conflict('You are already live in another session', { reason: 'already_live' });
    const u = await tx.query<LiveRow>(
      `UPDATE live_sessions s SET status = 'live', started_at = now(), ingest_provider = $2, ingest_ref = $3, ingest_state = $4 WHERE id = $1 AND status = 'scheduled' RETURNING ${LIVE_COLS}`,
      [id, provider, ref, a.session.media_mode === 'video' ? 'waiting' : 'none'],
    );
    if (!u.rows[0])
      throw conflict('This session is no longer scheduled', { reason: 'invalid_state' });
    await tx.query(
      `UPDATE live_participants SET left_at = NULL, joined_at = now() WHERE live_id = $1 AND user_id = $2`,
      [id, auth.userId],
    );
    return u.rows[0];
  }).catch(async (err) => {
    if (ref)
      await getLiveRuntime(ctx)
        .ingest.endStream(ref)
        .catch(() => undefined); // do not leak a provider stream for a session that did not start
    throw err;
  });
  await audit(
    ctx,
    {
      actorId: auth.userId,
      action: 'live.started',
      targetType: 'live_session',
      targetId: id,
      metadata: { mediaMode: row.media_mode, provider },
    },
    req,
  );
  publishLive(ctx, id, { type: 'live.started', startedAt: row.started_at!.toISOString() });
  return { session: row, ingest };
}

/** Close a live session (host, co-host, staff or the maintenance job). Everybody is removed from the room; the ingest stream is released. */
export async function endLive(
  ctx: AppContext,
  liveId: string,
  by: { userId: string | null; kind: 'user' | 'staff' | 'system' },
  reason: string | null,
  req?: FastifyRequest,
): Promise<LiveRow> {
  const s = await withTransaction(ctx.db, async (tx) => {
    const cur = await loadLiveRaw(tx, liveId, true);
    if (!cur) throw notFound('Live session');
    if (!canTransition(cur.status, 'ended'))
      throw conflict(`This session is ${cur.status}`, {
        reason: 'invalid_state',
        status: cur.status,
      });
    const u = await tx.query<LiveRow>(
      `UPDATE live_sessions s SET status = 'ended', ended_at = now(), ended_by = $2, end_reason = $3, ingest_state = CASE WHEN ingest_state = 'none' THEN 'none' ELSE 'ended' END, viewer_count = 0 WHERE id = $1 RETURNING ${LIVE_COLS}`,
      [liveId, by.userId, reason],
    );
    await tx.query(
      'UPDATE live_participants SET left_at = now() WHERE live_id = $1 AND left_at IS NULL',
      [liveId],
    );
    await tx.query(
      `UPDATE live_polls SET status = 'closed', closed_at = now() WHERE live_id = $1 AND status = 'open'`,
      [liveId],
    );
    return { row: u.rows[0]!, ref: cur.ingest_ref };
  });
  if (s.ref)
    await getLiveRuntime(ctx)
      .ingest.endStream(s.ref)
      .catch((err) => ctx.log.warn({ err, liveId }, 'ingest endStream failed'));
  await audit(
    ctx,
    {
      actorId: by.userId,
      actorType: by.kind,
      action: by.kind === 'staff' ? 'live.ended_by_staff' : 'live.ended',
      targetType: 'live_session',
      targetId: liveId,
      metadata: { reason },
    },
    req,
  );
  publishLive(ctx, liveId, {
    type: 'live.ended',
    reason: by.kind === 'staff' ? 'ended_by_moderation' : (reason ?? 'ended'),
  });
  return s.row;
}

export async function endSession(
  ctx: AppContext,
  auth: AuthContext,
  id: string,
  reason: string | null,
  req?: FastifyRequest,
): Promise<LiveRow> {
  await ctx.flags.require('LIVE', auth.userId);
  const a = await loadAccess(ctx.db, auth.userId, id);
  requireCan(a, 'end');
  return endLive(ctx, id, { userId: auth.userId, kind: 'user' }, reason, req);
}

export async function cancelSession(
  ctx: AppContext,
  auth: AuthContext,
  id: string,
  req?: FastifyRequest,
): Promise<LiveRow> {
  await ctx.flags.require('LIVE', auth.userId);
  const a = await loadAccess(ctx.db, auth.userId, id);
  requireCan(a, 'cancel');
  const { rows } = await ctx.db.query<LiveRow>(
    `UPDATE live_sessions s SET status = 'cancelled', ended_at = now(), ended_by = $2, end_reason = 'cancelled' WHERE id = $1 AND status = 'scheduled' RETURNING ${LIVE_COLS}`,
    [id, auth.userId],
  );
  if (!rows[0])
    throw conflict(
      `This session is ${a.session.status}: only a scheduled session can be cancelled`,
      { reason: 'invalid_state', status: a.session.status },
    );
  await audit(
    ctx,
    { actorId: auth.userId, action: 'live.cancelled', targetType: 'live_session', targetId: id },
    req,
  );
  publishLive(ctx, id, { type: 'live.ended', reason: 'cancelled' });
  return rows[0];
}

// ------------------------------------------------------------------ team
export async function setTeamMember(
  ctx: AppContext,
  auth: AuthContext,
  id: string,
  userId: string,
  role: 'cohost' | 'moderator',
  req?: FastifyRequest,
): Promise<void> {
  await ctx.flags.require('LIVE', auth.userId);
  const a = await loadAccess(ctx.db, auth.userId, id);
  requireCan(a, 'manage_team');
  if (a.session.status === 'ended' || a.session.status === 'cancelled')
    throw conflict('This session is over', { reason: 'invalid_state' });
  if (userId === auth.userId) throw invalid('You are already the host');
  const u = (
    await ctx.db.query<{ age_band: string }>(
      `SELECT age_band FROM users WHERE id = $1 AND deleted_at IS NULL AND status = 'active'`,
      [userId],
    )
  ).rows[0];
  const blocked = await ctx.db.query(
    'SELECT 1 FROM user_blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)',
    [auth.userId, userId],
  );
  if (!u || blocked.rowCount) throw notFound('User');
  // A teen host's room stays teen-and-followers: adults are not appointed into it, and teens do not run adults' rooms.
  if (u.age_band !== auth.ageBand)
    throw forbidden('Team members must be in the same age group as the host');
  const banned = (await loadParticipant(ctx.db, id, userId))?.banned_at;
  if (banned)
    throw conflict('That person is banned from this session: lift the ban first', {
      reason: 'banned',
    });
  await ctx.db.query(
    `INSERT INTO live_participants (live_id, user_id, role, left_at, acted_by) VALUES ($1,$2,$3, now(), $4)
     ON CONFLICT (live_id, user_id) DO UPDATE SET role = EXCLUDED.role, acted_by = EXCLUDED.acted_by WHERE live_participants.role <> 'host'`,
    [id, userId, role, auth.userId],
  );
  await audit(
    ctx,
    {
      actorId: auth.userId,
      action: 'live.team_added',
      targetType: 'live_session',
      targetId: id,
      metadata: { userId, role },
    },
    req,
  );
}

export async function removeTeamMember(
  ctx: AppContext,
  auth: AuthContext,
  id: string,
  userId: string,
  req?: FastifyRequest,
): Promise<void> {
  await ctx.flags.require('LIVE', auth.userId);
  const a = await loadAccess(ctx.db, auth.userId, id);
  requireCan(a, 'manage_team');
  const r = await ctx.db.query(
    `UPDATE live_participants SET role = 'audience', acted_by = $3 WHERE live_id = $1 AND user_id = $2 AND role IN ('cohost','moderator') RETURNING 1`,
    [id, userId, auth.userId],
  );
  if (!r.rowCount) throw notFound('Team member');
  await recountViewers(ctx, id);
  await audit(
    ctx,
    {
      actorId: auth.userId,
      action: 'live.team_removed',
      targetType: 'live_session',
      targetId: id,
      metadata: { userId },
    },
    req,
  );
}

export async function listTeam(
  db: Queryable,
  id: string,
): Promise<Array<{ userId: string; role: string; username: string; displayName: string }>> {
  const { rows } = await db.query<{
    user_id: string;
    role: string;
    username: string;
    display_name: string;
  }>(
    `SELECT lp.user_id, lp.role, p.username::text, p.display_name FROM live_participants lp JOIN profiles p ON p.user_id = lp.user_id
      WHERE lp.live_id = $1 AND lp.role IN ('host','cohost','moderator') ORDER BY CASE lp.role WHEN 'host' THEN 0 WHEN 'cohost' THEN 1 ELSE 2 END, lp.joined_at`,
    [id],
  );
  return rows.map((r) => ({
    userId: r.user_id,
    role: r.role,
    username: r.username,
    displayName: r.display_name,
  }));
}

// ------------------------------------------------------------------ audience
/** Present audience only (team members are not counted as viewers). Keeps viewer_count and peak_viewers honest and broadcasts the number. */
export async function recountViewers(ctx: AppContext, id: string): Promise<number> {
  const { rows } = await ctx.db.query<{ viewer_count: number }>(
    `UPDATE live_sessions s SET viewer_count = c.n, peak_viewers = GREATEST(peak_viewers, c.n)
       FROM (SELECT count(*)::int AS n FROM live_participants WHERE live_id = $1 AND left_at IS NULL AND banned_at IS NULL AND role = 'audience') c
      WHERE s.id = $1 AND s.status = 'live' RETURNING s.viewer_count`,
    [id],
  );
  const n = rows[0]?.viewer_count ?? 0;
  if (rows[0]) publishLive(ctx, id, { type: 'viewers', count: n });
  return n;
}

export async function joinSession(
  ctx: AppContext,
  auth: AuthContext,
  id: string,
): Promise<LiveAccess> {
  await ctx.flags.require('LIVE', auth.userId);
  const a = await loadAccess(ctx.db, auth.userId, id);
  if (a.session.status !== 'live')
    throw conflict(
      a.session.status === 'scheduled'
        ? 'This session has not started yet'
        : 'This session is over',
      { reason: 'not_live', status: a.session.status },
    );
  if (!a.entitled)
    throw new AppError('payment_required', 'You need a ticket to join this live session', {
      reason: 'ticket_required',
      ticketTypeId: a.session.ticket_type_id,
    });
  if (a.role === 'audience') {
    await ctx.db.query(
      `INSERT INTO live_participants (live_id, user_id, role) VALUES ($1,$2,'audience') ON CONFLICT (live_id, user_id) DO UPDATE SET left_at = NULL, joined_at = CASE WHEN live_participants.left_at IS NULL THEN live_participants.joined_at ELSE now() END
        WHERE live_participants.banned_at IS NULL`,
      [id, auth.userId],
    );
  } else {
    await ctx.db.query(
      'UPDATE live_participants SET left_at = NULL WHERE live_id = $1 AND user_id = $2 AND left_at IS NOT NULL',
      [id, auth.userId],
    );
  }
  await recountViewers(ctx, id);
  return loadAccess(ctx.db, auth.userId, id);
}

export async function leaveSession(ctx: AppContext, auth: AuthContext, id: string): Promise<void> {
  await ctx.flags.require('LIVE', auth.userId);
  const a = await loadAccess(ctx.db, auth.userId, id);
  await ctx.db.query(
    'UPDATE live_participants SET left_at = now() WHERE live_id = $1 AND user_id = $2 AND left_at IS NULL',
    [id, auth.userId],
  );
  if (a.session.status === 'live') await recountViewers(ctx, id);
}

// ------------------------------------------------------------------ reads
export async function getSessionView(ctx: AppContext, viewerId: string, id: string) {
  const a = await loadAccess(ctx.db, viewerId, id);
  const hosts = await hostSummary(ctx.db, [a.session.host_id]);
  return {
    access: a,
    view: sessionView(a.session, {
      role: a.role,
      entitled: a.entitled,
      host: hosts.get(a.session.host_id) ?? null,
    }),
  };
}

export const listQuery = z.object({
  status: z.enum(['live', 'scheduled', 'ended']).default('live'),
  hostId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  before: z.iso.datetime().optional(),
});
export async function listSessions(
  ctx: AppContext,
  viewerId: string,
  q: z.infer<typeof listQuery>,
) {
  const order =
    q.status === 'scheduled'
      ? 's.scheduled_for ASC NULLS LAST'
      : q.status === 'ended'
        ? 's.ended_at DESC'
        : 's.viewer_count DESC, s.started_at DESC';
  const { rows } = await ctx.db.query<LiveRow>(
    `SELECT ${LIVE_COLS} FROM live_sessions s WHERE s.status = $2 AND ${liveVisibleSql('$1::uuid')} AND ($3::uuid IS NULL OR s.host_id = $3)
        AND ($5::timestamptz IS NULL OR s.created_at < $5) ORDER BY ${order} LIMIT $4`,
    [viewerId, q.status, q.hostId ?? null, q.limit, q.before ?? null],
  );
  const hosts = await hostSummary(ctx.db, [...new Set(rows.map((r) => r.host_id))]);
  const held = new Map<string, boolean>();
  for (const r of rows)
    if (r.ticket_type_id)
      held.set(r.id, r.host_id === viewerId || (await ticketHeld(ctx.db, r, viewerId)));
  return {
    items: rows.map((r) =>
      sessionView(r, {
        entitled: held.get(r.id) ?? false,
        team: r.host_id === viewerId,
        host: hosts.get(r.host_id) ?? null,
      }),
    ),
  };
}

/** My sessions as host or team, any status (scheduled first). */
export async function mySessions(ctx: AppContext, userId: string) {
  const { rows } = await ctx.db.query<LiveRow>(
    `SELECT ${LIVE_COLS} FROM live_sessions s WHERE s.host_id = $1 OR EXISTS (SELECT 1 FROM live_participants tp WHERE tp.live_id = s.id AND tp.user_id = $1 AND tp.role IN ('cohost','moderator') AND tp.banned_at IS NULL)
      ORDER BY CASE s.status WHEN 'live' THEN 0 WHEN 'scheduled' THEN 1 ELSE 2 END, COALESCE(s.scheduled_for, s.created_at) DESC LIMIT 100`,
    [userId],
  );
  return { items: rows.map((r) => sessionView(r, { team: true })) };
}

// ------------------------------------------------------------------ staff and maintenance
export async function staffView(ctx: AppContext, id: string) {
  const s = await loadLiveRaw(ctx.db, id);
  if (!s) throw notFound('Live session');
  return sessionView(s, { team: true });
}

export interface LiveMaintenanceResult {
  endedStale: number;
  cancelledNoShow: number;
}
/** Scheduled job (scripts/live-maintenance.ts): ends sessions left running for over 12 h and cancels scheduled sessions never started 24 h after their time. */
export async function runLiveMaintenance(
  ctx: AppContext,
  opts: { now?: Date } = {},
): Promise<LiveMaintenanceResult> {
  const now = opts.now ?? new Date();
  const out: LiveMaintenanceResult = { endedStale: 0, cancelledNoShow: 0 };
  const stale = await ctx.db.query<{ id: string }>(
    `SELECT id FROM live_sessions WHERE status = 'live' AND started_at < $1::timestamptz - interval '12 hours' LIMIT 200`,
    [now],
  );
  for (const r of stale.rows) {
    try {
      await endLive(ctx, r.id, { userId: null, kind: 'system' }, 'timeout');
      out.endedStale += 1;
    } catch (err) {
      if (!(err instanceof AppError))
        ctx.log.error({ err, liveId: r.id }, 'live maintenance failed');
    }
  }
  const c = await ctx.db.query<{ id: string }>(
    `UPDATE live_sessions SET status = 'cancelled', ended_at = $1, end_reason = 'no_show' WHERE status = 'scheduled' AND scheduled_for IS NOT NULL AND scheduled_for < $1::timestamptz - interval '24 hours' RETURNING id`,
    [now],
  );
  for (const r of c.rows) publishLive(ctx, r.id, { type: 'live.ended', reason: 'cancelled' });
  out.cancelledNoShow = c.rows.length;
  return out;
}
