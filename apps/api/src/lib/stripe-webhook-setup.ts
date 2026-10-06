import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type Stripe from 'stripe';
import { decrypt, encrypt } from '@yapilapi/auth';
import { tx } from '@yapilapi/database';

/** The events the Stripe provider acts on (lib/payments.ts). */
export const STRIPE_WEBHOOK_EVENTS = [
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'charge.refunded',
  'charge.dispute.created',
  'transfer.reversed',
] as const;

const SECRET_NAME = 'stripe_webhook';

/** A real signing secret pasted from the Stripe Dashboard, rather than "pending" or nothing. */
export const isStripeWebhookSecret = (value: string) => value.startsWith('whsec_');

/** Where Stripe should send events: STRIPE_WEBHOOK_URL, or this API's own address on Render. */
export function stripeWebhookUrl(env: { STRIPE_WEBHOOK_URL?: string; RENDER_EXTERNAL_URL?: string }): string | null {
  if (env.STRIPE_WEBHOOK_URL) return env.STRIPE_WEBHOOK_URL;
  return env.RENDER_EXTERNAL_URL ? `${env.RENDER_EXTERNAL_URL.replace(/\/+$/, '')}/v1/payments/webhook/stripe` : null;
}

/** The key the stored secret is encrypted with: MFA_ENCRYPTION_KEY, or a fixed key outside production. */
function sealKey(mfaKey: string): Buffer {
  const k = Buffer.from(mfaKey, 'base64');
  return k.length === 32 ? k : createHash('sha256').update('yapilapi-development-webhook-key').digest();
}

/**
 * When no signing secret was pasted (STRIPE_WEBHOOK_SECRET is "pending" or empty), the API sets up
 * its own Stripe webhook with its secret key and keeps the signing secret Stripe returns, encrypted,
 * in deployment_secrets. Stripe shows a secret only when the endpoint is made, so an endpoint for the
 * same address whose secret was lost is replaced. Under a lock, so two instances starting together
 * make one endpoint. Returns the signing secret.
 */
export async function ensureStripeWebhook(deps: { db: Pool; stripe: Stripe; url: string; mfaKey: string }): Promise<string> {
  const key = sealKey(deps.mfaKey);
  return tx(deps.db, async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('stripe_webhook_setup'))`);
    const stored = (await c.query<{ value: string }>(`SELECT value FROM deployment_secrets WHERE name = $1`, [SECRET_NAME])).rows[0];
    if (stored) {
      const saved = JSON.parse(stored.value) as { url: string; endpointId: string; secret: string };
      if (saved.url === deps.url) return decrypt(key, Buffer.from(saved.secret, 'base64')).toString('utf8');
    }
    // Endpoints for this address made before (their secrets aren't known any more) give way to a new one.
    const existing = await deps.stripe.webhookEndpoints.list({ limit: 100 });
    for (const ep of existing.data) if (ep.url === deps.url) await deps.stripe.webhookEndpoints.del(ep.id);
    const made = await deps.stripe.webhookEndpoints.create({
      url: deps.url,
      enabled_events: [...STRIPE_WEBHOOK_EVENTS],
      description: 'YAPILAPI (set up automatically by the API)',
    });
    if (!made.secret) throw new Error('Stripe did not return a signing secret for the new webhook.');
    const value = JSON.stringify({ url: deps.url, endpointId: made.id, secret: encrypt(key, Buffer.from(made.secret)).toString('base64') });
    await c.query(`INSERT INTO deployment_secrets (name, value) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, created_at = now()`, [
      SECRET_NAME,
      value,
    ]);
    return made.secret;
  });
}
