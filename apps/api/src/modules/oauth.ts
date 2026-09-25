import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { hashToken } from '@yapilapi/auth';
import { tx } from '@yapilapi/database';
import { z } from 'zod';
import { AppError, badRequest, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { audit } from '../lib/services.ts';
import { me, requireAuth } from '../plugins/auth.ts';

const ACCESS_TTL_SECONDS = 3600;
const REFRESH_TTL_DAYS = 60;
const SCOPES = ['read', 'write'] as const;

const oauthError = (status: number, error: string, description: string) => new AppError(status, error, description);

/**
 * "Sign in with YAPILAPI" for third-party apps: OAuth 2.0 authorization code
 * flow with mandatory PKCE (S256), for public clients (mobile, SPA) and servers
 * alike. Tokens are opaque (ypo_…), stored hashed, scoped read/write, and carry
 * the same restrictions as API keys. Users see and revoke connected apps.
 */
export default async function oauthModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;

  const authorizeQuery = z.object({
    response_type: z.literal('code'),
    client_id: z.string().uuid(),
    redirect_uri: z.string().url(),
    scope: z.string().default('read'),
    state: z.string().max(500).optional(),
    code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
    code_challenge_method: z.literal('S256'),
  });

  async function appFor(clientId: string, redirectUri: string) {
    const { rows } = await db.query(
      `SELECT a.id, a.name, a.description, a.website, a.redirect_uris, pr.display_name AS owner_name
       FROM developer_apps a JOIN profiles pr ON pr.user_id = a.owner_id WHERE a.id = $1 AND a.deleted_at IS NULL`,
      [clientId],
    );
    const a = rows[0];
    if (!a) throw notFound('App');
    // Exact match only: no prefix or wildcard redirect URIs.
    if (!a.redirect_uris.includes(redirectUri)) throw badRequest('This redirect address is not registered for the app.');
    return a;
  }

  const parseScopes = (s: string) => {
    const list = [...new Set(s.split(/[\s,]+/).filter(Boolean))];
    if (!list.length || list.some((x) => !(SCOPES as readonly string[]).includes(x))) throw badRequest('Unknown scope. Use read and/or write.');
    return list;
  };

  /** Consent screen data. The web app shows it at /oauth/authorize. */
  app.get('/v1/oauth/authorize', { preHandler: requireAuth }, async (req) => {
    const q = parse(authorizeQuery, req.query);
    const a = await appFor(q.client_id, q.redirect_uri);
    return {
      app: { id: a.id, name: a.name, description: a.description, website: a.website, ownerName: a.owner_name },
      scopes: parseScopes(q.scope),
      redirectUri: q.redirect_uri,
    };
  });

  app.post('/v1/oauth/authorize', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    if (u.apiKey) throw oauthError(403, 'forbidden', 'Sign in to the app to connect other apps.');
    const body = parse(authorizeQuery.extend({ approve: z.boolean() }), req.body);
    await appFor(body.client_id, body.redirect_uri);
    const scopes = parseScopes(body.scope);
    const target = new URL(body.redirect_uri);
    if (body.state) target.searchParams.set('state', body.state);
    if (!body.approve) {
      target.searchParams.set('error', 'access_denied');
      return { redirectTo: target.toString() };
    }
    const code = randomBytes(32).toString('base64url');
    await db.query(
      `INSERT INTO oauth_codes (app_id, user_id, code_hash, redirect_uri, scopes, code_challenge, expires_at) VALUES ($1,$2,$3,$4,$5,$6, now() + interval '5 minutes')`,
      [body.client_id, u.id, hashToken(code), body.redirect_uri, scopes, body.code_challenge],
    );
    target.searchParams.set('code', code);
    return { redirectTo: target.toString() };
  });

  async function issue(c: { query: typeof db.query }, appId: string, userId: string, scopes: string[]) {
    const access = `ypo_${randomBytes(32).toString('base64url')}`;
    const refresh = `ypr_${randomBytes(32).toString('base64url')}`;
    await c.query(
      `INSERT INTO oauth_grants (app_id, user_id, scopes, access_hash, refresh_hash, access_expires_at, refresh_expires_at)
       VALUES ($1,$2,$3,$4,$5, now() + make_interval(secs => $6), now() + make_interval(days => $7))`,
      [appId, userId, scopes, hashToken(access), hashToken(refresh), ACCESS_TTL_SECONDS, REFRESH_TTL_DAYS],
    );
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_SECONDS, refresh_token: refresh, scope: scopes.join(' ') };
  }

  /** Token endpoint (form or JSON). Errors follow RFC 6749 shape. */
  app.post('/v1/oauth/token', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = (typeof req.body === 'string' ? Object.fromEntries(new URLSearchParams(req.body)) : req.body) as Record<string, string>;
    const fail = (error: string, description: string) => reply.code(400).send({ error, error_description: description });
    reply.header('cache-control', 'no-store');
    if (body?.grant_type === 'authorization_code') {
      const p = z
        .object({ code: z.string().min(20), redirect_uri: z.string().url(), client_id: z.string().uuid(), code_verifier: z.string().min(43).max(128) })
        .safeParse(body);
      if (!p.success) return fail('invalid_request', 'code, redirect_uri, client_id and code_verifier are required.');
      return tx(db, async (c) => {
        const { rows } = await c.query(`UPDATE oauth_codes SET used_at = now() WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING *`, [
          hashToken(p.data.code),
        ]);
        const code = rows[0];
        if (!code || code.app_id !== p.data.client_id || code.redirect_uri !== p.data.redirect_uri)
          return fail('invalid_grant', 'The code is invalid, expired or already used.');
        const challenge = createHash('sha256').update(p.data.code_verifier).digest('base64url');
        if (challenge !== code.code_challenge) return fail('invalid_grant', 'PKCE verification failed.');
        const tokens = await issue(c, code.app_id, code.user_id, code.scopes);
        await audit(c, { actorId: code.user_id, action: 'oauth.grant', entityType: 'developer_app', entityId: code.app_id, metadata: { scopes: code.scopes } });
        return tokens;
      });
    }
    if (body?.grant_type === 'refresh_token') {
      const p = z.object({ refresh_token: z.string().startsWith('ypr_'), client_id: z.string().uuid() }).safeParse(body);
      if (!p.success) return fail('invalid_request', 'refresh_token and client_id are required.');
      return tx(db, async (c) => {
        // Rotation: each refresh token works once; the old grant is revoked.
        const { rows } = await c.query(
          `UPDATE oauth_grants SET revoked_at = now() WHERE refresh_hash = $1 AND app_id = $2 AND revoked_at IS NULL AND refresh_expires_at > now() RETURNING app_id, user_id, scopes`,
          [hashToken(p.data.refresh_token), p.data.client_id],
        );
        if (!rows[0]) return fail('invalid_grant', 'The refresh token is invalid or was already used.');
        return issue(c, rows[0].app_id, rows[0].user_id, rows[0].scopes);
      });
    }
    return fail('unsupported_grant_type', 'Use authorization_code or refresh_token.');
  });

  app.get('/v1/me/connected-apps', { preHandler: requireAuth }, async (req) => {
    const { rows } = await db.query(
      `SELECT a.id, a.name, a.website, array_agg(DISTINCT s) AS scopes, max(g.created_at) AS connected_at, max(g.last_used_at) AS last_used_at
       FROM oauth_grants g JOIN developer_apps a ON a.id = g.app_id, unnest(g.scopes) s
       WHERE g.user_id = $1 AND g.revoked_at IS NULL AND g.refresh_expires_at > now() GROUP BY a.id ORDER BY max(g.created_at) DESC`,
      [me(req).id],
    );
    return { items: rows };
  });

  app.delete('/v1/me/connected-apps/:id', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const r = await db.query(`UPDATE oauth_grants SET revoked_at = now() WHERE app_id = $1 AND user_id = $2 AND revoked_at IS NULL`, [id, u.id]);
    await audit(db, { actorId: u.id, action: 'oauth.revoke', entityType: 'developer_app', entityId: id });
    return { revoked: r.rowCount };
  });

  /** Developers register exact redirect URIs (https, or http://localhost for development). */
  app.put('/v1/developer/apps/:id/redirect-uris', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const { redirectUris } = parse(z.object({ redirectUris: z.array(z.string().url().max(500)).max(10) }), req.body);
    for (const r of redirectUris) {
      const url = new URL(r);
      const local = ['localhost', '127.0.0.1'].includes(url.hostname);
      const appScheme = !['http:', 'https:', 'javascript:', 'data:', 'file:', 'vbscript:'].includes(url.protocol) && /^[a-z][a-z0-9+.-]*:$/.test(url.protocol);
      const ok = url.protocol === 'https:' || (url.protocol === 'http:' && local) || appScheme;
      if (!ok || url.hash) throw badRequest(`${r} must use https (or http://localhost, or an app scheme) and have no #fragment.`);
      if (url.protocol === 'javascript:' || url.protocol === 'data:') throw badRequest('That redirect scheme is not allowed.');
    }
    const r = await db.query(`UPDATE developer_apps SET redirect_uris = $3 WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL RETURNING redirect_uris`, [
      id,
      u.id,
      redirectUris,
    ]);
    if (!r.rowCount) throw notFound('App');
    return { redirectUris: r.rows[0].redirect_uris };
  });
}
