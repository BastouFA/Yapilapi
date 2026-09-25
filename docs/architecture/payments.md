# Payments and commerce

Packages and modules:

- `packages/payments` (`@yapilapi/payments`): provider abstraction (`PaymentProvider`), `DevPaymentProvider`, `StripePaymentProvider`
  (fetch-based, no SDK), money helpers (integer minor units only), fee calculator, ledger entry builders, fraud rule engine,
  pure `reconcile()`, card-number guard (`containsCardNumber`, `redact`).
- `apps/api/src/modules/commerce`: products, media/files, reviews, product-linked posts, orders, downloads, order state machine.
- `apps/api/src/modules/payments`: paying, webhook, refunds, disputes, payouts, fulfilment, fraud review, reconciliation, staff tools.
- Migration `170_commerce_payments.sql` (the only one; range 170-189 is reserved for this area).
- Behind the `COMMERCE` feature flag: every user-facing endpoint returns 404 `feature_disabled` when it is off. The signed webhook and the
  staff finance tools are deliberately NOT gated: money already in flight must still settle and staff must still be able to see it.

## Principles

1. **The webhook decides.** A payment is `captured` only when a signed provider event says so. The response to `POST /v1/orders/:id/pay`
   is never proof of payment (the client sees `processing` until the event lands). This is what makes 3-D Secure, delayed methods
   and lost HTTP responses safe.
2. **Money is integers** in minor units with an ISO currency; there is no floating point anywhere in `packages/payments`.
3. **Prices are computed on the server** from the database at checkout; the client only sends product ids, quantities, and a shipping address.
4. **Append-only double-entry ledger** is the source of truth for balances; payments/refunds/payouts rows are workflow state.
5. **One writer per state machine.** `transitionOrder` is the only code that writes `orders.status`; a DB CHECK is the safety net.
6. **Every mutation is idempotent** (checkout, pay, refund, payout, webhook), and every state change is audited.
7. **No card data touches us.** Payment methods are opaque provider tokens (`tok_`, `pm_`, `src_`); see `docs/security/payments.md`.

## State machines

### Order (`commerce/order-state.ts`)

```
pending_review --approve--> pending_payment --payment captured--> paid --> fulfilled --> completed
      |                          |                                  |          |
      +--reject/expire--> cancelled <--cancel/expire--+             +--refund--+--> partially_refunded / refunded
                                                                    +--dispute--> disputed --won--> (previous state) / --lost--> refunded
```

- `pending_review`: fraud engine said `review`. Stock is reserved (ORDER_REVIEW_HOLD_HOURS), no payment can be created. Staff approve
  (order goes to `pending_payment`, gets a fresh reservation and a `staff_approved` flag so it is not held again; `block` still applies) or reject (cancelled, stock released).
- `pending_payment`: stock reserved for ORDER_RESERVATION_MINUTES. Expired reservations are cancelled by the maintenance job.
- `paid`: capture recorded and ledgered. Fulfilment runs after commit: entitlements (ticket, booking confirmation, community membership, download
  access) are an outbox (`order_entitlements`) that is retried; physical goods wait for the seller (`POST /v1/orders/:id/fulfil`).
- `fulfilled` -> `completed` by the buyer or automatically after ORDER_AUTO_COMPLETE_DAYS (unless a refund is open).
- `cancelled` orders that later receive a successful payment (late 3-DS success) are refunded automatically (`refunds.auto = true`).

### Payment

DB statuses: `requires_payment_method`, `authorized` (sent to the provider, waiting for the webhook; shown to clients as `processing`),
`requires_action`, `captured`, `failed`, `cancelled`, `partially_refunded`, `refunded`, `disputed`. Only the signed webhook produces `captured`; `POST /v1/payments/:id/confirm` merely asks the provider to continue (new method or finished 3-DS challenge) and the outcome still arrives as an event.

### Refund

`requested` -> `approved` -> `processing` -> `succeeded`, or `rejected` / `failed`. Buyers request; the seller (or staff) approves. A seller
refunding directly creates the refund already approved. `processing` refunds are retried by the maintenance job; a stuck automatic refund is an
integrity issue in reconciliation (`auto_refund_failed`). Physical items are restocked by default only if the order was never fulfilled.

### Payout

