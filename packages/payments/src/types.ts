/**
 * Provider abstraction. Implementations never receive raw card data: callers pass opaque payment-method tokens/ids
 * created client-side by the provider's SDK (`tok_...`, `pm_...`).
 */
export type ProviderName = 'dev' | 'stripe';

export type IntentStatus =
  | 'requires_payment_method'
  | 'requires_action'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'canceled';

export interface CreatePaymentInput {
  /** Integer minor units. */
  amount: number;
  /** ISO 4217, upper case. */
  currency: string;
  /** Provider-level idempotency: the same key must always yield the same intent. */
  idempotencyKey: string;
  description?: string;
  /** String-only key/values echoed back on webhooks (order id, payment id...). Never put personal data here. */
  metadata: Record<string, string>;
  /** Opaque payment-method token or id. When present the intent is confirmed immediately. */
  paymentMethod?: string | undefined;
  returnUrl?: string | undefined;
}

export interface PaymentIntentResult {
  ref: string;
  status: IntentStatus;
  /** Opaque handle for the client SDK (never a card number). */
  clientSecret: string | null;
  failureCode: string | null;
  nextAction: { type: string; url?: string | null } | null;
  /** Opaque card fingerprint and issuing country when the provider reports them (fraud velocity signals). */
  fingerprint: string | null;
  cardCountry: string | null;
}

export interface PaymentMethodInfo {
  fingerprint: string | null;
  country: string | null;
  brand: string | null;
}

export interface RefundInput {
  paymentRef: string;
  amount: number;
  currency: string;
  idempotencyKey: string;
  reason?: string;
  metadata?: Record<string, string>;
}
export interface RefundResult {
  ref: string;
  status: 'succeeded' | 'pending' | 'failed';
  failureCode: string | null;
}

export type KycStatus = 'unverified' | 'pending' | 'verified' | 'rejected';

export interface ConnectedAccountInput {
  ownerType: 'user' | 'business';
  ownerId: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
  email?: string | undefined;
  returnUrl?: string | undefined;
}
export interface ConnectedAccountResult {
  accountRef: string;
  kycStatus: KycStatus;
  payoutsEnabled: boolean;
  /** Hosted onboarding/KYC link (Stripe account link); null for the dev provider. */
  onboardingUrl: string | null;
}

export interface PayoutInput {
  accountRef: string;
  amount: number;
  currency: string;
  idempotencyKey: string;
  metadata?: Record<string, string>;
}
export interface PayoutResult {
  ref: string;
  status: 'paid' | 'pending' | 'failed';
  failureCode: string | null;
}

export type NormalisedEventType =
  | 'payment.succeeded'
  | 'payment.failed'
  | 'payment.requires_action'
  | 'payment.canceled'
  | 'refund.succeeded'
  | 'refund.failed'
  | 'dispute.opened'
  | 'dispute.closed'
  | 'payout.paid'
  | 'payout.failed'
  | 'account.updated'
  | 'ignored';

export interface NormalisedEvent {
  /** Provider event id: the de-duplication key together with the provider name. */
  id: string;
  type: NormalisedEventType;
  /** Primary object: payment intent / refund / dispute / payout / account id. */
  providerRef: string | null;
  /** Related payment intent (refunds, disputes). */
  paymentRef: string | null;
  amount: number | null;
  currency: string | null;
  failureCode: string | null;
  occurredAt: Date;
  disputeOutcome: 'won' | 'lost' | null;
  disputeReason: string | null;
  account: { kycStatus: KycStatus; payoutsEnabled: boolean } | null;
  metadata: Record<string, string>;
  /** Provider's own type string, for diagnostics only. */
  rawType: string;
}

/** A provider-side settled record used by reconciliation. */
export interface ProviderRecord {
  kind: 'payment' | 'refund' | 'payout';
  ref: string;
  /** For refunds: the payment intent. */
  paymentRef: string | null;
  amount: number;
  currency: string;
  status: 'succeeded' | 'failed' | 'pending' | 'canceled';
  createdAt: Date;
}

export interface SignedWebhook {
  rawBody: string;
  headers: Record<string, string>;
}

export interface PaymentProvider {
  readonly name: ProviderName;
  createPaymentIntent(input: CreatePaymentInput): Promise<PaymentIntentResult>;
  /** Confirm an existing intent with a payment method, or complete a pending action. */
  confirmPayment(
    ref: string,
    input: { paymentMethod?: string | undefined; returnUrl?: string | undefined },
  ): Promise<PaymentIntentResult>;
  /** Release funds of an authorized-only intent (we create automatic-capture intents; provided for manual-capture flows). */
  capturePayment(
    ref: string,
    input: { amount?: number; idempotencyKey: string },
  ): Promise<PaymentIntentResult>;
  cancelPayment(ref: string, input: { idempotencyKey: string }): Promise<void>;
  describePaymentMethod(paymentMethod: string): Promise<PaymentMethodInfo>;
  refund(input: RefundInput): Promise<RefundResult>;
  createConnectedAccount(
    input: ConnectedAccountInput & { idempotencyKey: string },
  ): Promise<ConnectedAccountResult>;
  getConnectedAccount(accountRef: string): Promise<ConnectedAccountResult>;
  createPayout(input: PayoutInput): Promise<PayoutResult>;
  /**
   * Verify the signature and freshness of a webhook delivery and normalise its events. Throws WebhookSignatureError.
   * `rawBody` MUST be the exact bytes received (string), never a re-serialised object.
   */
  verifyWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): NormalisedEvent[];
  /** Provider-side settled records in a window, for reconciliation. */
  listRecords(range: { from: Date; to: Date }): Promise<ProviderRecord[]>;
  /** Dev provider only: signed webhook deliveries produced since the last call (delivered in-process to our own handler). */
  drainWebhookOutbox?(): SignedWebhook[];
}
