import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, forbidden } from '@yapilapi/shared';
import { route } from '../../lib/route.js';
import { audit } from '../../lib/audit.js';
import type { AppContext } from '../../lib/context.js';
import {
  CODE_CHALLENGE_RE,
  OAUTH_SCOPES,
  OAuthError,
  authenticateClient,
  exchangeAuthorizationCode,
  findClient,
  issueAuthorizationCode,
  parseScopes,
  refreshTokens,
  revokeToken,
  type OAuthClient,
} from './oauth.js';

const authorizeShape = {
  response_type: z.literal('code'),
  client_id: z.string().min(3).max(100),
  redirect_uri: z.string().max(2000),
  scope: z.string().max(500),
  state: z.string().max(500).optional(),
  code_challenge: z.string().max(200),
  code_challenge_method: z.literal('S256'),
};

const tokenBody = z.object({
  grant_type: z.string().max(50),
  client_id: z.string().max(100).optional(),
  client_secret: z.string().max(200).optional(),
  code: z.string().max(300).optional(),
  redirect_uri: z.string().max(2000).optional(),
  code_verifier: z.string().max(200).optional(),
  refresh_token: z.string().max(300).optional(),
  scope: z.string().max(500).optional(),
});

const revokeBody = z.object({
  token: z.string().max(300),
  client_id: z.string().max(100).optional(),
  client_secret: z.string().max(200).optional(),
});

/** Client credentials from the body or HTTP Basic (RFC 6749 2.3.1). */
function clientCredentials(
  header: string | undefined,
  body: { client_id?: string; client_secret?: string },
) {
  let id = body.client_id;
  let secret = body.client_secret;
  if (header?.startsWith('Basic ')) {
    const [i, ...rest] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
    id = decodeURIComponent(i ?? '');
    secret = decodeURIComponent(rest.join(':'));
  }
  return { id, secret };
}

interface Validated {
  client: OAuthClient;
  scopes: ReturnType<typeof parseScopes> & object;
}

/** Validate an authorization request. Problems with client/redirect are never redirected (RFC 6749 4.1.2.1). */
async function validateAuthorization(
  ctx: AppContext,
  q: { client_id: string; redirect_uri: string; scope: string; code_challenge: string },
): Promise<Validated> {
  const client = await findClient(ctx, q.client_id);
  if (!client || client.status !== 'active')
    throw new AppError('validation_failed', 'Unknown application', { error: 'invalid_client' });
  if (!client.redirectUris.includes(q.redirect_uri))
    throw new AppError('validation_failed', 'redirect_uri is not registered for this application', {
      error: 'invalid_request',
    });
  const scopes = parseScopes(q.scope);
  if (!scopes)
    throw new AppError(
      'validation_failed',
      `scope must be one or more of: ${Object.keys(OAUTH_SCOPES).join(', ')}`,
      { error: 'invalid_scope' },
    );
  if (!CODE_CHALLENGE_RE.test(q.code_challenge))
    throw new AppError(
      'validation_failed',
      'code_challenge must be a base64url SHA-256 digest (43 characters)',
      { error: 'invalid_request' },
    );
  return { client, scopes };
}

