import { createPaymentProvider, type PaymentProvider } from '@yapilapi/payments';
import type { AppContext } from '../../lib/context.js';

const providers = new WeakMap<AppContext, PaymentProvider>();

/** The configured provider (PAYMENT_PROVIDER), created once per app context. */
export function getPaymentProvider(ctx: AppContext): PaymentProvider {
  let p = providers.get(ctx);
  if (!p) {
    p = createPaymentProvider({
      provider: ctx.config.PAYMENT_PROVIDER,
      webhookSigningSecret: ctx.config.webhookSigningSecret,
      stripeSecretKey: ctx.config.STRIPE_SECRET_KEY,
      stripeWebhookSecret: ctx.config.STRIPE_WEBHOOK_SECRET,
      stripeBaseUrl: ctx.config.STRIPE_API_BASE_URL,
      toleranceSeconds: ctx.config.PAYMENT_WEBHOOK_TOLERANCE_SEC,
    });
    providers.set(ctx, p);
  }
  return p;
}

/** Test seam: substitute the provider for one app context (e.g. a Stripe adapter with an injected fetch). */
export function overridePaymentProvider(ctx: AppContext, provider: PaymentProvider): void {
  providers.set(ctx, provider);
}
