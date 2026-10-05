-- Payouts that actually pay. A creator sets up where their money goes, per payment provider:
--   * Stripe Connect (hosted): they give Stripe their bank details on Stripe's pages; account_ref is the
--     Stripe account, one for all of Stripe's currencies (currency is NULL).
--   * Paystack (and the development provider): they pick a bank and give an account number here; Paystack
--     keeps it as a transfer recipient. account_ref is its code, one per currency; label is the bank and
--     the last four digits, all we keep of the number.
-- A verified payout is sent by the payout.send job: 'processing' until the provider confirms, then 'paid'.
-- 'failed' (refused, reversed, or rejected by an admin) gives the money back to the balance to ask again.
CREATE TABLE payout_accounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider    text NOT NULL,
  currency    char(3),
  account_ref text NOT NULL,
  label       text,
  ready       boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payout_accounts_per_currency ON payout_accounts (user_id, provider, currency) WHERE currency IS NOT NULL;
CREATE UNIQUE INDEX payout_accounts_hosted ON payout_accounts (user_id, provider) WHERE currency IS NULL;
CREATE INDEX payout_accounts_ref ON payout_accounts (provider, account_ref);

ALTER TABLE payouts
  ADD COLUMN provider text,
  ADD COLUMN reference text UNIQUE,
  ADD COLUMN failure_reason text,
  ADD COLUMN decided_at timestamptz,
  ADD COLUMN paid_at timestamptz;
ALTER TABLE payouts DROP CONSTRAINT payouts_status_check;
ALTER TABLE payouts ADD CONSTRAINT payouts_status_check CHECK (status IN ('pending', 'verified', 'processing', 'paid', 'failed'));
CREATE INDEX payouts_provider_ref ON payouts (provider, provider_ref);
