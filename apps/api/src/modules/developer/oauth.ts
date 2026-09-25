import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { randomToken, safeEqual, sha256Hex } from '@yapilapi/security';
import { notFound } from '@yapilapi/shared';
import { withTransaction, type Queryable } from '@yapilapi/database';
import type { AppContext } from '../../lib/context.js';
import { audit } from '../../lib/audit.js';
import { emitAppEvent } from './webhooks.js';

/**
 * OAuth 2.0 authorization-code flow with mandatory PKCE (S256 only; "plain" is not supported) for every client,
 * confidential or public. Secrets, codes and tokens are only ever stored as SHA-256 hashes.
 */

// ------------------------------------------------------------------ scopes

export const OAUTH_SCOPES = {
  'profile:read': 'See your public profile: username, display name, avatar and bio.',
  'posts:read': 'Read your public posts.',
} as const;
export type OAuthScope = keyof typeof OAUTH_SCOPES;
export const isOAuthScope = (s: string): s is OAuthScope => Object.hasOwn(OAUTH_SCOPES, s);

/** Parse an RFC 6749 space-delimited scope string. Returns null when empty or containing unknown scopes. */
export function parseScopes(raw: string | undefined): OAuthScope[] | null {
  const parts = [...new Set((raw ?? '').split(/\s+/).filter(Boolean))];
  if (parts.length === 0 || !parts.every(isOAuthScope)) return null;
  return parts;
}

// ------------------------------------------------------------------ PKCE (pure)

export const CODE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
export const CODE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

export const pkceChallengeFromVerifier = (verifier: string): string =>
  createHash('sha256').update(verifier).digest('base64url');

export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!CODE_VERIFIER_RE.test(verifier) || !CODE_CHALLENGE_RE.test(challenge)) return false;
  return safeEqual(pkceChallengeFromVerifier(verifier), challenge);
}

// ------------------------------------------------------------------ redirect URIs (pure)

/** Registered redirect URIs: https, or http on a loopback host (development). No fragments, no credentials, no wildcards. */
export function validateRedirectUri(raw: string): boolean {
  if (raw.length > 2000 || raw.includes('*')) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.username || u.password || u.hash) return false;
  if (u.protocol === 'https:') return true;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  return u.protocol === 'http:' && (host === 'localhost' || host === '127.0.0.1' || host === '::1');
}

// ------------------------------------------------------------------ clients

export interface OAuthClient {
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  clientId: string;
  confidential: boolean;
  redirectUris: string[];
  homepageUrl: string | null;
  privacyUrl: string | null;
  secretHash: string | null;
  status: 'active' | 'suspended';
}

