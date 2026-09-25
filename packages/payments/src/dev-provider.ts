import { createHash } from 'node:crypto';
import { signWebhook, verifyWebhookSignature } from '@yapilapi/security';
import { PaymentProviderError, WebhookSignatureError } from './errors.js';
import { isPaymentMethodRef } from './card-guard.js';
import type {
  ConnectedAccountInput,
  ConnectedAccountResult,
  CreatePaymentInput,
  IntentStatus,
  KycStatus,
  NormalisedEvent,
  NormalisedEventType,
  PaymentIntentResult,
  PaymentMethodInfo,
  PaymentProvider,
  PayoutInput,
  PayoutResult,
  ProviderRecord,
  RefundInput,
  RefundResult,
  SignedWebhook,
} from './types.js';

export const DEV_SIGNATURE_HEADER = 'yapilapi-signature';

/** Payment-method token behaviour of the development provider. Tokens may carry `:fp=<id>` and `:cc=<XX>` suffixes. */
export type DevOutcome =
  'success' | 'decline' | 'insufficient_funds' | 'expired_card' | 'requires_action';
const TOKEN_OUTCOMES: Record<string, DevOutcome> = {
  tok_success: 'success',
  pm_card_visa: 'success',
  tok_decline: 'decline',
  pm_card_chargedeclined: 'decline',
  tok_insufficient_funds: 'insufficient_funds',
  tok_expired_card: 'expired_card',
  tok_requires_action: 'requires_action',
  pm_card_authenticationrequired: 'requires_action',
};

export interface ParsedDevToken {
  outcome: DevOutcome;
  fingerprint: string;
  country: string;
}

/** Deterministic: the same token always produces the same outcome, fingerprint and country. */
export function parseDevToken(token: string): ParsedDevToken {
  const [base = '', ...mods] = token.split(':');
  const outcome = TOKEN_OUTCOMES[base.toLowerCase()];
  if (!outcome)
    throw new PaymentProviderError(
      `Unknown test payment method ${base}`,
      'invalid_payment_method',
      false,
      400,
    );
  let fp: string | null = null;
  let cc = 'US';
  for (const m of mods) {
    if (m.startsWith('fp=')) fp = m.slice(3);
    else if (m.startsWith('cc=')) cc = m.slice(3).toUpperCase();
  }
  return { outcome, fingerprint: `fp_dev_${fp ?? outcome}`, country: cc };
}

const FAILURE_CODES: Partial<Record<DevOutcome, string>> = {
  decline: 'card_declined',
  insufficient_funds: 'insufficient_funds',
  expired_card: 'expired_card',
};

const h = (s: string, n = 24) => createHash('sha256').update(s).digest('hex').slice(0, n);

interface Intent {
  ref: string;
  amount: number;
  currency: string;
  status: IntentStatus;
  pm: string | null;
  failureCode: string | null;
  fingerprint: string | null;
  country: string | null;
  refunded: number;
  createdAt: Date;
  metadata: Record<string, string>;
}
interface RefundRec {
  ref: string;
  paymentRef: string;
  amount: number;
  currency: string;
  createdAt: Date;
}
interface PayoutRec {
  ref: string;
  accountRef: string;
  amount: number;
  currency: string;
  status: 'paid' | 'failed';
  createdAt: Date;
}

export interface DevProviderOptions {
  webhookSecret: string;
  toleranceSeconds?: number;
  now?: () => Date;
}

/**
 * Deterministic in-process provider for development and tests. It behaves like a real one (idempotent creation, async webhooks
 * signed with HMAC via `signWebhook`) but talks to nobody. State is per instance (lost on restart, which reconciliation
 * reports honestly as "missing at provider").
 */
export class DevPaymentProvider implements PaymentProvider {
  readonly name = 'dev' as const;
  private readonly intents = new Map<string, Intent>();
  private readonly refunds = new Map<string, RefundRec>();
  private readonly payouts = new Map<string, PayoutRec>();
  private readonly accounts = new Map<string, { kyc: KycStatus; country: string }>();
  private readonly failingPayoutAccounts = new Set<string>();
  private outbox: SignedWebhook[] = [];
  private seq = new Map<string, number>();

