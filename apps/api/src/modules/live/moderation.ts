import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { forbidden, invalid } from '@yapilapi/shared';
import type { AppContext } from '../../lib/context.js';
import type { AuthContext } from '../../lib/auth-context.js';
import { audit } from '../../lib/audit.js';
import { assertTextAllowed } from '../../lib/text-guard.js';
import { publishLive } from './events.js';
import { loadAccess, requireCan } from './access.js';
import { roleOf } from './interact.js';
import { outranks } from './rules.js';
import { recountViewers } from './sessions.js';

export const muteBody = z.object({ minutes: z.number().int().min(1).max(1440).default(10) });
export const banBody = z.object({ reason: z.string().trim().min(1).max(200) });

async function target(ctx: AppContext, auth: AuthContext, id: string, userId: string) {
  await ctx.flags.require('LIVE', auth.userId);
  const a = await loadAccess(ctx.db, auth.userId, id);
  requireCan(a, 'moderate');
  if (userId === auth.userId) throw invalid('You cannot moderate yourself');
  const u = await ctx.db.query(`SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL`, [
    userId,
  ]);
  const role = await roleOf(ctx.db, a, userId);
  // A missing user answers like a person who is not there; moderation goes down the ladder only (never the host, never an equal).
  if (!u.rowCount) throw invalid('Unknown user');
  if (!outranks(a.role, role))
    throw forbidden('You cannot moderate someone of equal or higher rank');
  return a;
}

/** Mute: the person stays in the room and can read, but cannot chat or ask until the time is up. */
export async function muteParticipant(
  ctx: AppContext,
  auth: AuthContext,
  id: string,
  userId: string,
  minutes: number,
  req?: FastifyRequest,
): Promise<{ mutedUntil: string }> {
  await target(ctx, auth, id, userId);
  const { rows } = await ctx.db.query<{ muted_until: Date }>(
    `INSERT INTO live_participants (live_id, user_id, role, left_at, muted_until, acted_by) VALUES ($1,$2,'audience', now(), now() + make_interval(mins => $3), $4)
     ON CONFLICT (live_id, user_id) DO UPDATE SET muted_until = EXCLUDED.muted_until, acted_by = EXCLUDED.acted_by RETURNING muted_until`,
    [id, userId, minutes, auth.userId],
  );
  await audit(
    ctx,
    {
      actorId: auth.userId,
      action: 'live.participant_muted',
      targetType: 'live_session',
      targetId: id,
      metadata: { userId, minutes },
    },
    req,
  );
  publishLive(ctx, id, {
    type: 'participant.muted',
    userId,
    until: rows[0]!.muted_until.toISOString(),
  });
  return { mutedUntil: rows[0]!.muted_until.toISOString() };
}

export async function unmuteParticipant(
  ctx: AppContext,
  auth: AuthContext,
  id: string,
  userId: string,
  req?: FastifyRequest,
): Promise<void> {
  await target(ctx, auth, id, userId);
  await ctx.db.query(
    'UPDATE live_participants SET muted_until = NULL, acted_by = $3 WHERE live_id = $1 AND user_id = $2',
    [id, userId, auth.userId],
  );
  await audit(
    ctx,
    {
      actorId: auth.userId,
      action: 'live.participant_unmuted',
      targetType: 'live_session',
      targetId: id,
      metadata: { userId },
    },
    req,
  );
  publishLive(ctx, id, { type: 'participant.muted', userId, until: null });
}

/** Ban: removed from the room and from view (the session answers 404 for them), their chat is hidden, and they cannot rejoin until lifted. */
export async function banParticipant(
  ctx: AppContext,
  auth: AuthContext,
  id: string,
  userId: string,
  reason: string,
  req?: FastifyRequest,
): Promise<void> {
  assertTextAllowed(reason);
  await target(ctx, auth, id, userId);
  await ctx.db.query(
    `INSERT INTO live_participants (live_id, user_id, role, left_at, banned_at, ban_reason, acted_by) VALUES ($1,$2,'audience', now(), now(), $3, $4)
     ON CONFLICT (live_id, user_id) DO UPDATE SET role = 'audience', left_at = COALESCE(live_participants.left_at, now()), banned_at = now(), ban_reason = EXCLUDED.ban_reason, acted_by = EXCLUDED.acted_by`,
    [id, userId, reason, auth.userId],
  );
  await ctx.db.query(
    'UPDATE live_messages SET hidden_at = now(), hidden_by = $3 WHERE live_id = $1 AND user_id = $2 AND hidden_at IS NULL',
    [id, userId, auth.userId],
  );
  await recountViewers(ctx, id);
  await audit(
    ctx,
    {
      actorId: auth.userId,
      action: 'live.participant_banned',
      targetType: 'live_session',
      targetId: id,
      metadata: { userId, reason },
    },
    req,
  );
  publishLive(ctx, id, { type: 'participant.banned', userId });
}

export async function unbanParticipant(
  ctx: AppContext,
  auth: AuthContext,
  id: string,
  userId: string,
  req?: FastifyRequest,
): Promise<void> {
  await target(ctx, auth, id, userId);
  await ctx.db.query(
    'UPDATE live_participants SET banned_at = NULL, ban_reason = NULL, acted_by = $3 WHERE live_id = $1 AND user_id = $2',
    [id, userId, auth.userId],
  );
  await audit(
    ctx,
    {
      actorId: auth.userId,
      action: 'live.participant_unbanned',
      targetType: 'live_session',
      targetId: id,
      metadata: { userId },
    },
    req,
  );
}

export async function listModerated(ctx: AppContext, auth: AuthContext, id: string) {
  await ctx.flags.require('LIVE', auth.userId);
  const a = await loadAccess(ctx.db, auth.userId, id);
  requireCan(a, 'moderate');
  const { rows } = await ctx.db.query<{
    user_id: string;
    username: string;
    muted_until: Date | null;
    banned_at: Date | null;
    ban_reason: string | null;
  }>(
    `SELECT lp.user_id, p.username::text, lp.muted_until, lp.banned_at, lp.ban_reason FROM live_participants lp JOIN profiles p ON p.user_id = lp.user_id
      WHERE lp.live_id = $1 AND (lp.banned_at IS NOT NULL OR lp.muted_until > now()) ORDER BY lp.joined_at`,
    [id],
  );
  return {
    items: rows.map((r) => ({
      userId: r.user_id,
      username: r.username,
      mutedUntil: r.muted_until && r.muted_until > new Date() ? r.muted_until.toISOString() : null,
      banned: Boolean(r.banned_at),
      banReason: r.ban_reason,
    })),
  };
}
