import { createHmac, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Pool, PoolClient } from 'pg';

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

function isPrivateIp(ip: string): boolean {
  if (ip.includes(':')) {
    const l = ip.toLowerCase();
    return (
      l === '::1' ||
      l.startsWith('fc') ||
      l.startsWith('fd') ||
      l.startsWith('fe80') ||
      l === '::' ||
      l.startsWith('::ffff:127.') ||
      l.startsWith('::ffff:10.') ||
      l.startsWith('::ffff:192.168.')
    );
  }
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/**
 * SSRF guard. Production: https only and the host must resolve to public addresses.
 * Development/test: http to localhost is allowed so developers can test locally.
 */
export async function assertSafeWebhookUrl(raw: string, allowLocal: boolean): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Enter a full URL, like https://example.com/webhooks.');
  }
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (allowLocal && local) return url;
  if (url.protocol !== 'https:') throw new Error('Webhook URLs must use https.');
  if (url.username || url.password) throw new Error('Webhook URLs cannot contain credentials.');
  const addrs = isIP(url.hostname) ? [url.hostname] : (await lookup(url.hostname, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addrs.length) throw new Error("That host doesn't resolve.");
  if (addrs.some(isPrivateIp)) throw new Error('Webhook URLs must point to a public address.');
  return url;
}

/**
 * Deliver due webhooks. Safe to run on several instances at once (SKIP LOCKED).
 * Retries with exponential backoff (1, 2, 4 … minutes) and gives up after 8 attempts.
 */
export async function processWebhooks(db: Pool, opts: { allowLocal: boolean; fetchImpl?: typeof fetch; batch?: number }): Promise<number> {
  const f = opts.fetchImpl ?? fetch;
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
        await assertSafeWebhookUrl(d.url, opts.allowLocal);
        const res = await f(d.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': 'YAPILAPI-Webhooks/1',
            'x-yapilapi-event': d.event,
            'x-yapilapi-signature': signWebhook(d.secret, body),
          },
          body,
          redirect: 'manual',
          signal: AbortSignal.timeout(10_000),
        });
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
