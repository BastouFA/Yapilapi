'use client';

import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { Button } from '@yapilapi/design-system';
import { useSession } from '@/app/providers';

// Checkout loads this file only when a Stripe payment opens, so Stripe's code isn't in every page.

let stripePromise: Promise<Stripe | null> | null = null;

/** Card details go straight to Stripe's Payment Element. */
export function StripeStep({
  publishableKey,
  clientSecret,
  busy,
  onPaid,
  onError,
}: {
  publishableKey: string;
  clientSecret: string;
  busy: boolean;
  onPaid: () => void;
  onError: (m: string | null) => void;
}) {
  return (
    <Elements stripe={(stripePromise ??= loadStripe(publishableKey))} options={{ clientSecret }}>
      <StripeForm busy={busy} onPaid={onPaid} onError={onError} />
    </Elements>
  );
}

function StripeForm({ busy, onPaid, onError }: { busy: boolean; onPaid: () => void; onError: (m: string | null) => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const { toast, t } = useSession();
  return (
    <form
      className="stack-sm"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!stripe || !elements) return;
        onError(null);
        const { error } = await stripe.confirmPayment({ elements, redirect: 'if_required', confirmParams: { return_url: window.location.href } });
        if (error) {
          onError(error.message ?? t('checkout.failed'));
          return;
        }
        toast(t('checkout.sent'));
        onPaid();
      }}
    >
      <PaymentElement />
      <Button type="submit" loading={busy} disabled={!stripe || !elements}>
        {t('checkout.pay')}
      </Button>
    </form>
  );
}
