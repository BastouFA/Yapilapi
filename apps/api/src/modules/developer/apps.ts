import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  clampLimit,
  decodeCursor,
  encodeCursor,
  conflict,
  forbidden,
  invalid,
  notFound,
} from '@yapilapi/shared';
import { randomToken, sha256Hex } from '@yapilapi/security';
import { route } from '../../lib/route.js';
import { audit } from '../../lib/audit.js';
import type { AppContext } from '../../lib/context.js';
import type { AuthContext } from '../../lib/auth-context.js';
import { tokenPrefixes, validateRedirectUri } from './oauth.js';
import { assertWebhookDestination } from './ssrf.js';
import {
  WEBHOOK_EVENTS,
  encryptWebhookSecret,
  isWebhookEvent,
  newWebhookSecret,
  queueTestEvent,
} from './webhooks.js';
import type { DbRow } from '../../lib/db-row.js';

export const API_KEY_SCOPES = ['public:read'] as const;
const MAX_APPS = 10;
const MAX_ACTIVE_KEYS = 5;
const MAX_WEBHOOKS = 5;

const idParams = z.object({ id: z.uuid() });
const appKeyParams = z.object({ id: z.uuid(), keyId: z.uuid() });
const pageQuery = z.object({
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
const httpUrl = z
  .string()
  .trim()
  .url()
  .max(500)
  .refine((u) => /^https?:\/\//i.test(u), 'Must be an http(s) URL');
const redirectUris = z
  .array(z.string().trim().max(2000))
  .max(10)
  .refine(
    (l) => l.every(validateRedirectUri),
    'Redirect URIs must be https (or http on localhost) without wildcards, credentials or fragments',
  );

/** Developer tools are for adults: minors cannot register apps, create keys or webhooks. */
export function requireDeveloper(auth: AuthContext): void {
  if (auth.ageBand !== 'adult')
    throw forbidden('Developer tools are not available for teen accounts');
}

export async function loadOwnedApp(ctx: AppContext, userId: string, appId: string) {
  const { rows } = await ctx.db.query(
    `SELECT id, owner_id, name, description, redirect_uris, status, client_id, confidential, homepage_url, privacy_url, created_at, updated_at
       FROM developer_apps WHERE id = $1 AND owner_id = $2`,
    [appId, userId],
  );
  if (!rows[0]) throw notFound('App'); // 404 for other people's apps: never reveal existence
  return rows[0];
}

const appView = (r: DbRow) => ({
  id: r.id,
  name: r.name,
  description: r.description,
  clientId: r.client_id,
  confidential: r.confidential,
  redirectUris: r.redirect_uris,
  homepageUrl: r.homepage_url,
  privacyUrl: r.privacy_url,
  status: r.status,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const keyView = (r: DbRow) => ({
  id: r.id,
  name: r.name,
  prefix: r.key_prefix,
  scopes: r.scopes,
  rateLimitPerMin: r.rate_limit_per_min,
  lastUsedAt: r.last_used_at,
  expiresAt: r.expires_at,
  revokedAt: r.revoked_at,
  createdAt: r.created_at,
});

const webhookView = (r: DbRow) => ({
  id: r.id,
  appId: r.app_id,
  url: r.url,
  events: r.events,
  description: r.description,
  active: r.active,
  disabledReason: r.disabled_reason,
  consecutiveFailures: r.consecutive_failures,
  createdAt: r.created_at,
});

const eventsSchema = z
  .array(z.string())
  .min(1)
  .max(20)
  .refine((l) => l.every(isWebhookEvent), 'Unknown event type');

export function registerAppRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ------------------------------------------------------------------ apps
  route(app, ctx, {
    method: 'POST',
    url: '/v1/developer/apps',
    summary: 'Register a developer app (returns the client secret once for confidential clients)',
    tags: ['developer'],
    auth: 'user',
    body: z.object({
      name: z.string().trim().min(2).max(80),
      description: z.string().trim().max(500).optional(),
      redirectUris: redirectUris.default([]),
      confidential: z.boolean().default(true),
      homepageUrl: httpUrl.optional(),
      privacyUrl: httpUrl.optional(),
    }),
    rateLimit: { limit: 10, windowSec: 3600, by: 'user' },
    handler: async ({ auth, req, body, reply }) => {
      requireDeveloper(auth);
      const { rows: cnt } = await ctx.db.query(
        `SELECT count(*)::int AS n FROM developer_apps WHERE owner_id = $1`,
        [auth.userId],
      );
      if (cnt[0].n >= MAX_APPS) throw conflict(`You can register at most ${MAX_APPS} apps`);
      const clientId = `yl_${randomToken(15)}`;
      const secret = body.confidential ? `${tokenPrefixes.secret}${randomToken(32)}` : null;
      const { rows } = await ctx.db.query(
        `INSERT INTO developer_apps (owner_id, name, description, redirect_uris, client_id, client_secret_hash, confidential, homepage_url, privacy_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [
          auth.userId,
          body.name,
          body.description ?? null,
          body.redirectUris,
          clientId,
          secret ? sha256Hex(secret) : null,
          body.confidential,
          body.homepageUrl ?? null,
          body.privacyUrl ?? null,
        ],
      );
      await audit(
        ctx,
        {
          actorId: auth.userId,
          action: 'developer_app.created',
          targetType: 'developer_app',
          targetId: rows[0].id,
          metadata: { confidential: body.confidential },
        },
        req,
      );
      void reply.code(201);
      return {
        ...appView(rows[0]),
        clientSecret: secret,
        note: secret ? 'Store the client secret now; it cannot be shown again.' : undefined,
      };
    },
  });

  route(app, ctx, {
    method: 'GET',
    url: '/v1/developer/apps',
    summary: 'My developer apps',
    tags: ['developer'],
    auth: 'user',
    handler: async ({ auth }) => {
      const { rows } = await ctx.db.query(
        `SELECT * FROM developer_apps WHERE owner_id = $1 ORDER BY created_at DESC`,
        [auth.userId],
      );
      return { items: rows.map(appView) };
    },
  });

  route(app, ctx, {
    method: 'GET',
    url: '/v1/developer/apps/:id',
    summary: 'One of my developer apps',
    tags: ['developer'],
    auth: 'user',
    params: idParams,
    handler: async ({ auth, params }) => {
      const a = await loadOwnedApp(ctx, auth.userId, params.id);
      const { rows } = await ctx.db.query(
        `SELECT (SELECT count(*)::int FROM oauth_grants WHERE app_id = $1 AND revoked_at IS NULL) AS authorized_users,
                (SELECT count(*)::int FROM api_keys WHERE app_id = $1 AND revoked_at IS NULL) AS active_keys,
                (SELECT count(*)::int FROM webhook_endpoints WHERE app_id = $1) AS webhooks`,
        [params.id],
      );
      return {
        ...appView(a),
        stats: {
          authorizedUsers: rows[0].authorized_users,
          activeKeys: rows[0].active_keys,
          webhooks: rows[0].webhooks,
        },
      };
    },
  });

  route(app, ctx, {
    method: 'PATCH',
    url: '/v1/developer/apps/:id',
    summary: 'Update app details and redirect URIs',
    tags: ['developer'],
    auth: 'user',
    params: idParams,
    body: z.object({
      name: z.string().trim().min(2).max(80).optional(),
      description: z.string().trim().max(500).nullable().optional(),
      redirectUris: redirectUris.optional(),
      homepageUrl: httpUrl.nullable().optional(),
      privacyUrl: httpUrl.nullable().optional(),
    }),
    handler: async ({ auth, req, params, body }) => {
      requireDeveloper(auth);
      const a = await loadOwnedApp(ctx, auth.userId, params.id);
      if (a.status === 'suspended') throw forbidden('This app is suspended');
      const { rows } = await ctx.db.query(
        `UPDATE developer_apps SET name = COALESCE($2, name),
                description = CASE WHEN $3::boolean THEN $4 ELSE description END,
                redirect_uris = COALESCE($5, redirect_uris),
                homepage_url = CASE WHEN $6::boolean THEN $7 ELSE homepage_url END,
                privacy_url = CASE WHEN $8::boolean THEN $9 ELSE privacy_url END
          WHERE id = $1 RETURNING *`,
        [
          params.id,
          body.name ?? null,
          body.description !== undefined,
          body.description ?? null,
          body.redirectUris ?? null,
          body.homepageUrl !== undefined,
          body.homepageUrl ?? null,
          body.privacyUrl !== undefined,
          body.privacyUrl ?? null,
        ],
      );
      await audit(
        ctx,
        {
          actorId: auth.userId,
          action: 'developer_app.updated',
          targetType: 'developer_app',
          targetId: params.id,
          metadata: { fields: Object.keys(body) },
        },
        req,
      );
      return appView(rows[0]);
    },
  });

  route(app, ctx, {
    method: 'POST',
    url: '/v1/developer/apps/:id/rotate-secret',
    summary: 'Rotate the client secret (the old one stops working immediately)',
    tags: ['developer'],
    auth: 'user',
    params: idParams,
    rateLimit: { limit: 10, windowSec: 3600, by: 'user' },
    handler: async ({ auth, req, params }) => {
      requireDeveloper(auth);
      const a = await loadOwnedApp(ctx, auth.userId, params.id);
      if (!a.confidential)
        throw invalid('Public clients have no client secret (they rely on PKCE)');
      const secret = `${tokenPrefixes.secret}${randomToken(32)}`;
      await ctx.db.query('UPDATE developer_apps SET client_secret_hash = $2 WHERE id = $1', [
        params.id,
        sha256Hex(secret),
      ]);
      await audit(
        ctx,
        {
          actorId: auth.userId,
          action: 'developer_app.secret_rotated',
          targetType: 'developer_app',
          targetId: params.id,
        },
        req,
      );
      return {
        clientId: a.client_id,
        clientSecret: secret,
        note: 'Store the client secret now; it cannot be shown again.',
      };
    },
  });

  route(app, ctx, {
    method: 'DELETE',
    url: '/v1/developer/apps/:id',
    summary: 'Delete an app, its keys, webhooks and all user authorizations',
    tags: ['developer'],
    auth: 'user',
    params: idParams,
    handler: async ({ auth, req, params }) => {
      requireDeveloper(auth);
      await loadOwnedApp(ctx, auth.userId, params.id);
      await ctx.db.query('DELETE FROM developer_apps WHERE id = $1', [params.id]);
      await audit(
        ctx,
        {
          actorId: auth.userId,
          action: 'developer_app.deleted',
          targetType: 'developer_app',
          targetId: params.id,
        },
        req,
      );
    },
  });

  // ------------------------------------------------------------------ API keys
  route(app, ctx, {
    method: 'POST',
    url: '/v1/developer/apps/:id/keys',
    summary: 'Create an API key (shown once)',
    tags: ['developer'],
    auth: 'user',
    params: idParams,
    body: z.object({
      name: z.string().trim().min(1).max(60).default('default'),
      scopes: z.array(z.enum(API_KEY_SCOPES)).min(1).default(['public:read']),
      expiresInDays: z.number().int().min(1).max(365).optional(),
      rateLimitPerMin: z.number().int().min(1).max(1000).default(120),
    }),
    rateLimit: { limit: 20, windowSec: 3600, by: 'user' },
    handler: async ({ auth, req, params, body, reply }) => {
      requireDeveloper(auth);
      const a = await loadOwnedApp(ctx, auth.userId, params.id);
      if (a.status !== 'active') throw forbidden('This app is suspended');
      const { rows: cnt } = await ctx.db.query(
        `SELECT count(*)::int AS n FROM api_keys WHERE app_id = $1 AND revoked_at IS NULL`,
        [params.id],
      );
      if (cnt[0].n >= MAX_ACTIVE_KEYS)
        throw conflict(`An app can have at most ${MAX_ACTIVE_KEYS} active keys; revoke one first`);
      const key = `${tokenPrefixes.key}${randomToken(32)}`;
      const { rows } = await ctx.db.query(
        `INSERT INTO api_keys (app_id, name, key_prefix, key_hash, scopes, rate_limit_per_min, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $7::int IS NULL THEN NULL ELSE now() + make_interval(days => $7::int) END) RETURNING *`,
        [
          params.id,
          body.name,
          key.slice(0, 12),
          sha256Hex(key),
          body.scopes,
          body.rateLimitPerMin,
          body.expiresInDays ?? null,
        ],
      );
      await audit(
        ctx,
        {
          actorId: auth.userId,
          action: 'api_key.created',
          targetType: 'api_key',
          targetId: rows[0].id,
          metadata: { appId: params.id, scopes: body.scopes },
        },
        req,
      );
      void reply.code(201);
      return { ...keyView(rows[0]), key, note: 'Store this key now; it cannot be shown again.' };
    },
  });

  route(app, ctx, {
    method: 'GET',
    url: '/v1/developer/apps/:id/keys',
    summary: 'API keys of an app (prefix only; secrets are never retrievable)',
    tags: ['developer'],
    auth: 'user',
    params: idParams,
    handler: async ({ auth, params }) => {
      await loadOwnedApp(ctx, auth.userId, params.id);
      const { rows } = await ctx.db.query(
        `SELECT * FROM api_keys WHERE app_id = $1 ORDER BY created_at DESC`,
        [params.id],
      );
      return { items: rows.map(keyView) };
    },
  });

  route(app, ctx, {
    method: 'DELETE',
    url: '/v1/developer/apps/:id/keys/:keyId',
    summary: 'Revoke an API key',
    tags: ['developer'],
    auth: 'user',
    params: appKeyParams,
    handler: async ({ auth, req, params }) => {
      await loadOwnedApp(ctx, auth.userId, params.id);
      const r = await ctx.db.query(
        `UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND app_id = $2 AND revoked_at IS NULL`,
        [params.keyId, params.id],
      );
      if (r.rowCount === 0) throw notFound('API key');
      await audit(
        ctx,
        {
          actorId: auth.userId,
          action: 'api_key.revoked',
          targetType: 'api_key',
          targetId: params.keyId,
          metadata: { appId: params.id },
        },
        req,
      );
    },
  });

  // ------------------------------------------------------------------ webhooks
  route(app, ctx, {
    method: 'GET',
    url: '/v1/developer/webhook-events',
    summary: 'Event types apps can subscribe to',
    tags: ['developer'],
    auth: 'user',
    handler: () => ({
      items: Object.entries(WEBHOOK_EVENTS).map(([type, description]) => ({ type, description })),
    }),
  });

  route(app, ctx, {
    method: 'POST',
    url: '/v1/developer/apps/:id/webhooks',
    summary: 'Register a webhook endpoint (https, public hosts only; secret shown once)',
    tags: ['developer'],
    auth: 'user',
    params: idParams,
    body: z.object({
      url: z.string().trim().max(2048),
      events: eventsSchema,
      description: z.string().trim().max(200).optional(),
    }),
    rateLimit: { limit: 20, windowSec: 3600, by: 'user' },
    handler: async ({ auth, req, params, body, reply }) => {
      requireDeveloper(auth);
      const a = await loadOwnedApp(ctx, auth.userId, params.id);
      if (a.status !== 'active') throw forbidden('This app is suspended');
      const { rows: cnt } = await ctx.db.query(
        `SELECT count(*)::int AS n FROM webhook_endpoints WHERE app_id = $1`,
        [params.id],
      );
      if (cnt[0].n >= MAX_WEBHOOKS)
        throw conflict(`An app can have at most ${MAX_WEBHOOKS} webhook endpoints`);
      const url = await assertWebhookDestination(body.url);
      const id = randomUUID();
      const secret = newWebhookSecret();
      const { rows } = await ctx.db.query(
        `INSERT INTO webhook_endpoints (id, app_id, url, events, secret_enc, description) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [
          id,
          params.id,
          url.toString(),
          [...new Set(body.events)],
          encryptWebhookSecret(ctx, id, secret),
          body.description ?? null,
        ],
      );
      await audit(
        ctx,
        {
          actorId: auth.userId,
          action: 'webhook.created',
          targetType: 'webhook_endpoint',
          targetId: id,
          metadata: { appId: params.id, host: url.hostname, events: body.events },
        },
        req,
      );
      void reply.code(201);
      return {
        ...webhookView(rows[0]),
        secret,
        note: 'Store the signing secret now; it cannot be shown again.',
      };
    },
  });

  route(app, ctx, {
    method: 'GET',
    url: '/v1/developer/apps/:id/webhooks',
    summary: 'Webhook endpoints of an app',
    tags: ['developer'],
    auth: 'user',
    params: idParams,
    handler: async ({ auth, params }) => {
      await loadOwnedApp(ctx, auth.userId, params.id);
      const { rows } = await ctx.db.query(
        `SELECT * FROM webhook_endpoints WHERE app_id = $1 ORDER BY created_at DESC`,
        [params.id],
      );
      return { items: rows.map(webhookView) };
    },
  });

  const loadOwnedWebhook = async (userId: string, id: string) => {
    const { rows } = await ctx.db.query(
      `SELECT we.* FROM webhook_endpoints we JOIN developer_apps a ON a.id = we.app_id WHERE we.id = $1 AND a.owner_id = $2`,
      [id, userId],
    );
    if (!rows[0]) throw notFound('Webhook');
    return rows[0];
  };

  route(app, ctx, {
    method: 'PATCH',
    url: '/v1/developer/webhooks/:id',
    summary: 'Update a webhook (re-enable after fixing failures, change events/url)',
    tags: ['developer'],
    auth: 'user',
    params: idParams,
    body: z.object({
      url: z.string().trim().max(2048).optional(),
      events: eventsSchema.optional(),
      description: z.string().trim().max(200).nullable().optional(),
      active: z.boolean().optional(),
    }),
    handler: async ({ auth, req, params, body }) => {
      requireDeveloper(auth);
      const w = await loadOwnedWebhook(auth.userId, params.id);
      const url = body.url ? (await assertWebhookDestination(body.url)).toString() : null;
      const { rows } = await ctx.db.query(
        `UPDATE webhook_endpoints SET url = COALESCE($2, url), events = COALESCE($3, events),
                description = CASE WHEN $4::boolean THEN $5 ELSE description END,
                active = COALESCE($6, active),
                consecutive_failures = CASE WHEN $6 IS TRUE THEN 0 ELSE consecutive_failures END,
                disabled_reason = CASE WHEN $6 IS TRUE THEN NULL ELSE disabled_reason END
          WHERE id = $1 RETURNING *`,
        [
          w.id,
          url,
          body.events ? [...new Set(body.events)] : null,
          body.description !== undefined,
          body.description ?? null,
          body.active ?? null,
        ],
      );
      await audit(
        ctx,
        {
          actorId: auth.userId,
          action: 'webhook.updated',
          targetType: 'webhook_endpoint',
          targetId: w.id,
          metadata: { fields: Object.keys(body) },
        },
        req,
      );
      return webhookView(rows[0]);
    },
  });

  route(app, ctx, {
    method: 'POST',
    url: '/v1/developer/webhooks/:id/rotate-secret',
    summary: 'Rotate the signing secret',
    tags: ['developer'],
    auth: 'user',
    params: idParams,
    handler: async ({ auth, req, params }) => {
      requireDeveloper(auth);
      const w = await loadOwnedWebhook(auth.userId, params.id);
      const secret = newWebhookSecret();
      await ctx.db.query('UPDATE webhook_endpoints SET secret_enc = $2 WHERE id = $1', [
        w.id,
        encryptWebhookSecret(ctx, w.id, secret),
      ]);
      await audit(
        ctx,
        {
          actorId: auth.userId,
          action: 'webhook.secret_rotated',
          targetType: 'webhook_endpoint',
          targetId: w.id,
        },
        req,
      );
      return { secret, note: 'Store the signing secret now; it cannot be shown again.' };
    },
  });

  route(app, ctx, {
    method: 'POST',
    url: '/v1/developer/webhooks/:id/test',
    summary: 'Queue a test (ping) event',
    tags: ['developer'],
    auth: 'user',
    params: idParams,
    rateLimit: { limit: 20, windowSec: 3600, by: 'user' },
    handler: async ({ auth, params, reply }) => {
      requireDeveloper(auth);
      const w = await loadOwnedWebhook(auth.userId, params.id);
      if (!w.active) throw conflict('This endpoint is disabled');
      const deliveryId = await queueTestEvent(ctx, w.id);
      void reply.code(202);
      return { deliveryId, status: 'queued' };
    },
  });

  route(app, ctx, {
    method: 'GET',
    url: '/v1/developer/webhooks/:id/deliveries',
    summary: 'Recent deliveries of a webhook',
    tags: ['developer'],
    auth: 'user',
    params: idParams,
    query: pageQuery,
    handler: async ({ auth, params, query }) => {
      const w = await loadOwnedWebhook(auth.userId, params.id);
      const limit = clampLimit(query.limit);
      const cur = decodeCursor<{ t: string; id: string }>(query.cursor);
      const { rows } = await ctx.db.query(
        `SELECT id, event_type, event_id, status, attempts, last_status_code, last_error, next_attempt_at, delivered_at, created_at, created_at::text AS created_raw
           FROM webhook_deliveries WHERE endpoint_id = $1 AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
          ORDER BY created_at DESC, id DESC LIMIT $4`,
        [w.id, cur?.t ?? null, cur?.id ?? null, limit + 1],
      );
      const items = rows.slice(0, limit);
      const last = items[items.length - 1];
      return {
        items: items.map(({ created_raw: _c, ...r }) => ({
          id: r.id,
          eventType: r.event_type,
          eventId: r.event_id,
          status: r.status,
          attempts: r.attempts,
          lastStatusCode: r.last_status_code,
          lastError: r.last_error,
          nextAttemptAt: r.next_attempt_at,
          deliveredAt: r.delivered_at,
          createdAt: r.created_at,
        })),
        nextCursor:
          rows.length > limit && last ? encodeCursor({ t: last.created_raw, id: last.id }) : null,
      };
    },
  });

  route(app, ctx, {
    method: 'DELETE',
    url: '/v1/developer/webhooks/:id',
    summary: 'Delete a webhook endpoint',
    tags: ['developer'],
    auth: 'user',
    params: idParams,
    handler: async ({ auth, req, params }) => {
      requireDeveloper(auth);
      const w = await loadOwnedWebhook(auth.userId, params.id);
      await ctx.db.query('DELETE FROM webhook_endpoints WHERE id = $1', [w.id]);
      await audit(
        ctx,
        {
          actorId: auth.userId,
          action: 'webhook.deleted',
          targetType: 'webhook_endpoint',
          targetId: w.id,
        },
        req,
      );
    },
  });
}