export function registerOAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  // The token endpoint is form-encoded per RFC 6749. Scoped to this module's encapsulated instance.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    },
  );

  route(app, ctx, {
    method: 'GET',
    url: '/v1/oauth/scopes',
    summary: 'Scopes an app can request',
    tags: ['oauth'],
    auth: 'public',
    handler: () => ({
      items: Object.entries(OAUTH_SCOPES).map(([scope, description]) => ({ scope, description })),
    }),
  });

  route(app, ctx, {
    method: 'GET',
    url: '/v1/oauth/authorize',
    summary:
      'Validate an authorization request and describe what the user is being asked to grant (consent screen data)',
    tags: ['oauth'],
    auth: 'user',
    query: z.object(authorizeShape),
    rateLimit: { limit: 60, windowSec: 3600, by: 'user' },
    handler: async ({ auth, query }) => {
      if (auth.ageBand !== 'adult')
        throw forbidden('Teen accounts cannot connect third-party apps');
      const { client, scopes } = await validateAuthorization(ctx, query);
      const { rows: dev } = await ctx.db.query('SELECT username FROM profiles WHERE user_id = $1', [
        client.ownerId,
      ]);
      const { rows: g } = await ctx.db.query(
        'SELECT 1 FROM oauth_grants WHERE app_id = $1 AND user_id = $2 AND revoked_at IS NULL',
        [client.id, auth.userId],
      );
      return {
        app: {
          name: client.name,
          description: client.description,
          homepageUrl: client.homepageUrl,
          privacyUrl: client.privacyUrl,
          developer: dev[0]?.username ?? null,
        },
        scopes: scopes.map((s) => ({ scope: s, description: OAUTH_SCOPES[s] })),
        redirectUri: query.redirect_uri,
        alreadyAuthorized: Boolean(g[0]),
      };
    },
  });

  route(app, ctx, {
    method: 'POST',
    url: '/v1/oauth/authorize',
    summary: 'Approve or deny an authorization request; returns the URL to send the user back to',
    tags: ['oauth'],
    auth: 'user',
    body: z.object({ ...authorizeShape, approve: z.boolean() }),
    rateLimit: { limit: 30, windowSec: 3600, by: 'user' },
    handler: async ({ auth, req, body }) => {
      if (auth.ageBand !== 'adult')
        throw forbidden('Teen accounts cannot connect third-party apps');
      const { client, scopes } = await validateAuthorization(ctx, body);
      const back = new URL(body.redirect_uri);
      if (!body.approve) {
        back.searchParams.set('error', 'access_denied');
      } else {
        const code = await issueAuthorizationCode(ctx, client, auth.userId, {
          clientId: client.clientId,
          redirectUri: body.redirect_uri,
          scopes,
          state: body.state,
          codeChallenge: body.code_challenge,
        });
        back.searchParams.set('code', code);
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'oauth.consent_approved',
            targetType: 'developer_app',
            targetId: client.id,
            metadata: { scopes },
          },
          req,
        );
      }
      if (body.state) back.searchParams.set('state', body.state);
      return { redirectTo: back.toString() };
    },
  });

  route(app, ctx, {
    method: 'POST',
    url: '/v1/oauth/token',
    summary: 'Exchange an authorization code (with PKCE verifier) or a refresh token for tokens',
    tags: ['oauth'],
    auth: 'public',
    body: tokenBody,
    rateLimit: { limit: 120, windowSec: 60 },
    handler: async ({ req, reply, body }) => {
      void reply.header('cache-control', 'no-store').header('pragma', 'no-cache');
      try {
        const cred = clientCredentials(req.headers.authorization, body);
        const client = await authenticateClient(ctx, cred.id, cred.secret);
        if (body.grant_type === 'authorization_code') {
          return await exchangeAuthorizationCode(
            ctx,
            client,
            { code: body.code, redirectUri: body.redirect_uri, codeVerifier: body.code_verifier },
            req,
          );
        }
        if (body.grant_type === 'refresh_token') {
          return await refreshTokens(
            ctx,
            client,
            { refreshToken: body.refresh_token, scope: body.scope },
            req,
          );
        }
        throw new OAuthError(
          'unsupported_grant_type',
          'grant_type must be authorization_code or refresh_token',
        );
      } catch (e) {
        if (e instanceof OAuthError) {
          if (e.status === 401) void reply.header('www-authenticate', 'Basic realm="oauth"');
          return reply.code(e.status).send({ error: e.error, error_description: e.message });
        }
        throw e;
      }
    },
  });

  route(app, ctx, {
    method: 'POST',
    url: '/v1/oauth/revoke',
    summary: 'Revoke an access or refresh token (RFC 7009)',
    tags: ['oauth'],
    auth: 'public',
    body: revokeBody,
    rateLimit: { limit: 120, windowSec: 60 },
    handler: async ({ req, reply, body }) => {
      try {
        const cred = clientCredentials(req.headers.authorization, body);
        const client = await authenticateClient(ctx, cred.id, cred.secret);
        await revokeToken(ctx, client, body.token);
        return reply.code(200).send({});
      } catch (e) {
        if (e instanceof OAuthError)
          return reply.code(e.status).send({ error: e.error, error_description: e.message });
        throw e;
      }
    },
  });
}
