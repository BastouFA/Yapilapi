import { DevPaymentProvider } from './dev-provider.js';
import { StripePaymentProvider } from './stripe-provider.js';
import type { PaymentProvider, ProviderName } from './types.js';

export interface ProviderConfig {
  provider: ProviderName;
  /** Dev provider HMAC secret (WEBHOOK_SIGNING_SECRET). */
  webhookSigningSecret: string;
  stripeSecretKey?: string | undefined;
  stripeWebhookSecret?: string | undefined;
  stripeBaseUrl?: string | undefined;
  toleranceSeconds?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export function createPaymentProvider(cfg: ProviderConfig): PaymentProvider {
  if (cfg.provider === 'stripe') {
    if (!cfg.stripeSecretKey || !cfg.stripeWebhookSecret)
      throw new Error(
        'PAYMENT_PROVIDER=stripe requires STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET',
      );
    return new StripePaymentProvider({
      secretKey: cfg.stripeSecretKey,
      webhookSecret: cfg.stripeWebhookSecret,
      ...(cfg.stripeBaseUrl ? { baseUrl: cfg.stripeBaseUrl } : {}),
      ...(cfg.toleranceSeconds ? { toleranceSeconds: cfg.toleranceSeconds } : {}),
      ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}),
    });
  }
  return new DevPaymentProvider({
    webhookSecret: cfg.webhookSigningSecret,
    ...(cfg.toleranceSeconds ? { toleranceSeconds: cfg.toleranceSeconds } : {}),
  });
}
