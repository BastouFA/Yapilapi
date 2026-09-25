# ADR 008: provider-agnostic payments over an immutable double-entry ledger

Status: accepted. Scope: `packages/payments`, `apps/api/src/modules/{payments,commerce}`

## Decision

- A provider interface (`dev` and a Stripe adapter using fetch + HMAC webhook verification). Card data never touches the API: only provider tokens/refs are accepted, and a Luhn card guard rejects raw card numbers anywhere in payloads. A global test scans every stored row for card numbers.
- Money is integer minor units. Every movement is a balanced double-entry ledger transaction; the tables are append-only and a deferred constraint trigger rejects unbalanced transactions.
- Idempotency keys on checkout/payment/refund/payout; webhooks are signature-verified and de-duplicated; refunds and payouts are state machines; fraud rules can review or block; reconciliation compares ledger to provider.
- Staging/production refuse `PAYMENT_PROVIDER=dev`.

## Not done

Tax is seller-declared, shipping is a flat placeholder, the Stripe adapter has not been exercised against Stripe's live API in this repository.
