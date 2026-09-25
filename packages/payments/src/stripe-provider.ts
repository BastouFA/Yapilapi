import { hmacSha256Hex, safeEqual } from '@yapilapi/security';
import { PaymentProviderError, WebhookSignatureError } from './errors.js';
import { isPaymentMethodRef } from './card-guard.js';
import type {
  ConnectedAccountInput,
  ConnectedAccountResult,
  CreatePaymentInput,
  IntentStatus,
  KycStatus,
  NormalisedEvent,
  PaymentIntentResult,
  PaymentMethodInfo,
  PaymentProvider,
  PayoutInput,
  PayoutResult,
  ProviderRecord,
  RefundInput,
  RefundResult,
} from './types.js';

export const STRIPE_API_VERSION = '2024-06-20';
export const STRIPE_SIGNATURE_HEADER = 'stripe-signature';

export interface StripeOptions {
  secretKey: string;
  webhookSecret: string;
  baseUrl?: string;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  toleranceSeconds?: number;
  now?: () => Date;
  timeoutMs?: number;
}

type Form = Record<string, unknown>;

/** The `error` object of a Stripe error response (only the fields we read). */
interface StripeApiError {
  message?: unknown;
  code?: unknown;
  type?: unknown;
  payment_intent?: unknown;
}

/** Card details Stripe attaches to a payment method (only the fields we read). */
interface StripeCardDetails {
  fingerprint?: string | null;
  country?: string | null;
  brand?: string | null;
}

/**
 * The subset of a Stripe API object (payment intent, refund, dispute, transfer, account, payment method, account link) that
 * this adapter reads. Every field is optional because which ones are present depends on the object type.
 */
interface StripeObject {
  id: string;
  status?: string;
  amount?: number;
  amount_received?: number;
  currency?: string;
  created?: number;
  metadata?: unknown;
  client_secret?: unknown;
  last_payment_error?: {
    code?: unknown;
    decline_code?: unknown;
    payment_method?: { card?: StripeCardDetails | null } | null;
  } | null;
  next_action?: { type?: unknown; redirect_to_url?: { url?: string | null } | null } | null;
  payment_intent?: string | null;
  failure_reason?: string | null;
  reason?: string | null;
  reversed?: boolean;
  requirements?: { disabled_reason?: unknown } | null;
  payouts_enabled?: unknown;
  details_submitted?: unknown;
  card?: StripeCardDetails | null;
  url?: string | null;
}

/** A Stripe webhook event envelope (only the fields we read). */
export interface StripeEvent {
  id: string;
  type: string;
  created?: unknown;
  data: { object: Record<string, unknown> };
}

/** Objects returned by the list endpoints always carry an amount and a creation time. */
interface StripeListObject extends StripeObject {
  amount: number;
  created: number;
}

