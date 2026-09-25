-- 170: Commerce and payments runtime. Builds on 004 (products, orders, order_items, bookings, tickets) and 005 (payments, refunds,
-- webhook receipts, ledger, payouts). Never edits those files. Range 170-189 belongs to commerce/payments.

-- ---------------------------------------------------------------- orders
-- The state machine (apps/api/src/modules/commerce/order-state.ts) is the only writer of `status`; this CHECK is the safety net.
ALTER TABLE orders DROP CONSTRAINT orders_status_check;
UPDATE orders SET status = 'pending_review' WHERE status = 'under_review';
ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (status IN
  ('pending_review','pending_payment','paid','fulfilled','completed','cancelled','refunded','partially_refunded','disputed'));

-- Tax is an explicit seller-declared placeholder (products.tax_bps), not a tax engine.
ALTER TABLE orders DROP CONSTRAINT order_total_consistent;
ALTER TABLE orders
  ADD COLUMN tax_cents        bigint NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  ADD COLUMN request_hash     text,                              -- sha256 of the canonical checkout payload (idempotency-key reuse detection)
  ADD COLUMN reserved_until   timestamptz,                       -- stock reservation deadline while pending
  ADD COLUMN prior_status     text,                              -- status to restore when a dispute is won
  ADD COLUMN paid_at          timestamptz,
  ADD COLUMN fulfilled_at     timestamptz,
  ADD COLUMN completed_at     timestamptz,
  ADD COLUMN cancelled_at     timestamptz,
  ADD COLUMN cancel_reason    text,
  ADD COLUMN ip_hash          text,
  ADD COLUMN shipping_country text CHECK (shipping_country IS NULL OR length(shipping_country) = 2),
  ADD COLUMN refunded_cents   bigint NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
  ADD COLUMN tracking         jsonb,
  ADD COLUMN fraud_decision   text CHECK (fraud_decision IS NULL OR fraud_decision IN ('allow','review','block')),
  ADD CONSTRAINT order_total_consistent CHECK (total_cents = subtotal_cents + shipping_cents + tax_cents),
  ADD CONSTRAINT order_refund_within_total CHECK (refunded_cents <= total_cents);
CREATE INDEX orders_seller_user_idx ON orders (seller_user_id, created_at DESC) WHERE seller_user_id IS NOT NULL;
CREATE INDEX orders_reservation_idx ON orders (reserved_until) WHERE status IN ('pending_payment','pending_review');
CREATE INDEX orders_review_idx ON orders (created_at) WHERE status = 'pending_review';
CREATE INDEX orders_ip_hash_idx ON orders (ip_hash, created_at) WHERE ip_hash IS NOT NULL;

ALTER TABLE order_items
  ADD COLUMN tax_cents        bigint NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  ADD COLUMN product_kind     text,
  ADD COLUMN booking_id       uuid REFERENCES bookings(id) ON DELETE SET NULL,
  ADD COLUMN event_id         uuid REFERENCES events(id) ON DELETE SET NULL,
  ADD COLUMN stock_state      text NOT NULL DEFAULT 'none' CHECK (stock_state IN ('none','held','committed','released')),
  ADD COLUMN refunded_cents   bigint NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0);
CREATE INDEX order_items_product_idx ON order_items (product_id) WHERE product_id IS NOT NULL;
CREATE INDEX order_items_ticket_type_idx ON order_items (ticket_type_id) WHERE ticket_type_id IS NOT NULL;

ALTER TABLE products ADD COLUMN tax_bps integer NOT NULL DEFAULT 0 CHECK (tax_bps BETWEEN 0 AND 3000);

-- ---------------------------------------------------------------- entitlements: what a payment unlocks (outbox for fulfilment)
CREATE TABLE order_entitlements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id    uuid NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  order_id      uuid REFERENCES orders(id) ON DELETE RESTRICT,
  order_item_id uuid REFERENCES order_items(id) ON DELETE RESTRICT,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind          text NOT NULL CHECK (kind IN ('digital','ticket','booking','community')),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','granted','failed','revoked')),
  ref_id        uuid,                                    -- product / ticket type / booking / community
  quantity      integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  attempts      integer NOT NULL DEFAULT 0,
  claimed_at    timestamptz,
  last_error    text,
  granted_at    timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX order_entitlements_item_unique ON order_entitlements (order_item_id) WHERE order_item_id IS NOT NULL;
CREATE UNIQUE INDEX order_entitlements_community_unique ON order_entitlements (payment_id) WHERE kind = 'community';
CREATE INDEX order_entitlements_pending_idx ON order_entitlements (created_at) WHERE status = 'pending';
CREATE INDEX order_entitlements_user_idx ON order_entitlements (user_id, kind, status);
CREATE TRIGGER order_entitlements_updated BEFORE UPDATE ON order_entitlements FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------- payments
ALTER TABLE payments
  ADD COLUMN captured_at        timestamptz,
  ADD COLUMN seller_user_id     uuid REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN seller_business_id uuid REFERENCES businesses(id) ON DELETE RESTRICT,
  ADD COLUMN card_fingerprint   text,                    -- opaque provider fingerprint, used for velocity rules only
  ADD COLUMN card_country       text,
  ADD COLUMN ip_hash            text,
  ADD COLUMN refunded_cents     bigint NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
  ADD COLUMN request_hash       text,
  ADD CONSTRAINT payment_single_payee CHECK (seller_user_id IS NULL OR seller_business_id IS NULL),
  ADD CONSTRAINT payment_refund_within_amount CHECK (refunded_cents <= amount_cents);
