import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AppError,
  clampLimit,
  decodeCursor,
  encodeCursor,
  forbidden,
  notFound,
} from '@yapilapi/shared';
import { sha256Hex } from '@yapilapi/security';
import { route } from '../../lib/route.js';
import type { AppContext } from '../../lib/context.js';
import { postVisibleSql } from '../../lib/visibility.js';
import { authenticateAccessToken, tokenPrefixes, type AccessTokenPrincipal } from './oauth.js';
import type { DbRow } from '../../lib/db-row.js';

/**
 * Public API (`/v1/public/*`), consumed with either
 *   - an API key (`Authorization: Bearer ylk_...`): read-only access to PUBLIC data, or
 *   - an OAuth access token (`Bearer ylat_...`): the same plus the authorising user's own data within granted scopes.
 *
 * Data policy: only public profiles/posts of adult, active, non-private accounts are ever returned. Teen accounts and
 * private accounts are invisible here (404), whatever the credential. Session cookies are never accepted on these routes.
 */

export interface KeyPrincipal {
  kind: 'key';
  appId: string;
  keyId: string;
  scopes: string[];
}
export type PublicPrincipal = KeyPrincipal | AccessTokenPrincipal;

function unauthorized(
  reply: { header: (k: string, v: string) => unknown },
  message: string,
): never {
  reply.header('www-authenticate', 'Bearer realm="yapilapi"');
  throw new AppError('unauthenticated', message);
}

const OAUTH_LIMIT_PER_MIN = 300;

