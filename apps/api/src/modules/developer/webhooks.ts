import { decrypt, encrypt, randomToken, signWebhook } from '@yapilapi/security';
import type { Queryable } from '@yapilapi/database';
import type { AppContext } from '../../lib/context.js';
import { notify } from '../../lib/notify.js';
import {
  getWebhookNetwork,
  resolvePublicAddress,
  validateWebhookUrl,
  WebhookUrlError,
  type LookupAll,
  type WebhookTransport,
} from './ssrf.js';

/**
 * Webhook events, signing, the delivery queue and its retry policy.
 *
 * Events are pushed to a developer app ONLY for users who authorised that app (an active OAuth grant covering the
 * event's scope); an app never receives data about users who did not connect it. Payloads carry ids and minimal facts,
 * never private content.
 *
 * Signature header (Stripe-compatible shape so existing verifiers work):
 *   X-YAPILAPI-Signature: t=<unix>,v1=<hex hmac-sha256 of "<t>.<raw body>" with the endpoint secret>
 * Receivers should reject timestamps older than 5 minutes (see `verifyWebhookSignature` in @yapilapi/security).
 */

export const WEBHOOK_EVENTS = {
  ping: 'Sent when you press "send test event".',
  'post.created':
    'A user who authorised your app published a public post (requires the posts:read scope).',
  'authorization.revoked': "A user revoked your app's access.",
} as const;
export type WebhookEventType = keyof typeof WEBHOOK_EVENTS;
export const isWebhookEvent = (s: string): s is WebhookEventType =>
  Object.hasOwn(WEBHOOK_EVENTS, s);

/** Scope a user must have granted for an event about them to be delivered (null = no scope needed). */
const EVENT_SCOPE: Partial<Record<WebhookEventType, string>> = { 'post.created': 'posts:read' };

export const MAX_ATTEMPTS = 7;
export const DISABLE_AFTER_CONSECUTIVE_FAILURES = 20;
/** Delay before attempt N+1 after attempt N failed: 1m, 5m, 30m, 2h, 6h, 12h. */
const BACKOFF_SEC = [60, 300, 1800, 7200, 21600, 43200];
export const nextRetryDelaySec = (failedAttempts: number): number | null =>
  failedAttempts >= MAX_ATTEMPTS
    ? null
    : BACKOFF_SEC[Math.min(failedAttempts, BACKOFF_SEC.length) - 1]!;

export const newWebhookSecret = () => `whsec_${randomToken(32)}`;
export const webhookAad = (endpointId: string) => `webhook:${endpointId}`;

export function encryptWebhookSecret(ctx: AppContext, endpointId: string, secret: string): string {
  return encrypt(
    secret,
    ctx.config.dataEncryptionKey,
    ctx.config.DATA_ENCRYPTION_KEY_ID,
    webhookAad(endpointId),
  );
}

// ------------------------------------------------------------------ enqueue

/** Queue an event for every subscribed endpoint of `appId` (used for app-level events such as authorization.revoked). */
export async function emitAppEvent(
  ctx: AppContext,
  appId: string,
  type: WebhookEventType,
  data: Record<string, unknown>,
): Promise<number> {
  const { rowCount } = await ctx.db.query(
    `INSERT INTO webhook_deliveries (endpoint_id, event_type, payload)
     SELECT we.id, $2, $3::jsonb FROM webhook_endpoints we JOIN developer_apps a ON a.id = we.app_id
      WHERE we.app_id = $1 AND we.active AND a.status = 'active' AND $2 = ANY(we.events)`,
    [appId, type, JSON.stringify({ type, data })],
  );
  return rowCount ?? 0;
}

/**
 * Queue an event about `userId` for each app that user has authorised with the needed scope and that subscribed to it.
 * Fire-and-forget from request handlers: `void emitUserEvent(...)`. Never throws.
 */
export async function emitUserEvent(
  ctx: AppContext,
  userId: string,
  type: WebhookEventType,
  data: Record<string, unknown>,
): Promise<number> {
  try {
    const { rowCount } = await ctx.db.query(
      `INSERT INTO webhook_deliveries (endpoint_id, event_type, payload)
       SELECT we.id, $2, $3::jsonb
         FROM webhook_endpoints we
         JOIN developer_apps a ON a.id = we.app_id AND a.status = 'active'
         JOIN oauth_grants g ON g.app_id = a.id AND g.user_id = $1 AND g.revoked_at IS NULL
        WHERE we.active AND $2 = ANY(we.events) AND ($4::text IS NULL OR $4 = ANY(g.scopes))`,
      [
        userId,
        type,
        JSON.stringify({ type, data: { userId, ...data } }),
        EVENT_SCOPE[type] ?? null,
      ],
    );
    return rowCount ?? 0;
  } catch (err) {
    ctx.log.warn({ err }, 'webhook enqueue failed');
    return 0;
  }
}

