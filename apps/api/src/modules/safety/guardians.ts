import { withTransaction } from '@yapilapi/database';
import { AppError, conflict, forbidden, invalid, notFound } from '@yapilapi/shared';
import type { AppContext } from '../../lib/context.js';
import type { AuthContext } from '../../lib/auth-context.js';
import { audit } from '../../lib/audit.js';
import { notify } from '../../lib/notify.js';
import { isBlockedEitherWay } from '../../lib/users.js';

/**
 * Guardian links for minor safety.
 *  - A TEEN invites an adult guardian by username; the guardian accepts (or the teen/guardian revokes at any time).
 *  - An active guardian may see the teen's SAFETY SETTINGS and an ENFORCEMENT SUMMARY. A guardian can never read the
 *    teen's messages, posts, contacts or any other content: the summary query only selects the columns listed below.
 */

export const MAX_GUARDIANS = 3;

export async function inviteGuardian(
  ctx: AppContext,
  auth: AuthContext,
  guardianUsername: string,
  req: Parameters<typeof audit>[2],
): Promise<{ guardianId: string; status: 'pending' }> {
  if (auth.ageBand !== 'teen') throw forbidden('Only teen accounts invite guardians');
  const g = await ctx.db.query<{ user_id: string; age_band: string; status: string }>(
    `SELECT p.user_id, u.age_band, u.status FROM profiles p JOIN users u ON u.id = p.user_id WHERE p.username = $1 AND u.deleted_at IS NULL`,
    [guardianUsername.toLowerCase()],
  );
  const guardian = g.rows[0];
  if (
    !guardian ||
    guardian.status !== 'active' ||
    (await isBlockedEitherWay(ctx.db, auth.userId, guardian.user_id))
  )
    throw notFound('User');
  if (guardian.user_id === auth.userId) throw invalid('You cannot be your own guardian');
  if (guardian.age_band !== 'adult') throw invalid('A guardian must be an adult account');
  await withTransaction(ctx.db, async (tx) => {
    const n = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM guardian_links WHERE minor_id = $1 AND status IN ('pending','active')`,
      [auth.userId],
    );
    if (n.rows[0]!.n >= MAX_GUARDIANS)
      throw new AppError('unprocessable', `You can have at most ${MAX_GUARDIANS} guardians`);
    const ins = await tx.query(
      `INSERT INTO guardian_links (minor_id, guardian_id, status, invited_by) VALUES ($1,$2,'pending',$1)
       ON CONFLICT (minor_id, guardian_id) DO UPDATE SET status = 'pending', invited_by = $1, revoked_at = NULL, accepted_at = NULL WHERE guardian_links.status = 'revoked'
       RETURNING 1`,
      [auth.userId, guardian.user_id],
    );
    if (!ins.rowCount) throw conflict('This guardian is already linked or invited');
    await audit(
      ctx,
      {
        actorId: auth.userId,
        action: 'guardian.invited',
        targetType: 'user',
        targetId: guardian.user_id,
      },
      req,
      tx,
    );
  });
  await notify(ctx, {
    userId: guardian.user_id,
    kind: 'guardian_invitation',
    actorId: auth.userId,
    targetType: 'user',
    targetId: auth.userId,
  });
  return { guardianId: guardian.user_id, status: 'pending' };
}

export async function acceptGuardianship(
  ctx: AppContext,
  auth: AuthContext,
  minorId: string,
  req: Parameters<typeof audit>[2],
): Promise<void> {
  if (auth.ageBand !== 'adult') throw forbidden('Only adults can be guardians');
  const r = await ctx.db.query(
    `UPDATE guardian_links SET status = 'active', accepted_at = now() WHERE minor_id = $1 AND guardian_id = $2 AND status = 'pending' RETURNING 1`,
    [minorId, auth.userId],
  );
  if (!r.rowCount) throw notFound('Invitation');
  await audit(
    ctx,
    { actorId: auth.userId, action: 'guardian.accepted', targetType: 'user', targetId: minorId },
    req,
  );
  await notify(ctx, {
    userId: minorId,
    kind: 'guardian_accepted',
    actorId: auth.userId,
    targetType: 'user',
    targetId: auth.userId,
  });
}

/** Either side can end a link (or decline a pending invitation). */
export async function revokeGuardianLink(
  ctx: AppContext,
  auth: AuthContext,
  otherUserId: string,
  req: Parameters<typeof audit>[2],
): Promise<void> {
  const r = await ctx.db.query<{ minor_id: string; guardian_id: string }>(
    `UPDATE guardian_links SET status = 'revoked', revoked_at = now()
      WHERE status IN ('pending','active') AND ((minor_id = $1 AND guardian_id = $2) OR (minor_id = $2 AND guardian_id = $1)) RETURNING minor_id, guardian_id`,
    [auth.userId, otherUserId],
  );
  if (!r.rowCount) throw notFound('Guardian link');
  await audit(
    ctx,
    { actorId: auth.userId, action: 'guardian.revoked', targetType: 'user', targetId: otherUserId },
    req,
  );
  await notify(ctx, {
    userId: otherUserId,
    kind: 'guardian_revoked',
    actorId: auth.userId,
    targetType: 'user',
    targetId: auth.userId,
  });
}

export async function listGuardianLinks(ctx: AppContext, userId: string) {
  const { rows } = await ctx.db.query(
    `SELECT gl.minor_id, gl.guardian_id, gl.status, gl.created_at, gl.accepted_at,
            mp.username AS minor_username, mp.display_name AS minor_name, gp.username AS guardian_username, gp.display_name AS guardian_name
       FROM guardian_links gl JOIN profiles mp ON mp.user_id = gl.minor_id JOIN profiles gp ON gp.user_id = gl.guardian_id
      WHERE (gl.minor_id = $1 OR gl.guardian_id = $1) AND gl.status IN ('pending','active') ORDER BY gl.created_at`,
    [userId],
  );
  const card = (id: string, username: string, name: string) => ({
    id,
    username,
    displayName: name,
  });
  return {
    asMinor: rows
      .filter((r) => r.minor_id === userId)
      .map((r) => ({
        guardian: card(r.guardian_id, r.guardian_username, r.guardian_name),
        status: r.status,
        since: r.accepted_at?.toISOString() ?? null,
      })),
    asGuardian: rows
      .filter((r) => r.guardian_id === userId)
      .map((r) => ({
        minor: card(r.minor_id, r.minor_username, r.minor_name),
        status: r.status,
        since: r.accepted_at?.toISOString() ?? null,
      })),
  };
}

/** What a guardian may see. Never message content; never posts; never who the teen talks to. */
export async function guardianSummary(ctx: AppContext, guardianId: string, minorId: string) {
  const link = await ctx.db.query(
    `SELECT 1 FROM guardian_links WHERE minor_id = $1 AND guardian_id = $2 AND status = 'active'`,
    [minorId, guardianId],
  );
  if (!link.rowCount) throw notFound('Teen');
  const [settings, enf] = await Promise.all([
    ctx.db.query(
      `SELECT up.who_can_message, up.discoverable, up.default_post_visibility, up.sensitive_content, up.daily_limit_minutes, up.quiet_hours_start, up.quiet_hours_end,
              p.is_private, (SELECT count(*)::int FROM user_blocks b WHERE b.blocker_id = $1) AS blocked_accounts
         FROM profiles p LEFT JOIN user_preferences up ON up.user_id = p.user_id WHERE p.user_id = $1`,
      [minorId],
    ),
    ctx.db.query(
      `SELECT kind, count(*)::int AS n, max(starts_at) AS last_at, bool_or(revoked_at IS NULL AND (ends_at IS NULL OR ends_at > now())) AS active
         FROM enforcements WHERE user_id = $1 AND starts_at > now() - interval '180 days' GROUP BY kind`,
      [minorId],
    ),
  ]);
  const s = settings.rows[0] ?? {};
  return {
    minorId,
    settings: {
      whoCanMessage: s.who_can_message ?? 'friends',
      discoverable: s.discoverable ?? false,
      defaultPostVisibility: s.default_post_visibility ?? 'followers',
      sensitiveContent: s.sensitive_content ?? 'hide',
      dailyLimitMinutes: s.daily_limit_minutes ?? null,
      quietHours:
        s.quiet_hours_start != null ? { start: s.quiet_hours_start, end: s.quiet_hours_end } : null,
      privateAccount: s.is_private ?? true,
      blockedAccounts: s.blocked_accounts ?? 0,
    },
    enforcementSummary: {
      windowDays: 180,
      byKind: Object.fromEntries(
        enf.rows.map((r) => [
          r.kind,
          { count: r.n, lastAt: r.last_at.toISOString(), active: r.active },
        ]),
      ),
    },
    notIncluded: ['messages', 'posts', 'comments', 'contacts', 'media'],
  };
}