-- At most one in-flight and at most one settled payment per order: no double charges.
CREATE UNIQUE INDEX payments_one_open_per_order ON payments (order_id)
  WHERE order_id IS NOT NULL AND status IN ('requires_payment_method','requires_action','authorized');
CREATE UNIQUE INDEX payments_one_settled_per_order ON payments (order_id)
  WHERE order_id IS NOT NULL AND status IN ('captured','partially_refunded','refunded','disputed');
CREATE INDEX payments_fingerprint_idx ON payments (card_fingerprint, created_at) WHERE card_fingerprint IS NOT NULL;
CREATE INDEX payments_ip_hash_idx ON payments (ip_hash, created_at) WHERE ip_hash IS NOT NULL;
CREATE INDEX payments_seller_idx ON payments (seller_user_id) WHERE seller_user_id IS NOT NULL;

-- ---------------------------------------------------------------- refunds
ALTER TABLE refunds
  ADD COLUMN item_id            uuid REFERENCES order_items(id) ON DELETE RESTRICT,   -- line refund: entitlements of the line are revoked
  ADD COLUMN restock            boolean NOT NULL DEFAULT false,
  ADD COLUMN auto               boolean NOT NULL DEFAULT false,                      -- issued by the system (failed fulfilment, late payment)
  ADD COLUMN fee_returned_cents bigint NOT NULL DEFAULT 0 CHECK (fee_returned_cents >= 0),
  ADD COLUMN failure_code       text,
  ADD COLUMN decided_at         timestamptz,
  ADD COLUMN succeeded_at       timestamptz;
CREATE INDEX refunds_order_idx ON refunds (order_id);

-- ---------------------------------------------------------------- disputes (minimal state)
CREATE TABLE disputes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id   uuid NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  order_id     uuid REFERENCES orders(id) ON DELETE RESTRICT,
  provider     text NOT NULL,
  provider_ref text NOT NULL,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','won','lost')),
  reason       text,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  currency     text NOT NULL CHECK (length(currency) = 3),
  opened_at    timestamptz NOT NULL DEFAULT now(),
  closed_at    timestamptz,
  UNIQUE (provider, provider_ref)
);
CREATE INDEX disputes_status_idx ON disputes (status, opened_at DESC);
CREATE INDEX disputes_payment_idx ON disputes (payment_id);

-- ---------------------------------------------------------------- payout accounts (opaque provider account refs; KYC gate)
CREATE TABLE payout_accounts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id      uuid REFERENCES users(id) ON DELETE RESTRICT,
  owner_business_id  uuid REFERENCES businesses(id) ON DELETE RESTRICT,
  provider           text NOT NULL,
  account_ref        text NOT NULL,
  kyc_status         text NOT NULL DEFAULT 'pending' CHECK (kyc_status IN ('unverified','pending','verified','rejected')),
  country            text NOT NULL CHECK (length(country) = 2),
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  verified_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payout_account_one_owner CHECK ((owner_user_id IS NULL) <> (owner_business_id IS NULL)),
  UNIQUE (provider, account_ref)
);
CREATE UNIQUE INDEX payout_accounts_user_unique ON payout_accounts (owner_user_id) WHERE owner_user_id IS NOT NULL AND status <> 'closed';
CREATE UNIQUE INDEX payout_accounts_business_unique ON payout_accounts (owner_business_id) WHERE owner_business_id IS NOT NULL AND status <> 'closed';
CREATE TRIGGER payout_accounts_updated BEFORE UPDATE ON payout_accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE payouts
  ADD COLUMN account_id   uuid REFERENCES payout_accounts(id) ON DELETE RESTRICT,
  ADD COLUMN requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN failure_code text;
CREATE INDEX payouts_payee_user_idx ON payouts (payee_user_id, created_at DESC) WHERE payee_user_id IS NOT NULL;
CREATE INDEX payouts_payee_business_idx ON payouts (payee_business_id, created_at DESC) WHERE payee_business_id IS NOT NULL;

-- ---------------------------------------------------------------- fraud signals (what the rules engine saw and decided)
CREATE TABLE fraud_signals (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  subject_type text NOT NULL CHECK (subject_type IN ('order','payment')),
  subject_id   uuid,
  stage        text NOT NULL CHECK (stage IN ('checkout','payment')),
  decision     text NOT NULL CHECK (decision IN ('allow','review','block')),
  score        integer NOT NULL,
  reasons      jsonb NOT NULL DEFAULT '[]'::jsonb,
  signals      jsonb NOT NULL DEFAULT '{}'::jsonb,        -- counters and country codes only; no card data, no raw IP
  ip_hash      text,
  card_fingerprint text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fraud_signals_user_idx ON fraud_signals (user_id, created_at DESC);
CREATE INDEX fraud_signals_decision_idx ON fraud_signals (decision, created_at DESC) WHERE decision <> 'allow';
CREATE INDEX fraud_signals_ip_idx ON fraud_signals (ip_hash, created_at) WHERE ip_hash IS NOT NULL;
CREATE INDEX fraud_signals_fp_idx ON fraud_signals (card_fingerprint, created_at) WHERE card_fingerprint IS NOT NULL;

-- Webhook receipts: also index unprocessed rows so staff can find events that failed.
CREATE INDEX payment_webhook_events_pending_idx ON payment_webhook_events (received_at) WHERE processed_at IS NULL;

-- Review helper: a review's product is `target_id`; aggregates are maintained transactionally in code.
CREATE INDEX reviews_product_author_idx ON reviews (target_id, author_id) WHERE target_type = 'product';