`pending` / `held` -> `approved` -> `paid`, or `failed` (money returns to the balance through an `adjustment` entry) . Gates: no teen accounts, payout
account with `kyc_status = verified`, positive available balance. Business payouts are owner-only. Requests take an advisory lock per payee so parallel calls cannot overdraw.

## Ledger

Tables `ledger_transactions` / `ledger_entries`: entries are immutable (triggers reject UPDATE/DELETE) and a deferred constraint trigger
requires debits == credits per transaction. `unique (kind, ref_type, ref_id)` makes each posting idempotent.

Accounts:

| Account                                                     | Meaning                                                                                |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `provider:clearing`                                         | Cash held at the payment provider on the platform's behalf                             |
| `platform:fees`                                             | Platform revenue (PLATFORM_FEE_BPS of the subtotal; shipping and tax are pass-through) |
| `seller:user:<id>:payable` / `seller:business:<id>:payable` | What we owe a seller                                                                   |

| Event                                        | Debit                                                                | Credit                              |
| -------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------- |
| Capture (`payment_captured`)                 | clearing (total)                                                     | seller payable (net), platform fees |
| Refund (`refund`)                            | seller payable (refund - fee returned), platform fees (fee returned) | clearing (refund)                   |
| Payout (`payout`)                            | seller payable                                                       | clearing                            |
| Payout failed (`adjustment`/`payout_failed`) | clearing                                                             | seller payable                      |
| Dispute lost (`adjustment`/`dispute_lost`)   | seller payable, platform fees                                        | clearing                            |

The fee returned on a refund is proportional and cumulative (`feeReturnedForRefund`), so refunding in parts never returns more than the fee
collected. Available balance = payable minus amounts still inside the hold (PAYOUT_HOLD_DAYS), computed in SQL.
Global invariants checked in tests: every transaction balances, no seller balance goes negative, cash at the provider equals everything owed.

## Webhook flow (`POST /v1/webhooks/payments/:provider`)

1. The route is public and lives in its own Fastify plugin scope with a raw-string JSON parser so the signature is verified over the exact bytes received.
2. `provider.verifyWebhook(raw, headers)`: Stripe `Stripe-Signature` (`t=...,v1=...`, HMAC-SHA256 over `t.payload`, constant-time compare, tolerance
   PAYMENT_WEBHOOK_TOLERANCE_SEC, any of several `v1` values, replay outside the tolerance rejected); the dev provider uses the same scheme with WEBHOOK_SIGNING_SECRET.
   Invalid => 400 `invalid_signature`, audited (`payment.webhook_rejected`, body hash only), nothing stored.
3. Per event, ONE transaction: insert receipt in `payment_webhook_events` (`unique (provider, event_id)`, `ON CONFLICT DO NOTHING`), apply the
   event (payment/refund/dispute/payout/account state, ledger postings, order transition), mark processed. A duplicate or concurrent duplicate is a no-op.
4. After commit: fulfilment, notifications, auto refunds. These are idempotent and retried by the maintenance job if the process dies between commit and here.

Handled events: payment succeeded/failed/requires-action/cancelled, refund succeeded/failed, dispute opened/closed (won/lost), payout paid/failed, account updated.
Unknown types are stored and ignored.

## Failure modes and what happens

| Failure                                                              | Behaviour                                                                                                               |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Client retries checkout or pay                                       | Same `Idempotency-Key` returns the original result (`idempotent-replayed: true`); same key with a different body is 409 |
| Provider timeout at pay time                                         | Retryable error => 402 `payment_failed`/`provider_unavailable`; the payment row stays; the same key can be retried      |
| Response lost after the provider charged                             | The webhook still arrives and captures the payment                                                                      |
| Webhook delivered twice / in parallel                                | Receipt unique key: processed once                                                                                      |
| Webhook arrives before the pay call returns                          | Applies to the payment row that already exists (created before the provider call)                                       |
| Reservation expires, then payment succeeds                           | Order is cancelled; the payment is captured then refunded automatically                                                 |
| Oversell race                                                        | Product/ticket rows are locked `FOR UPDATE` in id order; loser gets 409                                                 |
| Ticket sold out through another channel between checkout and payment | Entitlement fails permanently, the line is auto-refunded                                                                |
| Refund rejected/failed by the provider                               | Refund `failed` with `failure_code`; order not changed; seller/buyer notified; visible in staff list                    |
| Payout transfer fails                                                | Reversal entry returns the balance, seller notified, staff can retry or fail it                                         |
| Dispute opened                                                       | Order and payment `disputed`, refunds blocked (409), seller notified; lost => reversal booked, order `refunded`         |
| Process crash after commit                                           | `commerce:maintenance` retries fulfilments and processing refunds                                                       |
| Ledger/DB drift                                                      | `GET /v1/staff/reconciliation` reports it (see below)                                                                   |

