# Payments and commerce: security

Scope: `packages/payments`, `apps/api/src/modules/{commerce,payments}`, migration `170_commerce_payments.sql`.
See `docs/architecture/payments.md` for flows and state machines.

## Card data never reaches us

- The API accepts only opaque payment-method references (`tok_...`, `pm_...`, `src_...`; `PAYMENT_METHOD_REF`). `paymentMethodSchema`
  rejects any value that does not match, and any value containing a Luhn-valid 13-19 digit run (with or without spaces/dashes).
  A client that posts a card number gets 400 and the number is not stored (the schema error does not echo the value).
- Card entry happens in the provider's client-side element; our database holds provider references, the card fingerprint (opaque provider
  id used for fraud rules) and the card country. No PAN, CVC, expiry or last-four is stored.
- `redact()` (from `@yapilapi/security`) is applied by `audit()` to all audit metadata and by the logger; the payments code never logs request bodies.
- Tests scan every row of every table with a Luhn detector (`payments.test.ts`, "no raw card data anywhere") and assert a positive control.
  Log scanning is not automated and should be added to the log pipeline in production.

## Secrets

- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `WEBHOOK_SIGNING_SECRET` are read through `packages/config` only; the download-link HMAC key is derived from the data-encryption key (`dataEncryptionKey`).
  Nothing is read from `process.env` elsewhere; `.env.example` lists the names with empty values.
- The config validator refuses `PAYMENT_PROVIDER=dev` in staging/production and requires both Stripe secrets when `stripe` is selected.
- Secrets are never included in audit metadata, error details, or responses.

## Webhook endpoint

- Public route (the provider has no session) protected by signature verification over the raw body: HMAC-SHA256, constant-time comparison,
  every `v1` value tried (secret rotation), timestamp tolerance `PAYMENT_WEBHOOK_TOLERANCE_SEC` (replay window). Anything else is 400 and stored nowhere;
  the rejection is audited with a body hash only.
- Verified events are deduplicated by `(provider, event_id)`. State is changed only from the verified event and the provider-side ids we stored
  (provider refs are looked up, never trusted from the payload for amounts we already know; amounts are compared with what the payment row says).
- IP rate limit of 600/minute on the route to bound abuse; the provider name in the path must match the configured provider.

## Authorization

- Every user endpoint requires authentication; ownership checks return 404 (not 403) for orders, payments, refunds and payouts the caller may not see.
- Buyers see their orders; sellers see orders that contain their goods; business sellers need a business role: catalog `offers.manage`,
  orders and refunds `bookings.manage`, money (payout account, balance, payouts) owner only. Editors and strangers are refused (tests cover the matrix).
- Staff endpoints require admin/superadmin role and MFA-verified session (`route()` enforces both). Staff cannot review their own orders.
- Marking KYC verified by hand exists only for the dev provider; with a real provider only the provider's account events can verify an account.
- Payouts require: adult account, verified payout account, positive available balance after the hold period, idempotency key. A per-payee
  advisory lock plus balance recheck inside the transaction prevents overdrawing by parallel requests.
- Digital downloads: short-lived HMAC-signed tokens (`DOWNLOAD_URL_TTL_SEC`), bound to the requesting user (a leaked link is useless to another
  account), and the entitlement (paid, not refunded) is re-checked at redemption. Tokens are passed as a query parameter to an endpoint that answers `Cache-Control: private, no-store` and `Referrer-Policy: no-referrer`, then redirects to a 2-minute presigned storage URL.

## Minors

Accounts in the teen age band cannot buy, sell, create payout accounts, request payouts or pay for community membership (403). There is no exception path.

## Integrity of money

- Prices, tax, shipping, fee and totals are computed server side from the database; client-supplied amounts are ignored. Quantities are bounded.
- Ledger entries are immutable (DB triggers), balanced per transaction (deferred constraint), and unique per business event (idempotent postings).
- Idempotency keys (required header on checkout, pay, refund, payout) are scoped to the caller and bound to a request hash; reuse with a different body is 409.
- Row locks: product and ticket rows locked in id order (no oversell, no deadlock); order row before payment row everywhere.
- The order state machine is the only writer of `orders.status`; a CHECK constraint backs it.
- Reconciliation (`GET /v1/staff/reconciliation`, run on demand or from a scheduler; nothing schedules it automatically) detects drift between provider, ledger and workflow tables.

## Fraud and abuse controls

- Rule engine with `allow` / `review` / `block`; hashed IPs (`ip_hash`, never raw addresses), card fingerprints, velocity, failed-payment counts,
  new-account high-value orders. Results stored in `fraud_signals` and visible only to staff.
- `review` holds the order (stock reserved, payment blocked) until staff decide; `block` is rejected with 403 and audited.
- Card testing is limited by per-user rate limits on pay/confirm (20 per 10 minutes) and the failed-payment rule.
- Reviews are for verified purchasers only; product-linked posts can only be published by the product's seller (business: `posts.publish`) for live products.
- Rate limits: checkout, product creation, refund and payout writes (`MONEY_W`), payouts 10 per hour.

## Audit

Audited actions include `payment.created`, `payment.failed`, `payment.confirm_attempted`, `payment.webhook_rejected`, order creation, cancellation,
review approvals and rejections, fraud blocks, refund requests/decisions/executions, dispute events, payout requests/results, payout-account and KYC changes,
`entitlement.failed`, product create/update/delete. Entries carry actor, target and non-sensitive metadata (ids, amounts, currency, reason codes).

## Data retention and account deletion

- On account deletion the commerce hook archives the user's products and cancels their open (unpaid) orders, releasing stock.
- Payments, refunds, ledger entries, orders (with item snapshots) and audit logs are financial records and are kept; they reference the
  user id only, and personal data (shipping address on an order, contact details) stays in the order row.
  A retention/erasure job for shipping addresses on old orders is NOT implemented; this needs a legal decision on retention periods.
- The ledger cannot be edited or deleted even by migrations that respect the triggers; corrections are new adjusting transactions.

## Residual risks and open items

- The Stripe adapter has not been run against a live Stripe account; signature verification and request construction are unit-tested only.
- No 3-D Secure liability handling beyond forwarding `requires_action` to the client.
- No automated PAN scan of application logs.
- Tax and shipping are placeholders, not compliance-grade calculations.
- Chargeback evidence submission is not implemented; disputes are recorded and reflected in the ledger only.
- Payout hold period and fraud thresholds are static configuration/constants, not tuned on real data.