/** Stripe's form encoding: nested objects become `a[b]=c`, arrays `a[0]=c`. Undefined/null values are omitted. */
export function encodeStripeForm(data: Form): string {
  const pairs: string[] = [];
  const walk = (prefix: string, v: unknown) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(`${prefix}[${i}]`, x));
    else if (typeof v === 'object')
      for (const [k, x] of Object.entries(v as Form)) walk(`${prefix}[${k}]`, x);
    else pairs.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(v))}`);
  };
  for (const [k, v] of Object.entries(data)) walk(k, v);
  return pairs.join('&');
}

/** Parse `t=...,v1=...,v1=...,v0=...`. Stripe may send several v1 values during secret rotation. */
export function parseStripeSignature(header: string): { t: number; v1: string[] } | null {
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) return null;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't') t = Number(v);
    else if (k === 'v1') v1.push(v);
  }
  if (t === null || !Number.isInteger(t) || t <= 0 || !v1.length) return null;
  return { t, v1 };
}

/**
 * Verify a Stripe webhook exactly like Stripe's libraries: HMAC-SHA256 of `${t}.${rawBody}` with the endpoint secret, compared
 * in constant time against every `v1` signature, and reject timestamps outside the tolerance (replay protection).
 */
export function verifyStripeSignature(opts: {
  secret: string;
  header: string | undefined;
  rawBody: string;
  toleranceSeconds?: number;
  nowSec?: number;
}): void {
  if (!opts.header)
    throw new WebhookSignatureError('Missing Stripe-Signature header', 'missing_header');
  const parsed = parseStripeSignature(opts.header);
  if (!parsed)
    throw new WebhookSignatureError('Malformed Stripe-Signature header', 'malformed_header');
  const expected = hmacSha256Hex(opts.secret, `${parsed.t}.${opts.rawBody}`);
  // Check the signature before the timestamp so that timing does not reveal which failed.
  const match = parsed.v1.some((s) => safeEqual(expected, s));
  if (!match) throw new WebhookSignatureError('Invalid Stripe signature', 'bad_signature');
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - parsed.t) > (opts.toleranceSeconds ?? 300))
    throw new WebhookSignatureError(
      'Stripe webhook timestamp outside tolerance',
      'stale_timestamp',
    );
}

/** Compute a Stripe-Signature header (used by tests and by anyone forging fixtures). */
export function signStripePayload(secret: string, rawBody: string, t: number): string {
  return `t=${t},v1=${hmacSha256Hex(secret, `${t}.${rawBody}`)}`;
}

const INTENT_STATUS: Record<string, IntentStatus> = {
  requires_payment_method: 'requires_payment_method',
  requires_confirmation: 'requires_payment_method',
  requires_action: 'requires_action',
  processing: 'processing',
  requires_capture: 'processing',
  succeeded: 'succeeded',
  canceled: 'canceled',
};

/**
 * Stripe adapter over the REST API with fetch (no SDK). Platform model: "separate charges and transfers": customers pay the
 * platform, our ledger tracks each seller's payable, and payouts are Stripe Transfers to the seller's connected account.
 * This adapter cannot be exercised against the live API in this repository: request construction and webhook verification are
 * unit-tested; everything else needs real credentials (see docs/architecture/payments.md).
 */
export class StripePaymentProvider implements PaymentProvider {
  readonly name = 'stripe' as const;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: StripeOptions) {
    if (!opts.secretKey || !opts.webhookSecret)
      throw new Error('Stripe secret key and webhook secret are required');
    this.base = (opts.baseUrl ?? 'https://api.stripe.com').replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async call<T = StripeObject>(
    method: 'GET' | 'POST',
    path: string,
    form?: Form,
    idempotencyKey?: string,
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.opts.secretKey}`,
      'stripe-version': STRIPE_API_VERSION,
    };
    let body: string | undefined;
    let url = `${this.base}${path}`;
    if (method === 'POST') {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = encodeStripeForm(form ?? {});
      if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    } else if (form && Object.keys(form).length) {
      url += `?${encodeStripeForm(form)}`;
    }
    let res: Response;
    try {
      const init: RequestInit = {
        method,
        headers,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
      };
      if (body !== undefined) init.body = body;
      res = await this.fetchImpl(url, init);
    } catch (err) {
      throw new PaymentProviderError(
        `Payment provider unreachable: ${(err as Error).name}`,
        'provider_unreachable',
        true,
      );
    }
    let json: { error?: StripeApiError } | null = null;
    try {
      json = (await res.json()) as { error?: StripeApiError } | null;
    } catch {
      /* non-JSON error body */
    }
    if (!res.ok) {
      const e: StripeApiError = json?.error ?? {};
      const retryable = res.status >= 500 || res.status === 429 || res.status === 409;
      const err = new PaymentProviderError(
        String(e.message ?? `Stripe error ${res.status}`).slice(0, 300),
        String(e.code ?? e.type ?? 'stripe_error'),
        retryable,
        res.status,
      );
      (err as PaymentProviderError & { intent?: unknown }).intent = e.payment_intent;
      throw err;
    }
    return json as T;
  }

  private intentResult(pi: StripeObject): PaymentIntentResult {
    const err = pi.last_payment_error;
    let status: IntentStatus = INTENT_STATUS[pi.status ?? ''] ?? 'processing';
    if (err && status === 'requires_payment_method') status = 'failed';
    const pmDetails = err?.payment_method?.card ?? null;
    return {
      ref: String(pi.id),
      status,
      clientSecret: typeof pi.client_secret === 'string' ? pi.client_secret : null,
      failureCode: err ? String(err.decline_code ?? err.code ?? 'payment_failed') : null,
      nextAction: pi.next_action
        ? { type: String(pi.next_action.type), url: pi.next_action.redirect_to_url?.url ?? null }
        : null,
      fingerprint: pmDetails?.fingerprint ?? null,
      cardCountry: pmDetails?.country ?? null,
    };
  }

  /** Card declines come back as HTTP 402 with the intent attached: that is a normal outcome, not an exception. */
  private async withDecline(fn: () => Promise<StripeObject>): Promise<PaymentIntentResult> {
    try {
      return this.intentResult(await fn());
    } catch (err) {
      const intent = (err as { intent?: StripeObject }).intent;
      if (err instanceof PaymentProviderError && err.httpStatus === 402 && intent?.id) {
        return {
          ...this.intentResult({
            ...intent,
            last_payment_error: intent.last_payment_error ?? { code: err.code },
          }),
          status: 'failed',
        };
      }
      throw err;
    }
  }

  createPaymentIntent(input: CreatePaymentInput): Promise<PaymentIntentResult> {
    if (input.paymentMethod && !isPaymentMethodRef(input.paymentMethod))
      throw new PaymentProviderError(
        'Invalid payment method reference',
        'invalid_payment_method',
        false,
        400,
      );
    const form: Form = {
      amount: input.amount,
      currency: input.currency.toLowerCase(),
      description: input.description,
      metadata: input.metadata,
      capture_method: 'automatic',
      'automatic_payment_methods[enabled]': 'true',
      transfer_group: input.metadata.orderId ?? input.metadata.paymentId,
    };
    if (input.paymentMethod) {
      form.payment_method = input.paymentMethod;
      form.confirm = 'true';
      if (input.returnUrl) form.return_url = input.returnUrl;
      else form['automatic_payment_methods[allow_redirects]'] = 'never';
    }
    return this.withDecline(() =>
      this.call('POST', '/v1/payment_intents', form, input.idempotencyKey),
    );
  }

  confirmPayment(
    ref: string,
    input: { paymentMethod?: string | undefined; returnUrl?: string | undefined },
  ): Promise<PaymentIntentResult> {
    if (input.paymentMethod && !isPaymentMethodRef(input.paymentMethod))
      throw new PaymentProviderError(
        'Invalid payment method reference',
        'invalid_payment_method',
        false,
        400,
      );
    const form: Form = { payment_method: input.paymentMethod, return_url: input.returnUrl };
    if (!input.returnUrl) form['automatic_payment_methods[allow_redirects]'] = 'never';
    return this.withDecline(() =>
      this.call('POST', `/v1/payment_intents/${encodeURIComponent(ref)}/confirm`, form),
    );
  }

  capturePayment(
    ref: string,
    input: { amount?: number; idempotencyKey: string },
  ): Promise<PaymentIntentResult> {
    return this.withDecline(() =>
      this.call(
        'POST',
        `/v1/payment_intents/${encodeURIComponent(ref)}/capture`,
        { amount_to_capture: input.amount },
        input.idempotencyKey,
      ),
    );
  }

  async cancelPayment(ref: string, input: { idempotencyKey: string }): Promise<void> {
    await this.call(
      'POST',
      `/v1/payment_intents/${encodeURIComponent(ref)}/cancel`,
      {},
      input.idempotencyKey,
    );
  }

  async describePaymentMethod(paymentMethod: string): Promise<PaymentMethodInfo> {
    if (!isPaymentMethodRef(paymentMethod))
      throw new PaymentProviderError(
        'Invalid payment method reference',
        'invalid_payment_method',
        false,
        400,
      );
    const pm = await this.call('GET', `/v1/payment_methods/${encodeURIComponent(paymentMethod)}`);
    return {
      fingerprint: pm.card?.fingerprint ?? null,
      country: pm.card?.country ?? null,
      brand: pm.card?.brand ?? null,
    };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const r = await this.call(
      'POST',
      '/v1/refunds',
      {
        payment_intent: input.paymentRef,
        amount: input.amount,
        metadata: { ...input.metadata, reason: input.reason?.slice(0, 200) },
        reason:
          input.reason === 'fraudulent' || input.reason === 'duplicate'
            ? input.reason
            : 'requested_by_customer',
      },
      input.idempotencyKey,
    );
    const status =
      r.status === 'succeeded'
        ? 'succeeded'
        : r.status === 'failed' || r.status === 'canceled'
          ? 'failed'
          : 'pending';
    return { ref: String(r.id), status, failureCode: r.failure_reason ?? null };
  }

  private accountResult(
    a: StripeObject,
    onboardingUrl: string | null = null,
  ): ConnectedAccountResult {
    const rejected =
      typeof a.requirements?.disabled_reason === 'string' &&
      a.requirements.disabled_reason.startsWith('rejected');
    const payoutsEnabled = Boolean(a.payouts_enabled) && Boolean(a.details_submitted);
    const kycStatus: KycStatus = rejected
      ? 'rejected'
      : payoutsEnabled
        ? 'verified'
        : a.details_submitted
          ? 'pending'
          : 'unverified';
    return { accountRef: String(a.id), kycStatus, payoutsEnabled, onboardingUrl };
  }

  async createConnectedAccount(
    input: ConnectedAccountInput & { idempotencyKey: string },
  ): Promise<ConnectedAccountResult> {
    const a = await this.call(
      'POST',
      '/v1/accounts',
      {
        type: 'express',
        country: input.country,
        email: input.email,
        'capabilities[transfers][requested]': 'true',
        metadata: { ownerType: input.ownerType, ownerId: input.ownerId },
      },
      input.idempotencyKey,
    );
    let url: string | null = null;
    if (input.returnUrl) {
      const link = await this.call(
        'POST',
        '/v1/account_links',
        {
          account: a.id,
          type: 'account_onboarding',
          refresh_url: input.returnUrl,
          return_url: input.returnUrl,
        },
        `${input.idempotencyKey}:link`,
      );
      url = link.url ?? null;
    }
    return this.accountResult(a, url);
  }

  async getConnectedAccount(accountRef: string): Promise<ConnectedAccountResult> {
    return this.accountResult(
      await this.call('GET', `/v1/accounts/${encodeURIComponent(accountRef)}`),
    );
  }

  async createPayout(input: PayoutInput): Promise<PayoutResult> {
    const t = await this.call(
      'POST',
      '/v1/transfers',
      {
        amount: input.amount,
        currency: input.currency.toLowerCase(),
        destination: input.accountRef,
        metadata: input.metadata,
      },
      input.idempotencyKey,
    );
    return { ref: String(t.id), status: t.reversed ? 'failed' : 'paid', failureCode: null };
  }

  // ------------------------------------------------------------------ webhooks
  verifyWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): NormalisedEvent[] {
    const raw = headers[STRIPE_SIGNATURE_HEADER];
    const header = Array.isArray(raw) ? raw[0] : raw;
    verifyStripeSignature({
      secret: this.opts.webhookSecret,
      header,
      rawBody,
      toleranceSeconds: this.opts.toleranceSeconds ?? 300,
      nowSec: Math.floor((this.opts.now?.() ?? new Date()).getTime() / 1000),
    });
    let evt: { id?: unknown; type?: unknown; data?: { object?: unknown } } | null;
    try {
      evt = JSON.parse(rawBody) as typeof evt;
    } catch {
      throw new WebhookSignatureError('Webhook body is not JSON', 'bad_payload');
    }
    if (
      typeof evt?.id !== 'string' ||
      typeof evt?.type !== 'string' ||
      typeof evt?.data?.object !== 'object'
    ) {
      throw new WebhookSignatureError('Webhook body has an unexpected shape', 'bad_payload');
    }
    return [normaliseStripeEvent(evt as unknown as StripeEvent)];
  }

  async listRecords(range: { from: Date; to: Date }): Promise<ProviderRecord[]> {
    const out: ProviderRecord[] = [];
    const created = {
      gte: Math.floor(range.from.getTime() / 1000),
      lte: Math.floor(range.to.getTime() / 1000),
    };
    const page = async (path: string, map: (o: StripeListObject) => ProviderRecord | null) => {
      let after: string | undefined;
      for (let i = 0; i < 50; i++) {
        const r = await this.call<{ data: StripeListObject[]; has_more: boolean }>('GET', path, {
          limit: 100,
          created,
          starting_after: after,
        });
        for (const o of r.data) {
          const rec = map(o);
          if (rec) out.push(rec);
        }
        if (!r.has_more || !r.data.length) break;
        after = String(r.data[r.data.length - 1]!.id);
      }
    };
    const cur = (c: unknown) => String(c).toUpperCase();
    await page('/v1/payment_intents', (o) => ({
      kind: 'payment',
      ref: o.id,
      paymentRef: null,
      amount: o.amount_received || o.amount,
      currency: cur(o.currency),
      status:
        o.status === 'succeeded' ? 'succeeded' : o.status === 'canceled' ? 'canceled' : 'pending',
      createdAt: new Date(o.created * 1000),
    }));
    await page('/v1/refunds', (o) => ({
      kind: 'refund',
      ref: o.id,
      paymentRef: o.payment_intent ?? null,
      amount: o.amount,
      currency: cur(o.currency),
      status:
        o.status === 'succeeded'
          ? 'succeeded'
          : o.status === 'failed' || o.status === 'canceled'
            ? 'failed'
            : 'pending',
      createdAt: new Date(o.created * 1000),
    }));
    await page('/v1/transfers', (o) => ({
      kind: 'payout',
      ref: o.id,
      paymentRef: null,
      amount: o.amount,
      currency: cur(o.currency),
      status: o.reversed ? 'failed' : 'succeeded',
      createdAt: new Date(o.created * 1000),
    }));
    return out;
  }
}