  constructor(private readonly opts: DevProviderOptions) {}

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  // ------------------------------------------------------------------ webhooks (outbound simulation)
  /** Build a correctly signed delivery for an event; also used by tests to forge invalid variants. */
  buildWebhook(
    event: { id: string; type: NormalisedEventType | string; data: Record<string, unknown> },
    signedAt = Math.floor(this.now().getTime() / 1000),
  ): SignedWebhook {
    const rawBody = JSON.stringify({
      id: event.id,
      type: event.type,
      created: Math.floor(this.now().getTime() / 1000),
      data: event.data,
    });
    return {
      rawBody,
      headers: {
        [DEV_SIGNATURE_HEADER]: signWebhook(this.opts.webhookSecret, rawBody, signedAt),
        'content-type': 'application/json',
      },
    };
  }

  private emit(type: NormalisedEventType, key: string, data: Record<string, unknown>) {
    const n = (this.seq.get(key) ?? 0) + 1;
    this.seq.set(key, n);
    // Deterministic event ids: replaying the same operation produces the same id, which the receiver de-duplicates.
    this.outbox.push(this.buildWebhook({ id: `evt_dev_${h(`${type}:${key}:${n}`)}`, type, data }));
  }

  drainWebhookOutbox(): SignedWebhook[] {
    const out = this.outbox;
    this.outbox = [];
    return out;
  }

  // ------------------------------------------------------------------ payments
  private view(
    i: Intent,
    nextAction: PaymentIntentResult['nextAction'] = null,
  ): PaymentIntentResult {
    return {
      ref: i.ref,
      status: i.status,
      clientSecret: `${i.ref}_secret_dev`,
      failureCode: i.failureCode,
      nextAction,
      fingerprint: i.fingerprint,
      cardCountry: i.country,
    };
  }

  private attempt(i: Intent, pm: string): PaymentIntentResult {
    if (!isPaymentMethodRef(pm))
      throw new PaymentProviderError(
        'Invalid payment method reference',
        'invalid_payment_method',
        false,
        400,
      );
    const t = parseDevToken(pm);
    i.pm = pm;
    i.fingerprint = t.fingerprint;
    i.country = t.country;
    i.failureCode = null;
    const data = {
      providerRef: i.ref,
      amount: i.amount,
      currency: i.currency,
      metadata: i.metadata,
    };
    if (t.outcome === 'success') {
      i.status = 'succeeded';
      this.emit('payment.succeeded', i.ref, data);
      return this.view(i);
    }
    if (t.outcome === 'requires_action') {
      i.status = 'requires_action';
      this.emit('payment.requires_action', i.ref, data);
      return this.view(i, { type: 'dev_challenge', url: null });
    }
    i.status = 'failed';
    i.failureCode = FAILURE_CODES[t.outcome] ?? 'card_declined';
    this.emit('payment.failed', `${i.ref}:${pm}`, { ...data, failureCode: i.failureCode });
    return this.view(i);
  }