export async function authenticatePublicApi(
  ctx: AppContext,
  req: FastifyRequest,
  reply: { header: (k: string, v: string) => unknown },
): Promise<PublicPrincipal> {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) unauthorized(reply, 'An API key or access token is required');

  let principal: PublicPrincipal | null = null;
  let limit = OAUTH_LIMIT_PER_MIN;
  let bucket = '';

  if (token.startsWith(tokenPrefixes.key)) {
    const { rows } = await ctx.db.query(
      `SELECT k.id, k.app_id, k.scopes, k.rate_limit_per_min
         FROM api_keys k JOIN developer_apps a ON a.id = k.app_id AND a.status = 'active'
        WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now())`,
      [sha256Hex(token)],
    );
    const r = rows[0];
    if (r) {
      principal = { kind: 'key', appId: r.app_id, keyId: r.id, scopes: r.scopes };
      limit = r.rate_limit_per_min;
      bucket = `key:${r.id}`;
      void ctx.db
        .query(
          `UPDATE api_keys SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
          [r.id],
        )
        .catch(() => undefined);
    }
  } else if (token.startsWith(tokenPrefixes.access)) {
    const p = await authenticateAccessToken(ctx, token);
    if (p) {
      principal = p;
      bucket = `grant:${p.grantId}`;
    }
  }
  if (!principal) unauthorized(reply, 'Invalid, expired or revoked credentials');

  // Per-credential rate limit; always enforced (it is part of the key's contract, not an operational toggle).
  const rl = await ctx.limiter.hit(`publicapi:${bucket}`, limit, 60);
  reply.header('x-ratelimit-limit', String(limit));
  reply.header('x-ratelimit-remaining', String(rl.remaining));
  if (!rl.allowed) {
    reply.header('retry-after', String(rl.retryAfterSec));
    throw new AppError('rate_limited', 'API rate limit exceeded', {
      retryAfterSec: rl.retryAfterSec,
    });
  }
  return principal!;
}

const requireScope = (p: PublicPrincipal, scope: string) => {
  if (!p.scopes.includes(scope)) throw forbidden(`This credential lacks the ${scope} scope`);
};
const requireOAuth = (p: PublicPrincipal): AccessTokenPrincipal => {
  if (p.kind !== 'oauth') throw forbidden('This endpoint requires a user access token');
  return p;
};

const profileView = (r: DbRow) => ({
  id: r.user_id,
  username: r.username,
  displayName: r.display_name,
  bio: r.bio,
  avatarUrl: r.avatar_url,
  mode: r.mode,
  followerCount: r.follower_count,
  createdAt: r.created_at,
});

const PROFILE_COLS = `p.user_id, p.username, p.display_name, p.bio, p.avatar_url, p.mode, p.follower_count, p.created_at`;
/** Profiles the public API may show: adult, active, not private. */
const PUBLIC_PROFILE = `u.age_band = 'adult' AND u.status = 'active' AND u.deleted_at IS NULL AND NOT p.is_private`;

async function publicPosts(
  ctx: AppContext,
  authorId: string,
  q: { cursor?: string; limit?: number },
) {
  const limit = clampLimit(q.limit);
  const cur = decodeCursor<{ t: string; id: string }>(q.cursor);
  const { rows } = await ctx.db.query(
    `SELECT p.id, p.kind, p.body, p.language, p.like_count, p.comment_count, p.created_at, p.created_at::text AS created_raw
       FROM posts p
      WHERE p.author_id = $1 AND p.visibility = 'public' AND p.community_id IS NULL AND ${postVisibleSql('NULL::uuid')}
        AND ($2::timestamptz IS NULL OR (p.created_at, p.id) < ($2::timestamptz, $3::uuid))
      ORDER BY p.created_at DESC, p.id DESC LIMIT $4`,
    [authorId, cur?.t ?? null, cur?.id ?? null, limit + 1],
  );
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items: items.map((r) => ({
      id: r.id,
      kind: r.kind,
      body: r.body,
      language: r.language,
      likeCount: r.like_count,
      commentCount: r.comment_count,
      createdAt: r.created_at,
    })),
    nextCursor:
      rows.length > limit && last ? encodeCursor({ t: last.created_raw, id: last.id }) : null,
  };
}

const pageQuery = z.object({
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export function registerPublicApi(app: FastifyInstance, ctx: AppContext): void {
  route(app, ctx, {
    method: 'GET',
    url: '/v1/public/users/:username',
    summary: 'Public profile of an adult, non-private account (API key or access token)',
    tags: ['public-api'],
    auth: 'public',
    params: z.object({ username: z.string().trim().min(3).max(30) }),
    handler: async ({ req, reply, params }) => {
      const p = await authenticatePublicApi(ctx, req, reply);
      requireScope(p, p.kind === 'key' ? 'public:read' : 'profile:read');
      const { rows } = await ctx.db.query(
        `SELECT ${PROFILE_COLS} FROM profiles p JOIN users u ON u.id = p.user_id WHERE p.username = $1 AND ${PUBLIC_PROFILE}`,
        [params.username],
      );
      if (!rows[0]) throw notFound('User');
      return profileView(rows[0]);
    },
  });

  route(app, ctx, {
    method: 'GET',
    url: '/v1/public/users/:username/posts',
    summary: 'Public posts of an adult, non-private account',
    tags: ['public-api'],
    auth: 'public',
    params: z.object({ username: z.string().trim().min(3).max(30) }),
    query: pageQuery,
    handler: async ({ req, reply, params, query }) => {
      const p = await authenticatePublicApi(ctx, req, reply);
      requireScope(p, p.kind === 'key' ? 'public:read' : 'posts:read');
      const { rows } = await ctx.db.query(
        `SELECT p.user_id FROM profiles p JOIN users u ON u.id = p.user_id WHERE p.username = $1 AND ${PUBLIC_PROFILE}`,
        [params.username],
      );
      if (!rows[0]) throw notFound('User');
      return publicPosts(ctx, rows[0].user_id, query);
    },
  });

  route(app, ctx, {
    method: 'GET',
    url: '/v1/public/me',
    summary: 'The user who authorised this access token (scope profile:read)',
    tags: ['public-api'],
    auth: 'public',
    handler: async ({ req, reply }) => {
      const p = requireOAuth(await authenticatePublicApi(ctx, req, reply));
      requireScope(p, 'profile:read');
      const { rows } = await ctx.db.query(
        `SELECT ${PROFILE_COLS} FROM profiles p WHERE p.user_id = $1`,
        [p.userId],
      );
      if (!rows[0]) throw notFound('User');
      return { ...profileView(rows[0]), scopes: p.scopes };
    },
  });

  route(app, ctx, {
    method: 'GET',
    url: '/v1/public/me/posts',
    summary: "The authorising user's public posts (scope posts:read)",
    tags: ['public-api'],
    auth: 'public',
    query: pageQuery,
    handler: async ({ req, reply, query }) => {
      const p = requireOAuth(await authenticatePublicApi(ctx, req, reply));
      requireScope(p, 'posts:read');
      return publicPosts(ctx, p.userId, query);
    },
  });
}
