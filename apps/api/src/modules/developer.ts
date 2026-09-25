import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { hashToken } from '@yapilapi/auth';
import { z } from 'zod';
import { AppError, badRequest, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { audit } from '../lib/services.ts';
import { assertSafeWebhookUrl, emitWebhook, newWebhookSecret, WEBHOOK_EVENTS } from '../lib/webhooks.ts';
import { me, requireAuth } from '../plugins/auth.ts';

const idParam = z.object({ id: z.string().uuid() });

/**
 * Developer platform: apps, scoped API keys and webhook subscriptions.
 * API keys act as their owner with `read` and/or `write` scope; they can never
 * manage keys, sessions, MFA, account deletion, exports or admin (see plugins/auth.ts).
 */
export default async function developerModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;
  const allowLocal = ctx.config.APP_ENV === 'development' || ctx.config.APP_ENV === 'test';

  async function ownApp(appId: string, userId: string) {
    const r = await db.query(`SELECT id, name FROM developer_apps WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL`, [appId, userId]);
    if (!r.rows[0]) throw notFound('App');
    return r.rows[0];
  }

  app.get('/v1/developer/apps', { preHandler: requireAuth }, async (req) => {
    const { rows } = await db.query(
      `SELECT a.id, a.name, a.description, a.website, a.created_at,
         (SELECT count(*) FROM api_keys k WHERE k.app_id = a.id AND k.revoked_at IS NULL) AS active_keys,
         (SELECT count(*) FROM webhook_subscriptions s WHERE s.app_id = a.id AND s.active) AS webhooks
       FROM developer_apps a WHERE a.owner_id = $1 AND a.deleted_at IS NULL ORDER BY a.created_at`,
      [me(req).id],
    );
    return { items: rows };
  });

  app.post('/v1/developer/apps', { preHandler: requireAuth, config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    const input = parse(
      z.object({ name: z.string().trim().min(1).max(60), description: z.string().trim().max(500).default(''), website: z.string().url().optional() }),
      req.body,
    );
    const count = await db.query(`SELECT count(*) AS n FROM developer_apps WHERE owner_id = $1 AND deleted_at IS NULL`, [u.id]);
    if (count.rows[0].n >= 10) throw new AppError(409, 'conflict', 'You can have up to 10 apps.');
    const { rows } = await db.query(
      `INSERT INTO developer_apps (owner_id, name, description, website) VALUES ($1,$2,$3,$4) RETURNING id, name, description, website, created_at`,
      [u.id, input.name, input.description, input.website ?? null],
    );
    await audit(db, { actorId: u.id, action: 'developer.app_create', entityType: 'developer_app', entityId: rows[0].id });
    reply.code(201);
    return { app: rows[0] };
  });

  app.delete('/v1/developer/apps/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    await ownApp(id, me(req).id);
    await db.query(`UPDATE developer_apps SET deleted_at = now() WHERE id = $1`, [id]);
    await db.query(`UPDATE api_keys SET revoked_at = now() WHERE app_id = $1 AND revoked_at IS NULL`, [id]);
    await db.query(`UPDATE webhook_subscriptions SET active = false WHERE app_id = $1`, [id]);
    await audit(db, { actorId: me(req).id, action: 'developer.app_delete', entityType: 'developer_app', entityId: id });
    return { ok: true };
  });

  // ── API keys ──────────────────────────────────────────────────────────
  app.get('/v1/developer/apps/:id/keys', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    await ownApp(id, me(req).id);
    const { rows } = await db.query(
      `SELECT id, name, prefix, scopes, last_used_at, expires_at, revoked_at, created_at FROM api_keys WHERE app_id = $1 ORDER BY created_at DESC`,
      [id],
    );
    return { items: rows };
  });

  /** The full key is returned once and never stored. */
  app.post('/v1/developer/apps/:id/keys', { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(
      z.object({
        name: z.string().trim().min(1).max(60),
        scopes: z
          .array(z.enum(['read', 'write']))
          .min(1)
          .default(['read']),
        expiresInDays: z.number().int().min(1).max(365).optional(),
      }),
      req.body,
    );
    await ownApp(id, u.id);
    const prefix = `ypl_${randomBytes(4).toString('hex')}`;
    const key = `${prefix}_${randomBytes(24).toString('base64url')}`;
    const { rows } = await db.query(
      `INSERT INTO api_keys (app_id, owner_id, name, prefix, key_hash, scopes, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $7::int IS NULL THEN NULL ELSE now() + make_interval(days => $7::int) END)
       RETURNING id, name, prefix, scopes, expires_at, created_at`,
      [id, u.id, input.name, prefix, hashToken(key), [...new Set(input.scopes)], input.expiresInDays ?? null],
    );
    await audit(db, { actorId: u.id, action: 'developer.key_create', entityType: 'api_key', entityId: rows[0].id, metadata: { scopes: input.scopes } });
    reply.code(201);
    return { key: rows[0], secret: key, message: "Copy this key now. You won't be able to see it again." };
  });

  app.delete('/v1/developer/apps/:id/keys/:keyId', { preHandler: requireAuth }, async (req) => {
    const { id, keyId } = parse(z.object({ id: z.string().uuid(), keyId: z.string().uuid() }), req.params);
    await ownApp(id, me(req).id);
    const r = await db.query(`UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND app_id = $2 AND revoked_at IS NULL`, [keyId, id]);
    if (!r.rowCount) throw notFound('Key');
    await audit(db, { actorId: me(req).id, action: 'developer.key_revoke', entityType: 'api_key', entityId: keyId });
    return { ok: true };
  });

  // ── Webhooks ──────────────────────────────────────────────────────────
  app.get('/v1/developer/apps/:id/webhooks', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    await ownApp(id, me(req).id);
    const subs = await db.query(`SELECT id, url, events, active, created_at FROM webhook_subscriptions WHERE app_id = $1 ORDER BY created_at`, [id]);
    const deliveries = await db.query(
      `SELECT d.id, d.event, d.status, d.attempts, d.response_code, d.last_error, d.created_at, d.delivered_at
       FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id = d.subscription_id WHERE s.app_id = $1 ORDER BY d.created_at DESC LIMIT 50`,
      [id],
    );
    return { items: subs.rows, deliveries: deliveries.rows, events: WEBHOOK_EVENTS };
  });

  app.post('/v1/developer/apps/:id/webhooks', { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(z.object({ url: z.string().max(500), events: z.array(z.enum(WEBHOOK_EVENTS)).min(1) }), req.body);
    await ownApp(id, u.id);
    try {
      await assertSafeWebhookUrl(input.url, allowLocal);
    } catch (e) {
      throw badRequest((e as Error).message, { fields: { url: (e as Error).message } });
    }
    const secret = newWebhookSecret();
    const { rows } = await db.query(
      `INSERT INTO webhook_subscriptions (app_id, url, events, secret) VALUES ($1,$2,$3,$4) RETURNING id, url, events, active, created_at`,
      [id, input.url, [...new Set(input.events)], secret],
    );
    await audit(db, { actorId: u.id, action: 'developer.webhook_create', entityType: 'webhook', entityId: rows[0].id });
    reply.code(201);
    return { webhook: rows[0], secret, message: 'Use this secret to verify the x-yapilapi-signature header. It is shown once.' };
  });

  app.delete('/v1/developer/apps/:id/webhooks/:wid', { preHandler: requireAuth }, async (req) => {
    const { id, wid } = parse(z.object({ id: z.string().uuid(), wid: z.string().uuid() }), req.params);
    await ownApp(id, me(req).id);
    const r = await db.query(`UPDATE webhook_subscriptions SET active = false WHERE id = $1 AND app_id = $2`, [wid, id]);
    if (!r.rowCount) throw notFound('Webhook');
    return { ok: true };
  });

  app.post('/v1/developer/apps/:id/webhooks/:wid/ping', { preHandler: requireAuth }, async (req) => {
    const { id, wid } = parse(z.object({ id: z.string().uuid(), wid: z.string().uuid() }), req.params);
    await ownApp(id, me(req).id);
    const r = await db.query(
      `INSERT INTO webhook_deliveries (subscription_id, event, payload) SELECT id, 'ping', jsonb_build_object('id', gen_random_uuid(), 'type', 'ping', 'createdAt', now(), 'data', '{}'::jsonb)
       FROM webhook_subscriptions WHERE id = $1 AND app_id = $2 AND active`,
      [wid, id],
    );
    if (!r.rowCount) throw notFound('Webhook');
    return { queued: true };
  });

  void emitWebhook;
}
