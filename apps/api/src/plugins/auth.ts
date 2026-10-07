import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ACCOUNTS_COOKIE, hashToken, SESSION_COOKIE } from '@yapilapi/auth';
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
  /** The person's language setting (profiles.locale); errors are sent in it. Not set for API keys. */
  locale?: string;
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

/**
 * A browser request signed in by the session cookie that comes from a page on another origin
 * (its Origin header isn't one of WEB_ORIGIN). SameSite=Lax keeps the cookie off requests from
 * other sites, but not from other origins of the same site (another port or subdomain), so the
 * server checks as well. Requests without an Origin (the web app's own server, the phone, tools)
 * and requests that send the token themselves (Bearer) aren't affected.
 */
export function crossOriginCookieRequest(req: FastifyRequest, allowedOrigins: string[]): boolean {
  // The other accounts signed in on this browser count too: they can be switched to.
  if (!req.cookies?.[SESSION_COOKIE] && !req.cookies?.[ACCOUNTS_COOKIE]) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return false;
  return !allowedOrigins.includes(origin.replace(/\/+$/, ''));
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

/**
 * Routes an API key can never reach: account security, keys themselves, data export, deletion, money
 * out, admin. Also what identifies the account or protects it (email and phone, username, date of
 * birth, sign-in alerts, the privacy center, apps allowed in, family supervision): a key that leaks
 * must not be able to take the account over, hide a sign-in or put someone in charge of a teen.
 */
const KEY_BLOCKED = [
  /^\/v1\/auth\//,
  /^\/v1\/developer\//,
  /^\/v1\/admin\//,
  /^\/v1\/oauth\//,
  /^\/v1\/family(\/|$)/,
  /^\/v1\/me\/export$/,
  /^\/v1\/me\/payouts/,
  /^\/v1\/me\/consents$/,
  /^\/v1\/me\/privacy$/,
  /^\/v1\/me\/account$/,
  /^\/v1\/me\/verification$/,
  /^\/v1\/me\/phone(\/|$)/,
  /^\/v1\/me\/username$/,
  /^\/v1\/me\/birth-date$/,
  /^\/v1\/me\/sign-in-alerts$/,
  /^\/v1\/me\/connected-apps/,
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
    locale: string | null;
  }>(
    `SELECT s.id AS session_id, u.id AS user_id, u.role, u.email, u.email_verified_at, u.birth_date, s.last_seen_at, p.locale
     FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN profiles p ON p.user_id = u.id
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
    locale: r.locale ?? undefined,
  };
}

export function registerAuth(app: FastifyInstance, ctx: AppContext) {
  app.decorateRequest('user', null);
  const origins = ctx.config.WEB_ORIGIN.split(',').map((o) => o.trim().replace(/\/+$/, ''));
  app.addHook('onRequest', async (req) => {
    // Changes made with the session cookie must come from the web app's own pages.
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS' && crossOriginCookieRequest(req, origins)) throw forbidden();
    req.user = await resolveSession(ctx, sessionTokenOf(req));
    const key = req.user?.apiKey;
    if (!key) return;
    // Checked against the route that will run (its pattern) as well as the path as sent, decoded: the
    // router decodes the path, so "/v1/me/%65xport" reaches the export and must be refused like it.
    const raw = req.url.split('?')[0]!;
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      // A path that doesn't decode is checked as sent.
    }
    const paths = [raw, decoded, req.routeOptions.url].filter((p): p is string => !!p);
    if (paths.some((p) => KEY_BLOCKED.some((r) => r.test(p)) || (req.method === 'DELETE' && p === '/v1/me')))
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
