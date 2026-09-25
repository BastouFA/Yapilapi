import type { FastifyReply, FastifyRequest } from 'fastify';
import { sha256Hex, randomToken } from '@yapilapi/security';
import type { PlatformRole } from '@yapilapi/shared';
import type { AppContext } from './context.js';
import type { AuthContext } from './auth-context.js';

interface SessionRow {
  session_id: string;
  user_id: string;
  mfa_verified: boolean;
  last_seen_at: Date;
  platform_role: PlatformRole;
  age_band: 'teen' | 'adult';
  status: string;
  email_verified_at: Date | null;
}

export function extractToken(
  ctx: AppContext,
  req: FastifyRequest,
): { token: string; via: 'cookie' | 'bearer' } | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const t = header.slice(7).trim();
    if (t) return { token: t, via: 'bearer' };
  }
  const cookie = req.cookies?.[ctx.config.SESSION_COOKIE_NAME];
  return cookie ? { token: cookie, via: 'cookie' } : null;
}

/** Resolve (and memoize per request) the authenticated principal from the session token. */
export async function resolveAuth(
  ctx: AppContext,
  req: FastifyRequest,
): Promise<AuthContext | null> {
  if (req.authContext !== undefined) return req.authContext;
  const found = extractToken(ctx, req);
  if (!found) return (req.authContext = null);

  const { rows } = await ctx.db.query<SessionRow>(
    `SELECT s.id AS session_id, s.user_id, s.mfa_verified, s.last_seen_at,
            u.platform_role, u.age_band, u.status, u.email_verified_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
        AND u.deleted_at IS NULL`,
    [sha256Hex(found.token)],
  );
  const row = rows[0];
  // Suspended / deactivated accounts cannot act; pending_deletion accounts may (to cancel deletion).
  if (!row || ['suspended', 'deactivated', 'deleted'].includes(row.status))
    return (req.authContext = null);

  if (Date.now() - row.last_seen_at.getTime() > 60_000) {
    // Best effort; failure to touch the session must not fail the request.
    void ctx.db
      .query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [row.session_id])
      .catch(() => undefined);
  }
  return (req.authContext = {
    userId: row.user_id,
    sessionId: row.session_id,
    platformRole: row.platform_role,
    ageBand: row.age_band,
    mfaVerified: row.mfa_verified,
    emailVerified: row.email_verified_at !== null,
    via: found.via,
  });
}

export interface CreatedSession {
  token: string;
  sessionId: string;
  expiresAt: Date;
}

export async function createSession(
  ctx: AppContext,
  opts: {
    userId: string;
    mfaVerified: boolean;
    ip: string | null;
    userAgent: string | null;
    deviceId?: string | null;
  },
): Promise<CreatedSession> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + ctx.config.SESSION_TTL_DAYS * 86_400_000);
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO sessions (user_id, device_id, token_hash, mfa_verified, ip, user_agent, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [
      opts.userId,
      opts.deviceId ?? null,
      sha256Hex(token),
      opts.mfaVerified,
      opts.ip,
      opts.userAgent?.slice(0, 300) ?? null,
      expiresAt,
    ],
  );
  return { token, sessionId: rows[0]!.id, expiresAt };
}

export function setSessionCookie(
  ctx: AppContext,
  reply: FastifyReply,
  token: string,
  expiresAt: Date,
): void {
  void reply.setCookie(ctx.config.SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: ctx.config.COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
}

export function clearSessionCookie(ctx: AppContext, reply: FastifyReply): void {
  void reply.clearCookie(ctx.config.SESSION_COOKIE_NAME, { path: '/' });
}