/** Map a Stripe event to our normalised shape. Unknown event types become `ignored` (still stored for de-duplication). */
export function normaliseStripeEvent(evt: StripeEvent): NormalisedEvent {
  const o = evt.data.object as unknown as StripeObject;
  const base: NormalisedEvent = {
    id: evt.id,
    type: 'ignored',
    providerRef: typeof o.id === 'string' ? o.id : null,
    paymentRef: null,
    amount: null,
    currency: null,
    failureCode: null,
    occurredAt: new Date(
      (typeof evt.created === 'number' ? evt.created : Math.floor(Date.now() / 1000)) * 1000,
    ),
    disputeOutcome: null,
    disputeReason: null,
    account: null,
    metadata:
      o.metadata && typeof o.metadata === 'object' ? (o.metadata as Record<string, string>) : {},
    rawType: evt.type,
  };
  const cur = (c: unknown) => (typeof c === 'string' ? c.toUpperCase() : null);
  switch (evt.type) {
    case 'payment_intent.succeeded':
      return {
        ...base,
        type: 'payment.succeeded',
        amount: o.amount_received ?? o.amount ?? null,
        currency: cur(o.currency),
      };
    case 'payment_intent.payment_failed':
      return {
        ...base,
        type: 'payment.failed',
        amount: o.amount ?? null,
        currency: cur(o.currency),
        failureCode: (o.last_payment_error?.decline_code ??
          o.last_payment_error?.code ??
          'payment_failed') as string,
      };
    case 'payment_intent.requires_action':
      return {
        ...base,
        type: 'payment.requires_action',
        amount: o.amount ?? null,
        currency: cur(o.currency),
      };
    case 'payment_intent.canceled':
      return {
        ...base,
        type: 'payment.canceled',
        amount: o.amount ?? null,
        currency: cur(o.currency),
      };
    case 'refund.created':
    case 'refund.updated':
    case 'charge.refund.updated': {
      const t =
        o.status === 'succeeded'
          ? 'refund.succeeded'
          : o.status === 'failed' || o.status === 'canceled'
            ? 'refund.failed'
            : 'ignored';
      return {
        ...base,
        type: t,
        paymentRef: o.payment_intent ?? null,
        amount: o.amount ?? null,
        currency: cur(o.currency),
        failureCode: o.failure_reason ?? null,
      };
    }
    case 'charge.dispute.created':
      return {
        ...base,
        type: 'dispute.opened',
        paymentRef: o.payment_intent ?? null,
        amount: o.amount ?? null,
        currency: cur(o.currency),
        disputeReason: o.reason ?? null,
      };
    case 'charge.dispute.closed': {
      const won = o.status === 'won' || o.status === 'warning_closed';
      const lost = o.status === 'lost';
      return {
        ...base,
        type: won || lost ? 'dispute.closed' : 'ignored',
        paymentRef: o.payment_intent ?? null,
        amount: o.amount ?? null,
        currency: cur(o.currency),
        disputeOutcome: won ? 'won' : lost ? 'lost' : null,
        disputeReason: o.reason ?? null,
      };
    }
    case 'transfer.created':
      return { ...base, type: 'payout.paid', amount: o.amount ?? null, currency: cur(o.currency) };
    case 'transfer.reversed':
      return {
        ...base,
        type: 'payout.failed',
        amount: o.amount ?? null,
        currency: cur(o.currency),
        failureCode: 'transfer_reversed',
      };
    case 'account.updated': {
      const rejected =
        typeof o.requirements?.disabled_reason === 'string' &&
        o.requirements.disabled_reason.startsWith('rejected');
      const payoutsEnabled = Boolean(o.payouts_enabled) && Boolean(o.details_submitted);
      const kycStatus: KycStatus = rejected
        ? 'rejected'
        : payoutsEnabled
          ? 'verified'
          : o.details_submitted
            ? 'pending'
            : 'unverified';
      return { ...base, type: 'account.updated', account: { kycStatus, payoutsEnabled } };
    }
    default:
      return base;
  }
}