/**
 * post.created for a freshly stored, approved post. Runs on the caller's transaction client so the event exists iff the
 * post does. Only public, non-community posts of users who granted an app `posts:read` produce deliveries.
 */
export async function enqueuePostCreated(db: Queryable, postId: string): Promise<void> {
  await db.query(
    `INSERT INTO webhook_deliveries (endpoint_id, event_type, payload)
     SELECT we.id, 'post.created',
            jsonb_build_object('type','post.created','data', jsonb_build_object('userId', p.author_id, 'postId', p.id, 'kind', p.kind, 'createdAt', p.created_at))
       FROM posts p
       JOIN users u ON u.id = p.author_id AND u.status = 'active' AND u.age_band = 'adult'
       JOIN oauth_grants g ON g.user_id = p.author_id AND g.revoked_at IS NULL AND 'posts:read' = ANY(g.scopes)
       JOIN developer_apps a ON a.id = g.app_id AND a.status = 'active'
       JOIN webhook_endpoints we ON we.app_id = a.id AND we.active AND 'post.created' = ANY(we.events)
      WHERE p.id = $1 AND p.visibility = 'public' AND p.community_id IS NULL AND p.moderation_status = 'approved' AND p.deleted_at IS NULL`,
    [postId],
  );
}

export async function queueTestEvent(ctx: AppContext, endpointId: string): Promise<string> {
  const { rows } = await ctx.db.query(
    `INSERT INTO webhook_deliveries (endpoint_id, event_type, payload) VALUES ($1,'ping',$2::jsonb) RETURNING id`,
    [endpointId, JSON.stringify({ type: 'ping', data: { message: 'Hello from YAPILAPI' } })],
  );
  return rows[0].id;
}

// ------------------------------------------------------------------ delivery worker

export interface DeliverOptions {
  limit?: number;
  now?: Date;
  lookup?: LookupAll;
  transport?: WebhookTransport;
  timeoutMs?: number;
}
export interface DeliverResult {
  attempted: number;
  succeeded: number;
  retried: number;
  failed: number;
}

interface Claimed {
  id: string;
  endpoint_id: string;
  event_type: string;
  event_id: string;
  payload: Record<string, unknown>;
  attempts: number;
  created_at: Date;
}

/**
 * Deliver due webhooks. Safe to run concurrently (rows are claimed with SKIP LOCKED) and repeatedly (cron).
 * Every attempt re-validates the destination and re-resolves DNS, so a hostname that starts pointing at an internal
 * address after registration is refused, and the connection is pinned to the validated address.
 */
export async function deliverWebhooks(
  ctx: AppContext,
  opts: DeliverOptions = {},
): Promise<DeliverResult> {
  const net = getWebhookNetwork();
  const lookup = opts.lookup ?? net.lookup;
  const transport = opts.transport ?? net.transport;
  const now = opts.now ?? new Date();
  const result: DeliverResult = { attempted: 0, succeeded: 0, retried: 0, failed: 0 };

  const { rows } = await ctx.db.query<Claimed>(
    `UPDATE webhook_deliveries SET status = 'delivering', attempts = attempts + 1, next_attempt_at = $2::timestamptz + interval '5 minutes'
      WHERE id IN (
        SELECT id FROM webhook_deliveries
         WHERE status IN ('pending','delivering') AND next_attempt_at <= $2
         ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING id, endpoint_id, event_type, event_id, payload, attempts, created_at`,
    [opts.limit ?? 50, now],
  );

  for (const d of rows) {
    result.attempted += 1;
    const outcome = await attemptOne(ctx, d, {
      lookup,
      transport,
      now,
      timeoutMs: opts.timeoutMs ?? 5000,
    });
    if (outcome === 'succeeded') result.succeeded += 1;
    else if (outcome === 'retry') result.retried += 1;
    else result.failed += 1;
  }
  return result;
}

