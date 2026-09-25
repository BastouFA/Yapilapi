import type { Queryable } from '@yapilapi/database';
import { RESERVED_USERNAMES } from '@yapilapi/shared';
import {
  checkImpersonation,
  type ImpersonationResult,
  type ProtectedIdentity,
} from '@yapilapi/moderation';
import type { AppContext } from '../../lib/context.js';

/**
 * Impersonation screening against identities that deserve protection: verified businesses, verified creators, staff and
 * reserved brand terms. The similarity logic is pure and unit tested (packages/moderation/src/impersonation.ts); this
 * file only gathers the protected set from the database.
 *
 * `screenProfileIdentity` is designed to be called by the profile/registration flows after a username or display-name
 * change. It only ever OPENS A REVIEW CASE (never blocks or renames), so a false positive costs a moderator a minute
 * rather than locking out a real person.
 */

export async function loadProtectedIdentities(db: Queryable): Promise<ProtectedIdentity[]> {
  const [biz, staff, creators] = await Promise.all([
    db.query<{ id: string; slug: string; name: string }>(
      `SELECT id, slug::text AS slug, name FROM businesses WHERE verified_at IS NOT NULL AND deleted_at IS NULL LIMIT 5000`,
    ),
    db.query<{ id: string; username: string; display_name: string }>(
      `SELECT u.id, p.username::text AS username, p.display_name FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.platform_role <> 'user' AND u.status = 'active' LIMIT 2000`,
    ),
    db.query<{ id: string; username: string; display_name: string }>(
      `SELECT c.user_id AS id, p.username::text AS username, p.display_name FROM creators c JOIN profiles p ON p.user_id = c.user_id WHERE c.kyc_status = 'verified' AND c.status = 'active' LIMIT 5000`,
    ),
  ]);
  const out: ProtectedIdentity[] = [];
  for (const b of biz.rows)
    out.push({ id: b.id, kind: 'business', username: b.slug, displayName: b.name });
  for (const s of staff.rows)
    out.push({ id: s.id, kind: 'staff', username: s.username, displayName: s.display_name });
  for (const c of creators.rows)
    out.push({ id: c.id, kind: 'creator', username: c.username, displayName: c.display_name });
  for (const name of RESERVED_USERNAMES)
    out.push({ id: `reserved:${name}`, kind: 'reserved', username: name });
  return out;
}

export async function checkIdentity(
  ctx: AppContext,
  candidate: { username?: string | null; displayName?: string | null },
  excludeId?: string,
): Promise<ImpersonationResult> {
  const protectedIds = await loadProtectedIdentities(ctx.db);
  return checkImpersonation(
    candidate,
    protectedIds,
    excludeId ? { exclude: new Set([excludeId]) } : {},
  );
}

/** Open (or reuse) an automated review case when a profile's identity is a high-risk lookalike of a protected one. */
export async function screenProfileIdentity(
  ctx: AppContext,
  userId: string,
): Promise<{ risk: ImpersonationResult['risk']; caseId: string | null }> {
  const p = await ctx.db.query<{ username: string; display_name: string }>(
    'SELECT username::text AS username, display_name FROM profiles WHERE user_id = $1',
    [userId],
  );
  if (!p.rows[0]) return { risk: 'none', caseId: null };
  const res = await checkIdentity(
    ctx,
    { username: p.rows[0].username, displayName: p.rows[0].display_name },
    userId,
  );
  if (res.risk !== 'high') return { risk: res.risk, caseId: null };
  const open = await ctx.db.query<{ id: string }>(
    `SELECT id FROM moderation_cases WHERE target_type = 'user' AND target_id = $1 AND state <> 'resolved' AND 'impersonation' = ANY(categories) LIMIT 1`,
    [userId],
  );
  if (open.rows[0]) return { risk: res.risk, caseId: open.rows[0].id };
  const c = await ctx.db.query<{ id: string }>(
    `INSERT INTO moderation_cases (target_type, target_id, subject_user_id, source, risk_level, categories, signals, state, content_snapshot)
     VALUES ('user',$1,$1,'automated','medium','{impersonation}',$2,'review',$3) RETURNING id`,
    [
      userId,
      JSON.stringify({ impersonation: res }),
      JSON.stringify({ username: p.rows[0].username, displayName: p.rows[0].display_name }),
    ],
  );
  return { risk: res.risk, caseId: c.rows[0]!.id };
}
