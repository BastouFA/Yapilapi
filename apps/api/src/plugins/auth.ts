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
  /** Set when the request authenticated with a developer API key instead of a session. */
  apiKey?: { id: string; appId: string; scopes: string[] };
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

/** Developer API keys look like ypl_<8 hex>_<secret>. */
async function resolveApiKey(ctx: AppContext, key: string): Promise<AuthUser | null> {
  const { rows } = await ctx.db.query(
    `SELECT k.id, k.app_id, k.scopes, k.last_used_at, u.id AS user_id, u.email, u.email_verified_at, u.birth_date
     FROM api_keys k JOIN users u ON u.id = k.owner_id JOIN developer_apps a ON a.id = k.app_id
     WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now())
       AND a.deleted_at IS NULL AND u.status = 'active'`,
    [hashToken(key)],
  );
  const r = rows[0];
  if (!r) return null;
  if (!r.last_used_at || Date.now() - r.last_used_at.getTime() > 60_000)
    void ctx.db.query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [r.id]).catch(() => {});
  // Keys never carry platform roles, whatever their owner's role is.
  return {
    id: r.user_id,
    sessionId: '',
    role: 'user',
    email: r.email,
    emailVerified: !!r.email_verified_at,
    birthDate: r.birth_date,
    apiKey: { id: r.id, appId: r.app_id, scopes: r.scopes },
  };
}

/** Routes an API key can never reach: account security, keys themselves, data export, deletion, money out, admin. */
const KEY_BLOCKED = [
  /^\/v1\/auth\//,
  /^\/v1\/developer\//,
  /^\/v1\/admin\//,
  /^\/v1\/me\/export$/,
  /^\/v1\/me\/payouts/,
  /^\/v1\/me\/consents$/,
  /^\/v1\/ai\/memories/,
];

/** OAuth access tokens (ypo_…) act like API keys granted by the user to an app. */
async function resolveOAuth(ctx: AppContext, token: string): Promise<AuthUser | null> {
  const { rows } = await ctx.db.query(
    `SELECT g.id, g.app_id, g.scopes, g.last_used_at, u.id AS user_id, u.email, u.email_verified_at, u.birth_date
     FROM oauth_grants g JOIN users u ON u.id = g.user_id JOIN developer_apps a ON a.id = g.app_id
     WHERE g.access_hash = $1 AND g.revoked_at IS NULL AND g.access_expires_at > now() AND a.deleted_at IS NULL AND u.status = 'active'`,
    [hashToken(token)],
  );
  const r = rows[0];
  if (!r) return null;
  if (!r.last_used_at || Date.now() - r.last_used_at.getTime() > 60_000)
    void ctx.db.query(`UPDATE oauth_grants SET last_used_at = now() WHERE id = $1`, [r.id]).catch(() => {});
  return {
    id: r.user_id,
    sessionId: '',
    role: 'user',
    email: r.email,
    emailVerified: !!r.email_verified_at,
    birthDate: r.birth_date,
    apiKey: { id: r.id, appId: r.app_id, scopes: r.scopes },
  };
}

export async function resolveSession(ctx: AppContext, token: string | undefined): Promise<AuthUser | null> {
  if (!token) return null;
  if (token.startsWith('ypo_')) return resolveOAuth(ctx, token);
  if (/^ypl_[0-9a-f]{8}_/.test(token)) return resolveApiKey(ctx, token);
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
    const key = req.user?.apiKey;
    if (!key) return;
    const path = req.url.split('?')[0]!;
    if (KEY_BLOCKED.some((r) => r.test(path)) || (req.method === 'DELETE' && path === '/v1/me'))
      throw forbidden('API keys cannot use this endpoint. Sign in to the app instead.');
    const needs = req.method === 'GET' || req.method === 'HEAD' ? 'read' : 'write';
    if (!key.scopes.includes(needs)) throw forbidden(`This API key needs the "${needs}" scope.`);
  });
}

/** preHandler: the request must carry a valid session. */
export async function requireAuth(req: FastifyRequest, _reply: FastifyReply) {
  if (!req.user) throw unauthorized();
}

/** preHandler factory: the user must hold one of the given platform roles (RBAC). */
export function requireRole(...roles: UserRole[]) {
  const handler = async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!req.user) throw unauthorized();
    if (!roles.includes(req.user.role)) throw forbidden();
  };
  // Lets tooling (docs generator) see which roles a route requires.
  return Object.assign(handler, { roles });
}

/** Narrow req.user after requireAuth. */
export function me(req: FastifyRequest): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}
