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
  verifyWebhook(rawBody: string, signature: string | undefined): WebhookEvent;
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
    verifyWebhook(rawBody, signature) {
      const expected = Buffer.from(sign(rawBody));
      const got = Buffer.from(signature ?? '');
      if (expected.length !== got.length || !timingSafeEqual(expected, got)) throw new Error('bad signature');
      return JSON.parse(rawBody) as WebhookEvent;
    },
  };
}

export function signDevWebhook(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}
