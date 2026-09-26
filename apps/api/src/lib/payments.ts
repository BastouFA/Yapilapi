import Stripe from 'stripe';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export interface PaymentIntent {
  providerRef: string;
  status: 'requires_action' | 'succeeded' | 'failed';
  /** What the client needs to complete payment (e.g. a hosted checkout URL). */
  clientSecret: string;
}

export interface WebhookEvent {
  id: string;
  type: 'payment.succeeded' | 'payment.failed' | 'refund.succeeded';
  providerRef: string;
  amountCents?: number;
}

/**
 * Payment provider abstraction. Card data never touches YAPILAPI servers:
 * the provider hosts collection; we store only provider references.
 */
export interface PaymentProvider {
  name: string;
  createIntent(input: { amountCents: number; currency: string; orderId: string; idempotencyKey: string }): Promise<PaymentIntent>;
  refund(input: { providerRef: string; amountCents: number }): Promise<{ status: 'succeeded' | 'failed' }>;
  /** Check the provider's signature and map the event. Returns null for event types we don't act on. */
  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): WebhookEvent | null;
  /** What the browser needs to show the provider's payment form (never a secret key). */
  publicConfig(): { provider: string; publishableKey?: string };
}

/** Development sandbox: intents start in requires_action; a signed webhook completes them. */
export function devPaymentProvider(secret: string): PaymentProvider {
  const sign = (body: string) => createHmac('sha256', secret).update(body).digest('hex');
  return {
    name: 'dev',
    async createIntent({ orderId }) {
      return { providerRef: `dev_pi_${randomUUID()}`, status: 'requires_action', clientSecret: `dev_secret_${orderId}` };
    },
    async refund() {
      return { status: 'succeeded' };
    },
    publicConfig() {
      return { provider: 'dev' };
    },
    verifyWebhook(rawBody, headers) {
      const signature = headers['x-signature'];
      const expected = Buffer.from(sign(rawBody));
      const got = Buffer.from(typeof signature === 'string' ? signature : '');
      if (expected.length !== got.length || !timingSafeEqual(expected, got)) throw new Error('bad signature');
      return JSON.parse(rawBody) as WebhookEvent;
    },
  };
}

export function signDevWebhook(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/** Currencies Stripe charges in whole units (no minor unit). Our amounts are always in hundredths. */
const ZERO_DECIMAL = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
const toStripeAmount = (cents: number, currency: string) => (ZERO_DECIMAL.has(currency.toUpperCase()) ? Math.round(cents / 100) : cents);
const fromStripeAmount = (amount: number, currency: string) => (ZERO_DECIMAL.has(currency.toUpperCase()) ? amount * 100 : amount);

/**
 * Stripe: PaymentIntents collected with Stripe's Payment Element in the
 * browser (card data goes straight to Stripe), confirmed by signed webhooks
 * (payment_intent.succeeded / payment_failed, charge.refunded).
 */
export function stripePaymentProvider(opts: { secretKey: string; webhookSecret: string; publishableKey: string }): PaymentProvider {
  const stripe = new Stripe(opts.secretKey, { maxNetworkRetries: 2, timeout: 20_000 });
  return {
    name: 'stripe',
    async createIntent({ amountCents, currency, orderId, idempotencyKey }) {
      const pi = await stripe.paymentIntents.create(
        {
          amount: toStripeAmount(amountCents, currency),
          currency: currency.toLowerCase(),
          metadata: { orderId },
          automatic_payment_methods: { enabled: true },
        },
        { idempotencyKey: `pi_${idempotencyKey}_${orderId}` },
      );
      return { providerRef: pi.id, status: pi.status === 'succeeded' ? 'succeeded' : 'requires_action', clientSecret: pi.client_secret ?? '' };
    },
    async refund({ providerRef, amountCents }) {
      const pi = await stripe.paymentIntents.retrieve(providerRef);
      const r = await stripe.refunds.create({ payment_intent: providerRef, amount: toStripeAmount(amountCents, pi.currency) });
      return { status: r.status === 'succeeded' || r.status === 'pending' ? 'succeeded' : 'failed' };
    },
    publicConfig() {
      return { provider: 'stripe', publishableKey: opts.publishableKey };
    },
    verifyWebhook(rawBody, headers) {
      const sig = headers['stripe-signature'];
      const event = stripe.webhooks.constructEvent(rawBody, typeof sig === 'string' ? sig : '', opts.webhookSecret);
      if (event.type === 'payment_intent.succeeded' || event.type === 'payment_intent.payment_failed') {
        const pi = event.data.object;
        return {
          id: event.id,
          type: event.type === 'payment_intent.succeeded' ? 'payment.succeeded' : 'payment.failed',
          providerRef: pi.id,
          amountCents: fromStripeAmount(pi.amount_received || pi.amount, pi.currency),
        };
      }
      if (event.type === 'charge.refunded') {
        const ch = event.data.object;
        const ref = typeof ch.payment_intent === 'string' ? ch.payment_intent : ch.payment_intent?.id;
        return ref ? { id: event.id, type: 'refund.succeeded', providerRef: ref } : null;
      }
      return null;
    },
  };
}
