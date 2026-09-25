import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hashToken, SESSION_COOKIE } from '@yapilapi/auth';
import type { UserRole } from '@yapilapi/shared';
import { forbidden, unauthorized } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';

export interface AuthUser {
  id: string;
  sessionId: string;
  role: UserRole;
  email: string;
  emailVerified: boolean;
  birthDate: Date | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}

/** Read the session token from the httpOnly cookie, or a Bearer header (mobile, API clients). */
export function sessionTokenOf(req: FastifyRequest): string | undefined {
  const cookie = req.cookies?.[SESSION_COOKIE];
  if (cookie) return cookie;
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7);
  return undefined;
}

export async function resolveSession(ctx: AppContext, token: string | undefined): Promise<AuthUser | null> {
  if (!token) return null;
  const { rows } = await ctx.db.query<{
    session_id: string;
    user_id: string;
    role: UserRole;
    email: string;
    email_verified_at: Date | null;
    birth_date: Date | null;
    last_seen_at: Date;
  }>(
    `SELECT s.id AS session_id, u.id AS user_id, u.role, u.email, u.email_verified_at, u.birth_date, s.last_seen_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.status = 'active'`,
    [hashToken(token)],
  );
  const r = rows[0];
  if (!r) return null;
  // Touch at most once a minute to avoid a write per request.
  if (Date.now() - r.last_seen_at.getTime() > 60_000)
    void ctx.db.query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [r.session_id]).catch(() => {});
  return {
    id: r.user_id,
    sessionId: r.session_id,
    role: r.role,
    email: r.email,
    emailVerified: !!r.email_verified_at,
    birthDate: r.birth_date,
  };
}

export function registerAuth(app: FastifyInstance, ctx: AppContext) {
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req) => {
    req.user = await resolveSession(ctx, sessionTokenOf(req));
  });
}

/** preHandler: the request must carry a valid session. */
export async function requireAuth(req: FastifyRequest, _reply: FastifyReply) {
  if (!req.user) throw unauthorized();
}

/** preHandler factory: the user must hold one of the given platform roles (RBAC). */
export function requireRole(...roles: UserRole[]) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!req.user) throw unauthorized();
    if (!roles.includes(req.user.role)) throw forbidden();
  };
}

/** Narrow req.user after requireAuth. */
export function me(req: FastifyRequest): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}