async function attemptOne(
  ctx: AppContext,
  d: Claimed,
  o: { lookup: LookupAll; transport: WebhookTransport; now: Date; timeoutMs: number },
): Promise<'succeeded' | 'retry' | 'failed'> {
  const { rows } = await ctx.db.query(
    `SELECT we.url, we.secret_enc, we.active, a.status AS app_status FROM webhook_endpoints we JOIN developer_apps a ON a.id = we.app_id WHERE we.id = $1`,
    [d.endpoint_id],
  );
  const ep = rows[0];
  if (!ep || !ep.active || ep.app_status !== 'active')
    return finish(ctx, d, o.now, { final: true, error: 'endpoint_inactive' });

  let statusCode: number | null = null;
  let error: string | null = null;
  let permanent = false;
  try {
    const url = validateWebhookUrl(ep.url);
    const address = await resolvePublicAddress(url.hostname, o.lookup);
    const secret = decrypt(ep.secret_enc, ctx.config.dataEncryptionKey, webhookAad(d.endpoint_id));
    const body = JSON.stringify({
      id: d.event_id,
      type: d.event_type,
      createdAt: d.created_at.toISOString(),
      ...(d.payload as object),
    });
    const res = await o.transport({
      url,
      address,
      timeoutMs: o.timeoutMs,
      body,
      headers: {
        'content-type': 'application/json',
        'user-agent': 'YAPILAPI-Webhooks/1.0',
        'x-yapilapi-event': d.event_type,
        'x-yapilapi-delivery': d.id,
        'x-yapilapi-signature': signWebhook(secret, body, Math.floor(o.now.getTime() / 1000)),
      },
    });
    statusCode = res.status;
    if (res.status >= 200 && res.status < 300)
      return finish(ctx, d, o.now, { final: false, ok: true, statusCode });
    error = res.status >= 300 && res.status < 400 ? 'redirect_not_followed' : `http_${res.status}`;
    // 4xx (other than 408/429) means the receiver rejected the request; retrying will not change that.
    permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
  } catch (e) {
    if (e instanceof WebhookUrlError) {
      error = `blocked_destination:${e.reason}`;
      permanent = e.reason !== 'dns_failure';
    } else {
      error = e instanceof Error ? e.message.slice(0, 200) : 'network_error';
    }
  }
  const delay = nextRetryDelaySec(d.attempts);
  return finish(ctx, d, o.now, {
    final: permanent || delay === null,
    ok: false,
    statusCode,
    error,
    retryInSec: delay,
  });
}

async function finish(
  ctx: AppContext,
  d: Claimed,
  now: Date,
  r: {
    final: boolean;
    ok?: boolean;
    statusCode?: number | null;
    error?: string | null;
    retryInSec?: number | null;
  },
): Promise<'succeeded' | 'retry' | 'failed'> {
  if (r.ok) {
    await ctx.db.query(
      `UPDATE webhook_deliveries SET status = 'succeeded', delivered_at = $2, last_status_code = $3, last_error = NULL WHERE id = $1`,
      [d.id, now, r.statusCode ?? null],
    );
    await ctx.db.query(
      'UPDATE webhook_endpoints SET consecutive_failures = 0 WHERE id = $1 AND consecutive_failures <> 0',
      [d.endpoint_id],
    );
    return 'succeeded';
  }
  if (r.final) {
    await ctx.db.query(
      `UPDATE webhook_deliveries SET status = 'failed', last_status_code = $2, last_error = $3 WHERE id = $1`,
      [d.id, r.statusCode ?? null, r.error ?? null],
    );
  } else {
    await ctx.db.query(
      `UPDATE webhook_deliveries SET status = 'pending', last_status_code = $2, last_error = $3, next_attempt_at = $4::timestamptz + make_interval(secs => $5) WHERE id = $1`,
      [d.id, r.statusCode ?? null, r.error ?? null, now, r.retryInSec ?? 60],
    );
  }
  // A receiver that keeps failing is switched off so it cannot consume the queue forever; the owner sees why.
  const upd = await ctx.db.query(
    `UPDATE webhook_endpoints SET consecutive_failures = consecutive_failures + 1,
            active = CASE WHEN consecutive_failures + 1 >= $2 THEN false ELSE active END,
            disabled_reason = CASE WHEN consecutive_failures + 1 >= $2 THEN 'too_many_failures' ELSE disabled_reason END
      WHERE id = $1 RETURNING consecutive_failures = $2 AS just_disabled, (SELECT owner_id FROM developer_apps WHERE id = app_id) AS owner_id`,
    [d.endpoint_id, DISABLE_AFTER_CONSECUTIVE_FAILURES],
  );
  if (upd.rows[0]?.just_disabled && upd.rows[0].owner_id) {
    await notify(ctx, {
      userId: upd.rows[0].owner_id,
      kind: 'webhook_endpoint_disabled',
      targetType: 'webhook_endpoint',
      targetId: d.endpoint_id,
      data: { reason: 'too_many_failures' },
    }).catch(() => undefined);
  }
  return r.final ? 'failed' : 'retry';
}

/** Housekeeping: keep 30 days of delivery history. */
export async function purgeOldDeliveries(ctx: AppContext): Promise<number> {
  const r = await ctx.db.query(
    `DELETE FROM webhook_deliveries WHERE status IN ('succeeded','failed') AND created_at < now() - interval '30 days'`,
  );
  return r.rowCount ?? 0;
}