  async createPaymentIntent(input: CreatePaymentInput): Promise<PaymentIntentResult> {
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0)
      throw new PaymentProviderError('Invalid amount', 'invalid_amount', false, 400);
    const ref = `pi_dev_${h(input.idempotencyKey)}`;
    const existing = this.intents.get(ref);
    if (existing) {
      if (existing.amount !== input.amount || existing.currency !== input.currency) {
        throw new PaymentProviderError(
          'Idempotency key reused with different parameters',
          'idempotency_mismatch',
          false,
          400,
        );
      }
      return this.view(
        existing,
        existing.status === 'requires_action' ? { type: 'dev_challenge', url: null } : null,
      );
    }
    const i: Intent = {
      ref,
      amount: input.amount,
      currency: input.currency,
      status: 'requires_payment_method',
      pm: null,
      failureCode: null,
      fingerprint: null,
      country: null,
      refunded: 0,
      createdAt: this.now(),
      metadata: { ...input.metadata },
    };
    this.intents.set(ref, i);
    return input.paymentMethod ? this.attempt(i, input.paymentMethod) : this.view(i);
  }

  async confirmPayment(
    ref: string,
    input: { paymentMethod?: string | undefined },
  ): Promise<PaymentIntentResult> {
    const i = this.intents.get(ref);
    if (!i) throw new PaymentProviderError('No such payment', 'resource_missing', false, 404);
    if (i.status === 'succeeded') return this.view(i);
    if (i.status === 'canceled')
      throw new PaymentProviderError(
        'Payment was canceled',
        'payment_intent_unexpected_state',
        false,
        400,
      );
    if (i.status === 'requires_action') {
      // The customer completed the (simulated) challenge. A new payment method may replace the original one.
      if (input.paymentMethod)
        return this.attempt(i, input.paymentMethod.replace(/^tok_requires_action/, 'tok_success'));
      i.status = 'succeeded';
      this.emit('payment.succeeded', `${i.ref}:action`, {
        providerRef: i.ref,
        amount: i.amount,
        currency: i.currency,
        metadata: i.metadata,
      });
      return this.view(i);
    }
    const pm = input.paymentMethod ?? i.pm;
    if (!pm)
      throw new PaymentProviderError(
        'A payment method is required',
        'payment_method_required',
        false,
        400,
      );
    return this.attempt(i, pm);
  }

  async capturePayment(ref: string): Promise<PaymentIntentResult> {
    const i = this.intents.get(ref);
    if (!i) throw new PaymentProviderError('No such payment', 'resource_missing', false, 404);
    // Dev intents are automatic-capture: succeeded == captured.
    return this.view(i);
  }

  async cancelPayment(ref: string): Promise<void> {
    const i = this.intents.get(ref);
    if (!i) return;
    if (i.status === 'succeeded')
      throw new PaymentProviderError(
        'A succeeded payment cannot be canceled; refund it',
        'payment_intent_unexpected_state',
        false,
        400,
      );
    if (i.status !== 'canceled') {
      i.status = 'canceled';
      this.emit('payment.canceled', i.ref, {
        providerRef: i.ref,
        amount: i.amount,
        currency: i.currency,
        metadata: i.metadata,
      });
    }
  }

  async describePaymentMethod(paymentMethod: string): Promise<PaymentMethodInfo> {
    if (!isPaymentMethodRef(paymentMethod))
      throw new PaymentProviderError(
        'Invalid payment method reference',
        'invalid_payment_method',
        false,
        400,
      );
    const t = parseDevToken(paymentMethod);
    return { fingerprint: t.fingerprint, country: t.country, brand: 'dev' };
  }

  // ------------------------------------------------------------------ refunds
  async refund(input: RefundInput): Promise<RefundResult> {
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0)
      throw new PaymentProviderError('Invalid amount', 'invalid_amount', false, 400);
    const ref = `re_dev_${h(input.idempotencyKey)}`;
    if (this.refunds.has(ref)) return { ref, status: 'succeeded', failureCode: null };
    if (!input.paymentRef.startsWith('pi_dev_'))
      throw new PaymentProviderError('No such payment', 'resource_missing', false, 404);
    const i = this.intents.get(input.paymentRef);
    if (i) {
      if (i.status !== 'succeeded')
        throw new PaymentProviderError(
          'Payment has not succeeded',
          'charge_not_captured',
          false,
          400,
        );
      if (i.refunded + input.amount > i.amount)
        throw new PaymentProviderError(
          'Refund exceeds the charge',
          'charge_already_refunded',
          false,
          400,
        );
      i.refunded += input.amount;
    }
    this.refunds.set(ref, {
      ref,
      paymentRef: input.paymentRef,
      amount: input.amount,
      currency: input.currency,
      createdAt: this.now(),
    });
    this.emit('refund.succeeded', ref, {
      providerRef: ref,
      paymentRef: input.paymentRef,
      amount: input.amount,
      currency: input.currency,
      metadata: input.metadata ?? {},
    });
    return { ref, status: 'succeeded', failureCode: null };
  }

  // ------------------------------------------------------------------ connected accounts and payouts
  async createConnectedAccount(
    input: ConnectedAccountInput & { idempotencyKey: string },
  ): Promise<ConnectedAccountResult> {
    const accountRef = `acct_dev_${h(`${input.ownerType}:${input.ownerId}:${input.idempotencyKey}`, 16)}`;
    if (!this.accounts.has(accountRef))
      this.accounts.set(accountRef, { kyc: 'pending', country: input.country });
    return this.accountView(accountRef);
  }

  private accountView(ref: string): ConnectedAccountResult {
    const a = this.accounts.get(ref);
    const kyc = a?.kyc ?? 'pending';
    return {
      accountRef: ref,
      kycStatus: kyc,
      payoutsEnabled: kyc === 'verified',
      onboardingUrl: null,
    };
  }

  async getConnectedAccount(accountRef: string): Promise<ConnectedAccountResult> {
    if (!accountRef.startsWith('acct_dev_'))
      throw new PaymentProviderError('No such account', 'resource_missing', false, 404);
    return this.accountView(accountRef);
  }

  async createPayout(input: PayoutInput): Promise<PayoutResult> {
    const ref = `po_dev_${h(input.idempotencyKey)}`;
    const prior = this.payouts.get(ref);
    if (prior)
      return {
        ref,
        status: prior.status,
        failureCode: prior.status === 'failed' ? 'account_closed' : null,
      };
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0)
      throw new PaymentProviderError('Invalid amount', 'invalid_amount', false, 400);
    if (
      this.accounts.has(input.accountRef) &&
      this.accounts.get(input.accountRef)!.kyc !== 'verified'
    ) {
      throw new PaymentProviderError(
        'The connected account cannot receive transfers yet',
        'account_not_verified',
        false,
        400,
      );
    }
    const failed = this.failingPayoutAccounts.has(input.accountRef);
    const rec: PayoutRec = {
      ref,
      accountRef: input.accountRef,
      amount: input.amount,
      currency: input.currency,
      status: failed ? 'failed' : 'paid',
      createdAt: this.now(),
    };
    this.payouts.set(ref, rec);
    this.emit(failed ? 'payout.failed' : 'payout.paid', ref, {
      providerRef: ref,
      amount: input.amount,
      currency: input.currency,
      failureCode: failed ? 'account_closed' : undefined,
      metadata: input.metadata ?? {},
    });
    return { ref, status: rec.status, failureCode: failed ? 'account_closed' : null };
  }

  // ------------------------------------------------------------------ webhook verification
  verifyWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): NormalisedEvent[] {
    const raw = headers[DEV_SIGNATURE_HEADER];
    const header = Array.isArray(raw) ? raw[0] : raw;
    if (!header) throw new WebhookSignatureError('Missing signature header', 'missing_header');
    const ok = verifyWebhookSignature({
      secret: this.opts.webhookSecret,
      header,
      rawBody,
      toleranceSeconds: this.opts.toleranceSeconds ?? 300,
      now: Math.floor(this.now().getTime() / 1000),
    });
    if (!ok) {
      // Distinguish stale from bad for diagnostics without leaking which part failed to the sender.
      const t = Number(/(?:^|,)\s*t=(\d+)/.exec(header)?.[1]);
      const stale =
        Number.isFinite(t) &&
        Math.abs(Math.floor(this.now().getTime() / 1000) - t) > (this.opts.toleranceSeconds ?? 300);
      throw new WebhookSignatureError(
        stale ? 'Webhook timestamp outside tolerance' : 'Invalid webhook signature',
        stale ? 'stale_timestamp' : 'bad_signature',
      );
    }
    let body: { id?: unknown; type?: unknown; created?: unknown; data?: Record<string, unknown> };
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new WebhookSignatureError('Webhook body is not JSON', 'bad_payload');
    }
    if (
      typeof body.id !== 'string' ||
      typeof body.type !== 'string' ||
      typeof body.data !== 'object' ||
      body.data === null
    ) {
      throw new WebhookSignatureError('Webhook body has an unexpected shape', 'bad_payload');
    }
    const d = body.data as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' ? v : null);
    const num = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) ? v : null);
    const type = (
      KNOWN_EVENT_TYPES.has(body.type as NormalisedEventType) ? body.type : 'ignored'
    ) as NormalisedEventType;
    const account = d.account as { kycStatus?: KycStatus; payoutsEnabled?: boolean } | undefined;
    return [
      {
        id: body.id,
        type,
        providerRef: str(d.providerRef),
        paymentRef: str(d.paymentRef),
        amount: num(d.amount),
        currency: str(d.currency),
        failureCode: str(d.failureCode),
        occurredAt: new Date(
          typeof body.created === 'number' ? body.created * 1000 : this.now().getTime(),
        ),
        disputeOutcome: d.outcome === 'won' || d.outcome === 'lost' ? d.outcome : null,
        disputeReason: str(d.reason),
        account: account?.kycStatus
          ? { kycStatus: account.kycStatus, payoutsEnabled: Boolean(account.payoutsEnabled) }
          : null,
        metadata: (d.metadata && typeof d.metadata === 'object' ? d.metadata : {}) as Record<
          string,
          string
        >,
        rawType: body.type,
      },
    ];
  }

  async listRecords(range: { from: Date; to: Date }): Promise<ProviderRecord[]> {
    const inRange = (d: Date) => d >= range.from && d <= range.to;
    const out: ProviderRecord[] = [];
    for (const i of this.intents.values()) {
      if (inRange(i.createdAt))
        out.push({
          kind: 'payment',
          ref: i.ref,
          paymentRef: null,
          amount: i.amount,
          currency: i.currency,
          status:
            i.status === 'succeeded'
              ? 'succeeded'
              : i.status === 'canceled'
                ? 'canceled'
                : i.status === 'failed'
                  ? 'failed'
                  : 'pending',
          createdAt: i.createdAt,
        });
    }
    for (const r of this.refunds.values())
      if (inRange(r.createdAt))
        out.push({
          kind: 'refund',
          ref: r.ref,
          paymentRef: r.paymentRef,
          amount: r.amount,
          currency: r.currency,
          status: 'succeeded',
          createdAt: r.createdAt,
        });
    for (const p of this.payouts.values())
      if (inRange(p.createdAt))
        out.push({
          kind: 'payout',
          ref: p.ref,
          paymentRef: null,
          amount: p.amount,
          currency: p.currency,
          status: p.status === 'paid' ? 'succeeded' : 'failed',
          createdAt: p.createdAt,
        });
    return out;
  }

  // ------------------------------------------------------------------ test/dev controls (not part of PaymentProvider)
  /** Simulate the outcome of KYC on the (fake) provider side and emit the matching account.updated webhook. */
  devSetKyc(accountRef: string, kycStatus: KycStatus): void {
    const a = this.accounts.get(accountRef);
    if (!a) throw new PaymentProviderError('No such account', 'resource_missing', false, 404);
    a.kyc = kycStatus;
    this.emit('account.updated', `${accountRef}:${kycStatus}`, {
      providerRef: accountRef,
      account: { kycStatus, payoutsEnabled: kycStatus === 'verified' },
    });
  }

  /** Make payouts to this account fail at the provider (simulates a closed bank account). */
  devFailPayoutsFor(accountRef: string, fail = true): void {
    if (fail) this.failingPayoutAccounts.add(accountRef);
    else this.failingPayoutAccounts.delete(accountRef);
  }

  /** Simulate a customer dispute on a captured payment. */
  devOpenDispute(paymentRef: string, reason = 'fraudulent'): void {
    const i = this.intents.get(paymentRef);
    const amount = i?.amount ?? 0;
    this.emit('dispute.opened', `dp:${paymentRef}`, {
      providerRef: `dp_dev_${h(paymentRef, 16)}`,
      paymentRef,
      amount,
      currency: i?.currency ?? 'USD',
      reason,
    });
  }

  devCloseDispute(paymentRef: string, outcome: 'won' | 'lost'): void {
    const i = this.intents.get(paymentRef);
    this.emit('dispute.closed', `dpc:${paymentRef}:${outcome}`, {
      providerRef: `dp_dev_${h(paymentRef, 16)}`,
      paymentRef,
      amount: i?.amount ?? 0,
      currency: i?.currency ?? 'USD',
      outcome,
    });
  }
}

const KNOWN_EVENT_TYPES = new Set<NormalisedEventType>([
  'payment.succeeded',
  'payment.failed',
  'payment.requires_action',
  'payment.canceled',
  'refund.succeeded',
  'refund.failed',
  'dispute.opened',
  'dispute.closed',
  'payout.paid',
  'payout.failed',
  'account.updated',
]);
