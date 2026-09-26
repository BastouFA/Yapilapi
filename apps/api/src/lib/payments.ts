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
  /** ISO 4217, upper case. When present it must match the payment's currency. */
  currency?: string;
}

/**
 * Payment provider abstraction. Card data never touches YAPILAPI servers:
 * the provider hosts collection; we store only provider references.
 */
export interface PaymentProvider {
  name: string;
  /** The currencies this provider takes. Unset: any currency (the default provider). */
  currencies?: readonly string[];
  createIntent(input: {
    amountCents: number;
    currency: string;
    orderId: string;
    idempotencyKey: string;
    /** The buyer's email, for providers that send their own receipt (Paystack). */
    email?: string;
  }): Promise<PaymentIntent>;
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
          currency: pi.currency.toUpperCase(),
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

/** Currencies Paystack settles: Nigeria, Ghana, Kenya and South Africa (cards and mobile money). */
export const PAYSTACK_CURRENCIES = ['NGN', 'GHS', 'KES', 'ZAR'] as const;

/**
 * Paystack: a transaction is initialized on our server and the buyer pays on
 * Paystack's hosted checkout (authorization_url), with a card, bank or mobile
 * money. The signed webhook (charge.success, refund.processed) confirms it.
 * Amounts are in the currency's subunit (kobo, pesewas, cents), which is how
 * we store them already. `fetch` is injectable so tests never call Paystack.
 */
export function paystackPaymentProvider(opts: {
  secretKey: string;
  publicKey: string;
  /** Where Paystack sends the buyer after paying (the web app shows "you can close this"). */
  callbackUrl?: string;
  fetch?: typeof fetch;
  baseUrl?: string;
}): PaymentProvider {
  const f = opts.fetch ?? fetch;
  const base = opts.baseUrl ?? 'https://api.paystack.co';
  async function call<T>(path: string, body: unknown): Promise<T> {
    const res = await f(`${base}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${opts.secretKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => null)) as { status?: boolean; message?: string; data?: T } | null;
    if (!res.ok || !json?.status || !json.data) throw new Error(`Paystack ${path} failed: ${json?.message ?? res.status}`);
    return json.data;
  }
  return {
    name: 'paystack',
    currencies: PAYSTACK_CURRENCIES,
    async createIntent({ amountCents, currency, orderId, email }) {
      if (!email) throw new Error('Paystack needs the buyer email.');
      // One reference per order (Paystack allows letters, digits, - . and =), so an order can never be charged twice.
      const reference = `ypl-${orderId}`;
      const data = await call<{ authorization_url: string; reference: string }>('/transaction/initialize', {
        email,
        amount: amountCents,
        currency: currency.toUpperCase(),
        reference,
        callback_url: opts.callbackUrl,
        metadata: { orderId },
      });
      return { providerRef: data.reference, status: 'requires_action', clientSecret: data.authorization_url };
    },
    async refund({ providerRef, amountCents }) {
      try {
        const data = await call<{ status?: string }>('/refund', { transaction: providerRef, amount: amountCents });
        return { status: data.status === 'failed' ? 'failed' : 'succeeded' };
      } catch {
        return { status: 'failed' };
      }
    },
    publicConfig() {
      return { provider: 'paystack', publishableKey: opts.publicKey };
    },
    verifyWebhook(rawBody, headers) {
      const signature = headers['x-paystack-signature'];
      const expected = Buffer.from(createHmac('sha512', opts.secretKey).update(rawBody).digest('hex'));
      const got = Buffer.from(typeof signature === 'string' ? signature : '');
      if (expected.length !== got.length || !timingSafeEqual(expected, got)) throw new Error('bad signature');
      const event = JSON.parse(rawBody) as {
        event: string;
        data: {
          id?: number | string;
          reference?: string;
          amount?: number;
          currency?: string;
          status?: string;
          transaction_reference?: string;
          transaction?: { reference?: string };
        };
      };
      const d = event.data ?? {};
      if (event.event === 'charge.success' && d.reference)
        return {
          id: `paystack:charge.success:${d.id ?? d.reference}`,
          type: 'payment.succeeded',
          providerRef: d.reference,
          amountCents: typeof d.amount === 'number' ? d.amount : undefined,
          currency: d.currency?.toUpperCase(),
        };
      if (event.event === 'charge.failed' && d.reference)
        return { id: `paystack:charge.failed:${d.id ?? d.reference}`, type: 'payment.failed', providerRef: d.reference };
      if (event.event === 'refund.processed') {
        const ref = d.transaction_reference ?? d.transaction?.reference;
        return ref ? { id: `paystack:refund.processed:${d.id ?? ref}`, type: 'refund.succeeded', providerRef: ref } : null;
      }
      return null;
    },
  };
}

export function signPaystackWebhook(secretKey: string, body: string): string {
  return createHmac('sha512', secretKey).update(body).digest('hex');
}

/**
 * The payment providers this server uses. PAYMENTS_PROVIDER is the default;
 * a provider with its own currencies (Paystack) takes the orders in those
 * currencies. Refunds and webhooks go to the provider that took the payment.
 */
export interface PaymentRegistry {
  default: PaymentProvider;
  forCurrency(currency: string): PaymentProvider;
  byName(name: string): PaymentProvider | undefined;
  /** What the browser needs: the default provider, and the others with their currencies. */
  publicConfig(): { provider: string; publishableKey?: string; providers?: { provider: string; publishableKey?: string; currencies: string[] }[] };
}

export function paymentRegistry(defaultProvider: PaymentProvider, others: PaymentProvider[] = []): PaymentRegistry {
  const all = [defaultProvider, ...others.filter((p) => p.name !== defaultProvider.name)];
  return {
    default: defaultProvider,
    forCurrency(currency) {
      const c = currency.toUpperCase();
      return others.find((p) => p.currencies?.includes(c)) ?? defaultProvider;
    },
    byName: (name) => all.find((p) => p.name === name),
    publicConfig() {
      const base = defaultProvider.publicConfig();
      const extra = others.filter((p) => p.currencies?.length).map((p) => ({ ...p.publicConfig(), currencies: [...(p.currencies ?? [])] }));
      return extra.length ? { ...base, providers: extra } : base;
    },
  };
}