## Fraud (packages/payments/fraud.ts, apps/api/.../payments/fraud.ts)

Weighted rules over a signal (buyer, hashed IP, card fingerprint/country, amount, history): score >= 50 => `review`, >= 100 => `block`.
Rules: card shared by >= 3 other accounts, IP shared, order/payment velocity, >= 3 failed payments, new account with a >= $200 order in 24 hours, and others.
Evaluated at checkout and again at payment time (a card only known at pay time). A review at checkout creates a held order; at payment time it moves the order to
`pending_review` without charging. Community membership payments treat review as a signal only; block rejects. Every assessment is stored in `fraud_signals` (staff list).
Decisions and rule names are audited. Sellers never see the signal.

## Staff and reconciliation

Staff endpoints need role admin/superadmin and MFA: `/v1/staff/orders`, `/staff/orders/:id/review`, `/staff/refunds`, `/staff/payouts` (+retry/fail),
`/staff/payout-accounts/:id/kyc`, `/staff/disputes`, `/staff/webhook-events`, `/staff/fraud-signals`, `/staff/reconciliation`.

`GET /v1/staff/reconciliation?from&to` compares `provider.listRecords()` with ledger-backed rows (missing at provider, missing in ledger,
amount/status mismatch) and runs internal integrity checks: unbalanced transactions, captured payment/refund/payout without ledger, refund
totals, failed payout not reversed, stuck automatic refund, negative seller balance, paid order without captured payment, unprocessed webhook older than 5 minutes,
entitlement failing repeatedly. `ok` is true only when everything is empty.

## Jobs

`npm run commerce:maintenance` (scripts/commerce-maintenance.ts) runs: release expired reservations, retry pending fulfilments, retry
processing refunds, auto-complete orders. It is idempotent and safe to run every minute or so from cron or a scheduler; nothing in the API process
schedules it, so it MUST be scheduled in every deployed environment.

## What needs real provider credentials (not verifiable in this repo)

- `PAYMENT_PROVIDER=stripe`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`. The adapter is unit-tested for request construction and signature
  verification only; it has never been run against Stripe. `STRIPE_API_BASE_URL` allows pointing it at a mock.
- Stripe Connect onboarding (payout accounts), real KYC. In the dev provider KYC is set by staff (`PUT /v1/staff/payout-accounts/:id/kyc`); with a real provider
  staff cannot mark an account verified: only the provider's `account.updated` event can.
- The production/staging config check refuses `PAYMENT_PROVIDER=dev`.
- The webhook endpoint URL must be registered with the provider (`/v1/webhooks/payments/stripe`).

## Dev provider

Tokens: `tok_success`, `tok_decline`, `tok_insufficient_funds`, `tok_expired_card`, `tok_requires_action` and `pm_card_*` aliases. Modifiers:
`:fp=<id>` sets the card fingerprint and `:cc=<XX>` the card country (e.g. `tok_success:fp=abc:cc=GB`). The plain `tok_success` shares
ONE fingerprint, so several buyers using it will trip the card-sharing fraud rule after three accounts; tests use unique fingerprints.
Webhooks are produced into an outbox and delivered in-process by `deliverLocalWebhooks` right after each provider call (through the same signature check).
Controls for tests: `devSetKyc`, `devFailPayoutsFor`, `devOpenDispute`, `devCloseDispute`, `buildWebhook`.

## Known gaps

- Tax is a seller-declared per-product `tax_bps`, not a tax engine; shipping is a flat per-physical-line placeholder, no carrier rates.
- Membership payments for paid communities have no refund endpoint (only automatic refunds).
- Reservations are not extended during a long 3-DS flow: a late success is auto-refunded instead.
- Multi-currency carts are not supported (one currency per order); no currency conversion.
- Stripe adapter is not exercised against a live account; payouts through Connect and disputes evidence upload are not implemented.
- Log scanning for card numbers is not automated; the integration tests scan every database row instead.
