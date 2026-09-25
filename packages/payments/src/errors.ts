export class PaymentProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    /** True when the outcome is unknown or transient (network, 5xx, 429): the same request may be repeated with the same idempotency key. */
    readonly retryable = false,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'PaymentProviderError';
  }
}

export class WebhookSignatureError extends Error {
  constructor(
    message: string,
    readonly reason:
      'missing_header' | 'malformed_header' | 'stale_timestamp' | 'bad_signature' | 'bad_payload',
  ) {
    super(message);
    this.name = 'WebhookSignatureError';
  }
}
