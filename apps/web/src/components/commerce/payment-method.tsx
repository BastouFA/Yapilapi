'use client';

import { FormField, Select } from '@yapilapi/ui';
import { useI18n } from '@/i18n';

/**
 * Payment-method choices for the built-in `dev` payment provider (see docs/architecture/payments.md, "Dev provider").
 * These are opaque test tokens the dev provider recognises deterministically — never real card numbers, and never
 * something the UI could confuse with one. `tok_requires_action` exercises the 3-D-Secure-like "processing" step.
 *
 * GAP: with `PAYMENT_PROVIDER=stripe` this select must be replaced by the provider's own client-side element
 * (e.g. Stripe Elements / Payment Element), which tokenises the card in the browser and returns a `pm_...` reference
 * without the number ever reaching this app. That widget needs Stripe's JS SDK and a publishable key, neither of
 * which is exercised in this repo (see "What needs real provider credentials" in docs/architecture/payments.md), so
 * it is out of scope here; this select is a faithful stand-in for the *dev* provider only.
 */
export const DEV_PAYMENT_TOKENS = [
  'tok_success',
  'tok_decline',
  'tok_insufficient_funds',
  'tok_expired_card',
  'tok_requires_action',
] as const;
export type DevPaymentToken = (typeof DEV_PAYMENT_TOKENS)[number];

export function PaymentMethodSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const { t } = useI18n();
  return (
    <FormField
      label={t('commerce.checkout.paymentMethod')}
      description={t('commerce.checkout.paymentMethodHelp')}
    >
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        {DEV_PAYMENT_TOKENS.map((tok) => (
          <option key={tok} value={tok}>
            {tok}
          </option>
        ))}
      </Select>
    </FormField>
  );
}
