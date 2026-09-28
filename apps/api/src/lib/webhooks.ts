import { createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import type { Pool, PoolClient } from 'pg';
import { BlockedUrlError, checkOutboundUrl, isPrivateIp, safeFetch, systemResolve, type Resolve, type SafeFetchDeps } from './safe-fetch.ts';

type Q = Pool | PoolClient;

export const WEBHOOK_EVENTS = ['post.created', 'follower.new', 'event.rsvp', 'order.paid', 'ping'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

const MAX_ATTEMPTS = 8;

export function newWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString('base64url')}`;
}

/** Signature header: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">`. */
export function signWebhook(secret: string, body: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

/** Queue an event for every active subscription of apps owned by this user. Never throws. */
export async function emitWebhook(db: Q, ownerId: string, event: WebhookEvent, data: object): Promise<void> {
  try {
    await db.query(
      `INSERT INTO webhook_deliveries (subscription_id, event, payload)
       SELECT s.id, $2, jsonb_build_object('id', gen_random_uuid(), 'type', $2::text, 'createdAt', now(), 'data', $3::jsonb)
       FROM webhook_subscriptions s JOIN developer_apps a ON a.id = s.app_id
       WHERE a.owner_id = $1 AND a.deleted_at IS NULL AND s.active AND $2 = ANY(s.events)`,
      [ownerId, event, JSON.stringify(data)],
    );
  } catch {
    /* webhooks must never break the action that triggered them */
  }
}

/**
 * Checked when a subscription is made, so a developer hears at once about a URL that can't work:
 * https only and every address the host resolves to must be public. Development/test: http to
 * localhost is allowed so developers can test locally. Delivery checks again, on the connection
 * itself (lib/safe-fetch.ts), since DNS can change in between.
 */
export async function assertSafeWebhookUrl(
  raw: string,
  allowLocal: boolean,
  /** Looks up a host's addresses (tests pass a fake). */
  resolve: Resolve = systemResolve,
): Promise<URL> {
  const { url, local } = checkOutboundUrl(raw, { allowLocal, label: 'Webhook URLs' });
  if (local) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [host] : await resolve(host).catch(() => []);
  if (!addrs.length) throw new BlockedUrlError("That host doesn't resolve.");
  if (addrs.some(isPrivateIp)) throw new BlockedUrlError('Webhook URLs must point to a public address.');
  return url;
}

/**
 * Deliver due webhooks. Safe to run on several instances at once (SKIP LOCKED).
 * Retries with exponential backoff (1, 2, 4 … minutes) and gives up after 8 attempts. Each delivery
 * goes through safeFetch: the connection goes only to addresses checked as public, and redirects
 * are not followed (a 3xx counts as a failure).
 */
export async function processWebhooks(db: Pool, opts: { allowLocal: boolean; deps?: SafeFetchDeps; batch?: number }): Promise<number> {
  const client = await db.connect();
  let n = 0;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT d.id, d.event, d.payload, d.attempts, s.url, s.secret FROM webhook_deliveries d
       JOIN webhook_subscriptions s ON s.id = d.subscription_id
       WHERE d.status = 'pending' AND d.next_attempt_at <= now() AND s.active
       ORDER BY d.next_attempt_at LIMIT $1 FOR UPDATE OF d SKIP LOCKED`,
      [opts.batch ?? 20],
    );
    for (const d of rows) {
      n++;
      const body = JSON.stringify(d.payload);
      let code: number | null = null;
      let error: string | null = null;
      try {
        const res = await safeFetch(
          d.url,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'user-agent': 'YAPILAPI-Webhooks/1',
              'x-yapilapi-event': d.event,
              'x-yapilapi-signature': signWebhook(d.secret, body),
            },
            body,
            maxRedirects: 0,
            allowLocal: opts.allowLocal,
            label: 'Webhook URLs',
            signal: AbortSignal.timeout(10_000),
          },
          opts.deps,
        );
        await res.body?.cancel().catch(() => {});
        code = res.status;
        if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
      } catch (e) {
        error = (e as Error).message.slice(0, 300);
      }
      const attempts = d.attempts + 1;
      if (!error)
        await client.query(
          `UPDATE webhook_deliveries SET status = 'delivered', attempts = $2, response_code = $3, delivered_at = now(), last_error = NULL WHERE id = $1`,
          [d.id, attempts, code],
        );
      else
        await client.query(
          `UPDATE webhook_deliveries SET attempts = $2::int, response_code = $3, last_error = $4,
             status = CASE WHEN $2::int >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'pending' END,
             next_attempt_at = now() + make_interval(mins => power(2, $2::int - 1)::int) WHERE id = $1`,
          [d.id, attempts, code, error],
        );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return n;
}
