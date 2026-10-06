import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type Stripe from 'stripe';
import { ensureStripeWebhook, isStripeWebhookSecret, STRIPE_WEBHOOK_EVENTS, stripeWebhookUrl } from '../src/lib/stripe-webhook-setup.ts';
import type { BuiltApp } from '../src/app.ts';
import { testApp } from './helpers.ts';

let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.ctx.db.query(`DELETE FROM deployment_secrets WHERE name = 'stripe_webhook'`);
  await t.close();
});
beforeEach(async () => {
  await t.ctx.db.query(`DELETE FROM deployment_secrets WHERE name = 'stripe_webhook'`);
});

/** A stand-in for Stripe's webhook endpoints API. */
function fakeStripe(initial: { id: string; url: string }[] = []) {
  const endpoints = [...initial];
  const calls = { created: 0, deleted: [] as string[], events: [] as string[][] };
  const stripe = {
    webhookEndpoints: {
      list: async () => ({ data: endpoints.map((e) => ({ ...e })) }),
      del: async (id: string) => {
        calls.deleted.push(id);
        endpoints.splice(
          endpoints.findIndex((e) => e.id === id),
          1,
        );
      },
      create: async (p: { url: string; enabled_events: string[] }) => {
        calls.created++;
        calls.events.push(p.enabled_events);
        const ep = { id: `we_${calls.created}`, url: p.url, secret: `whsec_test_${calls.created}` };
        endpoints.push({ id: ep.id, url: ep.url });
        return ep;
      },
    },
  } as unknown as Stripe;
  return { stripe, calls, endpoints };
}

const key = Buffer.alloc(32, 7).toString('base64');
const url = 'https://api.example.test/v1/payments/webhook/stripe';

describe('setting up the Stripe webhook without a pasted secret', () => {
  it('knows a pasted secret from a placeholder, and finds its address on Render', () => {
    expect(isStripeWebhookSecret('whsec_abc')).toBe(true);
    expect(isStripeWebhookSecret('pending')).toBe(false);
    expect(isStripeWebhookSecret('')).toBe(false);
    expect(stripeWebhookUrl({ RENDER_EXTERNAL_URL: 'https://yapilapi-api.onrender.com/' })).toBe(
      'https://yapilapi-api.onrender.com/v1/payments/webhook/stripe',
    );
    expect(stripeWebhookUrl({ STRIPE_WEBHOOK_URL: url, RENDER_EXTERNAL_URL: 'https://x.onrender.com' })).toBe(url);
    expect(stripeWebhookUrl({})).toBeNull();
  });

  it('makes one endpoint for the events the API handles, keeps its secret encrypted, and reuses it', async () => {
    const f = fakeStripe();
    const secret = await ensureStripeWebhook({ db: t.ctx.db, stripe: f.stripe, url, mfaKey: key });
    expect(secret).toBe('whsec_test_1');
    expect(f.calls.events[0]).toEqual([...STRIPE_WEBHOOK_EVENTS]);
    const stored = (await t.ctx.db.query(`SELECT value FROM deployment_secrets WHERE name = 'stripe_webhook'`)).rows[0].value as string;
    expect(stored).not.toContain('whsec_test_1');

    // The next start uses the stored secret without asking Stripe for a new endpoint.
    expect(await ensureStripeWebhook({ db: t.ctx.db, stripe: f.stripe, url, mfaKey: key })).toBe('whsec_test_1');
    expect(f.calls.created).toBe(1);
  });

  it('replaces an endpoint for the same address whose secret is not known, and starts again for a new address', async () => {
    const f = fakeStripe([
      { id: 'we_old', url },
      { id: 'we_other', url: 'https://elsewhere.example.test/hook' },
    ]);
    expect(await ensureStripeWebhook({ db: t.ctx.db, stripe: f.stripe, url, mfaKey: key })).toBe('whsec_test_1');
    expect(f.calls.deleted).toEqual(['we_old']);
    expect(f.endpoints.map((e) => e.id).sort()).toEqual(['we_1', 'we_other']);

    const moved = 'https://yapilapi.example.test/v1/payments/webhook/stripe';
    expect(await ensureStripeWebhook({ db: t.ctx.db, stripe: f.stripe, url: moved, mfaKey: key })).toBe('whsec_test_2');
  });

  it('makes a single endpoint when two instances start at once', async () => {
    const f = fakeStripe();
    const [a, b] = await Promise.all([
      ensureStripeWebhook({ db: t.ctx.db, stripe: f.stripe, url, mfaKey: key }),
      ensureStripeWebhook({ db: t.ctx.db, stripe: f.stripe, url, mfaKey: key }),
    ]);
    expect(a).toBe(b);
    expect(f.calls.created).toBe(1);
  });
});