export async function findClient(ctx: AppContext, clientId: string): Promise<OAuthClient | null> {
  const { rows } = await ctx.db.query(
    `SELECT id, owner_id, name, description, client_id, confidential, redirect_uris, homepage_url, privacy_url, client_secret_hash, status
       FROM developer_apps WHERE client_id = $1`,
    [clientId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    ownerId: r.owner_id,
    name: r.name,
    description: r.description,
    clientId: r.client_id,
    confidential: r.confidential,
    redirectUris: r.redirect_uris,
    homepageUrl: r.homepage_url,
    privacyUrl: r.privacy_url,
    secretHash: r.client_secret_hash,
    status: r.status,
  };
}

export const ACCESS_TTL_SEC = 3600;
export const REFRESH_TTL_SEC = 30 * 86_400;
export const CODE_TTL_SEC = 600;

export const tokenPrefixes = {
  access: 'ylat_',
  refresh: 'ylrt_',
  secret: 'ylcs_',
  key: 'ylk_',
} as const;

// ------------------------------------------------------------------ authorization

export interface AuthorizationRequest {
  clientId: string;
  redirectUri: string;
  scopes: OAuthScope[];
  state?: string;
  codeChallenge: string;
}

/** Issue a single-use authorization code for a user who approved the consent screen. */
export async function issueAuthorizationCode(
  ctx: AppContext,
  client: OAuthClient,
  userId: string,
  r: AuthorizationRequest,
): Promise<string> {
  const code = randomToken(32);
  await ctx.db.query(
    `INSERT INTO oauth_authorization_codes (code_hash, app_id, user_id, redirect_uri, scopes, code_challenge, code_challenge_method, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,'S256', now() + make_interval(secs => $7))`,
    [sha256Hex(code), client.id, userId, r.redirectUri, r.scopes, r.codeChallenge, CODE_TTL_SEC],
  );
  return code;
}

// ------------------------------------------------------------------ token endpoint

export class OAuthError extends Error {
  constructor(
    readonly error:
      | 'invalid_request'
      | 'invalid_client'
      | 'invalid_grant'
      | 'unauthorized_client'
      | 'unsupported_grant_type'
      | 'invalid_scope',
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/** Authenticate the calling client. Confidential clients must present their secret; public clients rely on PKCE. */
export async function authenticateClient(
  ctx: AppContext,
  clientId: string | undefined,
  clientSecret: string | undefined,
): Promise<OAuthClient> {
  if (!clientId) throw new OAuthError('invalid_client', 'client_id is required', 401);
  const client = await findClient(ctx, clientId);
  if (!client || client.status !== 'active')
    throw new OAuthError('invalid_client', 'Unknown or disabled client', 401);
  if (client.confidential) {
    if (
      !clientSecret ||
      !client.secretHash ||
      !safeEqual(sha256Hex(clientSecret), client.secretHash)
    ) {
      throw new OAuthError('invalid_client', 'Client authentication failed', 401);
    }
  }
  return client;
}

async function mintTokens(
  ctx: AppContext,
  grantId: string,
  scopes: string[],
  db: Queryable = ctx.db,
): Promise<TokenResponse> {
  const access = `${tokenPrefixes.access}${randomToken(32)}`;
  const refresh = `${tokenPrefixes.refresh}${randomToken(32)}`;
  await db.query(
    `INSERT INTO oauth_tokens (grant_id, access_hash, refresh_hash, scopes, access_expires_at, refresh_expires_at)
     VALUES ($1,$2,$3,$4, now() + make_interval(secs => $5), now() + make_interval(secs => $6))`,
    [grantId, sha256Hex(access), sha256Hex(refresh), scopes, ACCESS_TTL_SEC, REFRESH_TTL_SEC],
  );
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_SEC,
    refresh_token: refresh,
    scope: scopes.join(' '),
  };
}

async function revokeGrantTokens(ctx: AppContext, grantId: string): Promise<void> {
  await ctx.db.query(
    'UPDATE oauth_tokens SET revoked_at = now() WHERE grant_id = $1 AND revoked_at IS NULL',
    [grantId],
  );
}

export async function exchangeAuthorizationCode(
  ctx: AppContext,
  client: OAuthClient,
  p: { code?: string; redirectUri?: string; codeVerifier?: string },
  req?: FastifyRequest,
): Promise<TokenResponse> {
  if (!p.code || !p.redirectUri || !p.codeVerifier)
    throw new OAuthError('invalid_request', 'code, redirect_uri and code_verifier are required');
  const codeHash = sha256Hex(p.code);

  // Atomically consume: a code works exactly once, even under concurrent attempts.
  const { rows } = await ctx.db.query(
    `UPDATE oauth_authorization_codes SET used_at = now()
      WHERE code_hash = $1 AND app_id = $2 AND used_at IS NULL
      RETURNING user_id, redirect_uri, scopes, code_challenge, (expires_at < now()) AS expired`,
    [codeHash, client.id],
  );
  const row = rows[0];
  if (!row) {
    // Replay of an already-used code is a theft signal: kill whatever that code produced.
    const { rows: used } = await ctx.db.query(
      'SELECT user_id FROM oauth_authorization_codes WHERE code_hash = $1 AND app_id = $2',
      [codeHash, client.id],
    );
    if (used[0]) {
      const { rows: g } = await ctx.db.query(
        'SELECT id FROM oauth_grants WHERE app_id = $1 AND user_id = $2',
        [client.id, used[0].user_id],
      );
      if (g[0]) await revokeGrantTokens(ctx, g[0].id);
      await audit(
        ctx,
        {
          actorType: 'system',
          action: 'oauth.code_replay',
          targetType: 'developer_app',
          targetId: client.id,
          metadata: { userId: used[0].user_id },
        },
        req,
      );
    }
    throw new OAuthError(
      'invalid_grant',
      'The authorization code is invalid, expired or already used',
    );
  }
  if (row.expired)
    throw new OAuthError(
      'invalid_grant',
      'The authorization code is invalid, expired or already used',
    );
  if (row.redirect_uri !== p.redirectUri)
    throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization request');
  if (!verifyPkce(p.codeVerifier, row.code_challenge))
    throw new OAuthError('invalid_grant', 'PKCE verification failed');

  const { rows: users } = await ctx.db.query(
    `SELECT 1 FROM users WHERE id = $1 AND status = 'active' AND deleted_at IS NULL AND age_band = 'adult'`,
    [row.user_id],
  );
  if (!users[0])
    throw new OAuthError('invalid_grant', 'The authorizing account can no longer grant access');

  const tokens = await withTransaction(ctx.db, async (tx) => {
    const g = await tx.query(
      `INSERT INTO oauth_grants (app_id, user_id, scopes) VALUES ($1,$2,$3)
       ON CONFLICT (app_id, user_id) DO UPDATE SET scopes = EXCLUDED.scopes, revoked_at = NULL, updated_at = now()
       RETURNING id`,
      [client.id, row.user_id, row.scopes],
    );
    // A fresh authorization replaces older tokens for this app/user pair.
    await tx.query(
      'UPDATE oauth_tokens SET revoked_at = now() WHERE grant_id = $1 AND revoked_at IS NULL',
      [g.rows[0].id],
    );
    return {
      grantId: g.rows[0].id as string,
      ...(await mintTokens(ctx, g.rows[0].id, row.scopes, tx)),
    };
  });
  await audit(
    ctx,
    {
      actorId: row.user_id,
      action: 'oauth.grant.created',
      targetType: 'developer_app',
      targetId: client.id,
      metadata: { scopes: row.scopes, grantId: tokens.grantId },
    },
    req,
  );
  const { grantId: _g, ...response } = tokens;
  return response;
}

export async function refreshTokens(
  ctx: AppContext,
  client: OAuthClient,
  p: { refreshToken?: string; scope?: string },
  req?: FastifyRequest,
): Promise<TokenResponse> {
  if (!p.refreshToken) throw new OAuthError('invalid_request', 'refresh_token is required');
  const { rows } = await ctx.db.query(
    `SELECT t.id, t.grant_id, t.scopes, t.refresh_used_at, t.revoked_at, (t.refresh_expires_at < now()) AS expired, g.user_id, g.revoked_at AS grant_revoked
       FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
      WHERE t.refresh_hash = $1 AND g.app_id = $2`,
    [sha256Hex(p.refreshToken), client.id],
  );
  const t = rows[0];
  if (!t || t.grant_revoked || t.expired)
    throw new OAuthError('invalid_grant', 'The refresh token is invalid or expired');
  if (t.refresh_used_at) {
    // A rotated refresh token came back: someone holds a stolen copy. Revoke everything for this grant.
    await revokeGrantTokens(ctx, t.grant_id);
    await audit(
      ctx,
      {
        actorId: t.user_id,
        actorType: 'system',
        action: 'oauth.refresh_reuse',
        targetType: 'developer_app',
        targetId: client.id,
        metadata: { grantId: t.grant_id },
      },
      req,
    );
    throw new OAuthError('invalid_grant', 'The refresh token is invalid or expired');
  }
  if (t.revoked_at)
    throw new OAuthError('invalid_grant', 'The refresh token is invalid or expired');

  let scopes: string[] = t.scopes;
  if (p.scope) {
    const wanted = parseScopes(p.scope);
    if (!wanted || !wanted.every((s) => scopes.includes(s)))
      throw new OAuthError('invalid_scope', 'Requested scope exceeds the original grant');
    scopes = wanted;
  }
  const { rows: users } = await ctx.db.query(
    `SELECT 1 FROM users WHERE id = $1 AND status = 'active' AND deleted_at IS NULL`,
    [t.user_id],
  );
  if (!users[0])
    throw new OAuthError('invalid_grant', 'The authorizing account can no longer grant access');

  return withTransaction(ctx.db, async (tx) => {
    const used = await tx.query(
      `UPDATE oauth_tokens SET refresh_used_at = now(), revoked_at = now() WHERE id = $1 AND refresh_used_at IS NULL AND revoked_at IS NULL`,
      [t.id],
    );
    if (used.rowCount !== 1)
      throw new OAuthError('invalid_grant', 'The refresh token is invalid or expired');
    return mintTokens(ctx, t.grant_id, scopes, tx);
  });
}

/** RFC 7009: revoking is idempotent and never reveals whether the token existed. */
export async function revokeToken(
  ctx: AppContext,
  client: OAuthClient,
  token: string,
): Promise<void> {
  const h = sha256Hex(token);
  await ctx.db.query(
    `UPDATE oauth_tokens t SET revoked_at = now()
       FROM oauth_grants g
      WHERE g.id = t.grant_id AND g.app_id = $2 AND t.revoked_at IS NULL AND (t.access_hash = $1 OR t.refresh_hash = $1)`,
    [h, client.id],
  );
}

// ------------------------------------------------------------------ token authentication (used by the public API)

export interface AccessTokenPrincipal {
  kind: 'oauth';
  appId: string;
  userId: string;
  grantId: string;
  tokenId: string;
  scopes: string[];
}

export async function authenticateAccessToken(
  ctx: AppContext,
  token: string,
): Promise<AccessTokenPrincipal | null> {
  if (!token.startsWith(tokenPrefixes.access)) return null;
  const { rows } = await ctx.db.query(
    `SELECT t.id, t.scopes, t.grant_id, g.user_id, g.app_id
       FROM oauth_tokens t
       JOIN oauth_grants g ON g.id = t.grant_id AND g.revoked_at IS NULL
       JOIN developer_apps a ON a.id = g.app_id AND a.status = 'active'
       JOIN users u ON u.id = g.user_id AND u.status = 'active' AND u.deleted_at IS NULL AND u.age_band = 'adult'
      WHERE t.access_hash = $1 AND t.revoked_at IS NULL AND t.access_expires_at > now()`,
    [sha256Hex(token)],
  );
  const r = rows[0];
  if (!r) return null;
  void ctx.db
    .query(
      `UPDATE oauth_tokens SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
      [r.id],
    )
    .catch(() => undefined);
  return {
    kind: 'oauth',
    appId: r.app_id,
    userId: r.user_id,
    grantId: r.grant_id,
    tokenId: r.id,
    scopes: r.scopes,
  };
}

// ------------------------------------------------------------------ connected apps (Privacy Center)

export interface ConnectedApp {
  id: string;
  app: {
    id: string;
    name: string;
    description: string | null;
    homepageUrl: string | null;
    privacyUrl: string | null;
    developer: string | null;
  };
  scopes: Array<{ scope: string; description: string }>;
  authorizedAt: string;
  lastUsedAt: string | null;
}

export async function listConnectedApps(ctx: AppContext, userId: string): Promise<ConnectedApp[]> {
  const { rows } = await ctx.db.query(
    `SELECT g.id, g.scopes, g.created_at, a.id AS app_id, a.name, a.description, a.homepage_url, a.privacy_url, p.username AS developer,
            (SELECT max(t.last_used_at) FROM oauth_tokens t WHERE t.grant_id = g.id) AS last_used_at
       FROM oauth_grants g
       JOIN developer_apps a ON a.id = g.app_id
       LEFT JOIN profiles p ON p.user_id = a.owner_id
      WHERE g.user_id = $1 AND g.revoked_at IS NULL
      ORDER BY g.created_at DESC`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    app: {
      id: r.app_id,
      name: r.name,
      description: r.description,
      homepageUrl: r.homepage_url,
      privacyUrl: r.privacy_url,
      developer: r.developer ?? null,
    },
    scopes: (r.scopes as string[]).map((s) => ({
      scope: s,
      description: isOAuthScope(s) ? OAUTH_SCOPES[s] : s,
    })),
    authorizedAt: new Date(r.created_at).toISOString(),
    lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
  }));
}

/** The user withdraws an app's access. Tokens die immediately; the app is told via webhook if it subscribed. */
export async function revokeConnectedApp(
  ctx: AppContext,
  userId: string,
  grantId: string,
  req?: FastifyRequest,
): Promise<void> {
  const { rows } = await ctx.db.query(
    `UPDATE oauth_grants SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING app_id`,
    [grantId, userId],
  );
  if (!rows[0]) throw notFound('Connected app');
  await revokeGrantTokens(ctx, grantId);
  await audit(
    ctx,
    {
      actorId: userId,
      action: 'oauth.grant.revoked',
      targetType: 'developer_app',
      targetId: rows[0].app_id,
      metadata: { grantId },
    },
    req,
  );
  await emitAppEvent(ctx, rows[0].app_id, 'authorization.revoked', { userId }).catch((err) =>
    ctx.log.warn({ err }, 'webhook enqueue failed'),
  );
}

/** Housekeeping: drop expired authorization codes and long-dead tokens. Safe to run repeatedly. */
export async function purgeExpiredOAuth(
  ctx: AppContext,
): Promise<{ codes: number; tokens: number }> {
  const c = await ctx.db.query(
    `DELETE FROM oauth_authorization_codes WHERE expires_at < now() - interval '1 day'`,
  );
  const t = await ctx.db.query(
    `DELETE FROM oauth_tokens WHERE refresh_expires_at < now() - interval '7 days' OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days')`,
  );
  return { codes: c.rowCount ?? 0, tokens: t.rowCount ?? 0 };
}
