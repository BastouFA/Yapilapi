-- 005: Payments (provider-abstracted), double-entry ledger, refunds, payouts,
-- creator economy, live sessions, advertising.
-- No raw card data is ever stored: only opaque provider references.

CREATE TABLE payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payer_id        uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  order_id        uuid REFERENCES orders(id) ON DELETE RESTRICT,
  purpose         text NOT NULL CHECK (purpose IN ('order','subscription','tip','gift','ticket','booking','community_membership')),
  amount_cents    bigint NOT NULL CHECK (amount_cents > 0),
  currency        text NOT NULL CHECK (length(currency) = 3),
  platform_fee_cents bigint NOT NULL DEFAULT 0 CHECK (platform_fee_cents >= 0),
  provider        text NOT NULL,
  provider_ref    text,
  client_secret_ref text,                     -- opaque handle for the client SDK, never a card number
  status          text NOT NULL DEFAULT 'requires_payment_method'
                  CHECK (status IN ('requires_payment_method','requires_action','authorized','captured','failed','cancelled','refunded','partially_refunded','disputed')),
  failure_code    text,
  idempotency_key text NOT NULL,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payer_id, idempotency_key),
  CONSTRAINT fee_within_amount CHECK (platform_fee_cents <= amount_cents)
);
CREATE UNIQUE INDEX payments_provider_ref_unique ON payments (provider, provider_ref) WHERE provider_ref IS NOT NULL;
CREATE INDEX payments_order_idx ON payments (order_id);
CREATE INDEX payments_payer_idx ON payments (payer_id, created_at DESC);
CREATE INDEX payments_status_idx ON payments (status);
CREATE TRIGGER payments_updated BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE refunds (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id      uuid NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  order_id        uuid REFERENCES orders(id) ON DELETE RESTRICT,
  amount_cents    bigint NOT NULL CHECK (amount_cents > 0),
  currency        text NOT NULL CHECK (length(currency) = 3),
  reason          text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'requested'
                  CHECK (status IN ('requested','approved','processing','succeeded','failed','rejected')),
  requested_by    uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  decided_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  decision_note   text,
  provider_ref    text,
  idempotency_key text NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refunds_payment_idx ON refunds (payment_id);
CREATE INDEX refunds_status_idx ON refunds (status);
CREATE TRIGGER refunds_updated BEFORE UPDATE ON refunds FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Webhook receipts: verified signature + de-duplication by provider event id.
CREATE TABLE payment_webhook_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider       text NOT NULL,
  event_id       text NOT NULL,
  event_type     text NOT NULL,
  payload        jsonb NOT NULL,
  signature_valid boolean NOT NULL,
  processed_at   timestamptz,
  error          text,
  received_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)
);

-- ---------------------------------------------------------------- double-entry ledger
CREATE TABLE ledger_transactions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text NOT NULL CHECK (kind IN ('payment_captured','refund','payout','fee','adjustment')),
  ref_type   text NOT NULL,
  ref_id     uuid NOT NULL,
  currency   text NOT NULL CHECK (length(currency) = 3),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, ref_type, ref_id)              -- a payment can be captured into the ledger only once
);
CREATE TABLE ledger_entries (
  id             bigserial PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
  account        text NOT NULL,                -- e.g. provider:clearing, seller:<id>:payable, platform:fees
  direction      text NOT NULL CHECK (direction IN ('debit','credit')),
  amount_cents   bigint NOT NULL CHECK (amount_cents > 0),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_tx_idx ON ledger_entries (transaction_id);
CREATE INDEX ledger_entries_account_idx ON ledger_entries (account);

CREATE OR REPLACE FUNCTION ledger_assert_balanced() RETURNS trigger AS $$
DECLARE d bigint; c bigint;
BEGIN
  SELECT COALESCE(SUM(amount_cents) FILTER (WHERE direction = 'debit'), 0),
         COALESCE(SUM(amount_cents) FILTER (WHERE direction = 'credit'), 0)
    INTO d, c FROM ledger_entries WHERE transaction_id = NEW.transaction_id;
  IF d <> c THEN
    RAISE EXCEPTION 'ledger transaction % is unbalanced (debit %, credit %)', NEW.transaction_id, d, c;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT ON ledger_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_assert_balanced();

-- Ledger rows are immutable.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed (append-only table)', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_entries_immutable BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_transactions_immutable BEFORE UPDATE OR DELETE ON ledger_transactions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- creator economy
CREATE TABLE creators (
  user_id          uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  kyc_status       text NOT NULL DEFAULT 'unverified' CHECK (kyc_status IN ('unverified','pending','verified','rejected')),
  payout_account_ref text,                       -- opaque provider connected-account id
  terms_accepted_at timestamptz,
  category         text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER creators_updated BEFORE UPDATE ON creators FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE subscription_plans (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id   uuid NOT NULL REFERENCES creators(user_id) ON DELETE CASCADE,
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  price_cents  integer NOT NULL CHECK (price_cents > 0),
  currency     text NOT NULL CHECK (length(currency) = 3),
  interval     text NOT NULL CHECK (interval IN ('month','year')),
  benefits     jsonb NOT NULL DEFAULT '[]'::jsonb,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscription_plans_creator_idx ON subscription_plans (creator_id) WHERE active;

CREATE TABLE subscriptions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id            uuid NOT NULL REFERENCES subscription_plans(id) ON DELETE RESTRICT,
  creator_id         uuid NOT NULL REFERENCES creators(user_id) ON DELETE RESTRICT,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('incomplete','active','past_due','cancelled','expired')),
  current_period_end timestamptz NOT NULL,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  provider_ref       text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX subscriptions_active_unique ON subscriptions (subscriber_id, creator_id) WHERE status IN ('incomplete','active','past_due');
CREATE INDEX subscriptions_creator_idx ON subscriptions (creator_id, status);
CREATE TRIGGER subscriptions_updated BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE tips (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  creator_id   uuid NOT NULL REFERENCES creators(user_id) ON DELETE RESTRICT,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  currency     text NOT NULL CHECK (length(currency) = 3),
  message      text NOT NULL DEFAULT '' CHECK (length(message) <= 500),
  post_id      uuid REFERENCES posts(id) ON DELETE SET NULL,
  payment_id   uuid REFERENCES payments(id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (from_user_id <> creator_id)
);
CREATE INDEX tips_creator_idx ON tips (creator_id, created_at DESC);

CREATE TABLE gift_catalog (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL UNIQUE,
  name         text NOT NULL,
  price_cents  integer NOT NULL CHECK (price_cents > 0),
  currency     text NOT NULL CHECK (length(currency) = 3),
  active       boolean NOT NULL DEFAULT true
);
CREATE TABLE gifts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  creator_id   uuid NOT NULL REFERENCES creators(user_id) ON DELETE RESTRICT,
  gift_id      uuid NOT NULL REFERENCES gift_catalog(id) ON DELETE RESTRICT,
  live_session_id uuid,
  payment_id   uuid REFERENCES payments(id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (from_user_id <> creator_id)
);
CREATE INDEX gifts_creator_idx ON gifts (creator_id, created_at DESC);

CREATE TABLE payouts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payee_user_id  uuid REFERENCES users(id) ON DELETE RESTRICT,
  payee_business_id uuid REFERENCES businesses(id) ON DELETE RESTRICT,
  amount_cents   bigint NOT NULL CHECK (amount_cents > 0),
  currency       text NOT NULL CHECK (length(currency) = 3),
  status         text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','verifying','approved','paid','failed','held')),
  period_start   timestamptz,
  period_end     timestamptz,
  provider_ref   text,
  verification   jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text NOT NULL UNIQUE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payout_has_exactly_one_payee CHECK ((payee_user_id IS NULL) <> (payee_business_id IS NULL))
);
CREATE INDEX payouts_status_idx ON payouts (status);
CREATE TRIGGER payouts_updated BEFORE UPDATE ON payouts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE affiliate_links (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id     uuid NOT NULL REFERENCES creators(user_id) ON DELETE CASCADE,
  product_id     uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  code           text NOT NULL UNIQUE,
  commission_bps integer NOT NULL CHECK (commission_bps BETWEEN 0 AND 5000),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (creator_id, product_id)
);

CREATE TABLE brand_partnerships (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id  uuid NOT NULL REFERENCES creators(user_id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','active','declined','completed','cancelled')),
  terms       jsonb NOT NULL DEFAULT '{}'::jsonb,
  disclosure_required boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX brand_partnerships_creator_idx ON brand_partnerships (creator_id);

-- ---------------------------------------------------------------- live
CREATE TABLE live_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           text NOT NULL,
  description     text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','live','ended','cancelled')),
  visibility      text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','followers','subscribers','private')),
  scheduled_for   timestamptz,
  started_at      timestamptz,
  ended_at        timestamptz,
  chat_conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  ingest_ref      text,                 -- opaque stream key handle held by the RTC provider
  ticket_type_id  uuid REFERENCES event_ticket_types(id) ON DELETE SET NULL,
  event_id        uuid REFERENCES events(id) ON DELETE SET NULL,
  peak_viewers    integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX live_sessions_status_idx ON live_sessions (status, started_at DESC);
CREATE INDEX live_sessions_host_idx ON live_sessions (host_id, created_at DESC);
CREATE TRIGGER live_sessions_updated BEFORE UPDATE ON live_sessions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE gifts ADD CONSTRAINT gifts_live_fk FOREIGN KEY (live_session_id) REFERENCES live_sessions(id) ON DELETE SET NULL;

CREATE TABLE live_participants (
  live_id    uuid NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('host','cohost','moderator','audience')),
  joined_at  timestamptz NOT NULL DEFAULT now(),
  left_at    timestamptz,
  PRIMARY KEY (live_id, user_id)
);
CREATE TABLE live_products (
  live_id    uuid NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  PRIMARY KEY (live_id, product_id)
);
CREATE TABLE live_questions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  live_id    uuid NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  asker_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       text NOT NULL CHECK (length(body) BETWEEN 1 AND 500),
  status     text NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','dismissed')),
  upvotes    integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX live_questions_live_idx ON live_questions (live_id, status, upvotes DESC);
CREATE TABLE live_clips (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  live_id        uuid NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  media_id       uuid REFERENCES media(id) ON DELETE SET NULL,
  start_ms       integer NOT NULL,
  end_ms         integer NOT NULL,
  auto_generated boolean NOT NULL DEFAULT false,
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','published','rejected')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (end_ms > start_ms)
);

-- ---------------------------------------------------------------- creator studio: projects and AI suggestions (never auto-published)
CREATE TABLE studio_projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       text NOT NULL,
  media_id    uuid REFERENCES media(id) ON DELETE SET NULL,
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','processing','ready','published')),
  edits       jsonb NOT NULL DEFAULT '[]'::jsonb,        -- [{op:"trim",start_ms,end_ms}, ...]
  captions    jsonb NOT NULL DEFAULT '[]'::jsonb,
  published_post_id uuid REFERENCES posts(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX studio_projects_owner_idx ON studio_projects (owner_id, updated_at DESC);
CREATE TRIGGER studio_projects_updated BEFORE UPDATE ON studio_projects FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------- advertising
CREATE TABLE ad_campaigns (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id        uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name               text NOT NULL,
  objective          text NOT NULL DEFAULT 'awareness' CHECK (objective IN ('awareness','traffic','events','sales','bookings')),
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_review','active','paused','ended','rejected')),
  daily_budget_cents bigint NOT NULL CHECK (daily_budget_cents >= 0),
  total_budget_cents bigint NOT NULL CHECK (total_budget_cents >= 0),
  spent_cents        bigint NOT NULL DEFAULT 0 CHECK (spent_cents >= 0),
  currency           text NOT NULL CHECK (length(currency) = 3),
  starts_at          timestamptz,
  ends_at            timestamptz,
  targeting          jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {topics:[], languages:[], age_band:"adult", geo:{}}; no sensitive attributes
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER ad_campaigns_updated BEFORE UPDATE ON ad_campaigns FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TABLE advertisements (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  uuid NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  headline     text NOT NULL CHECK (length(headline) <= 120),
  body         text NOT NULL DEFAULT '' CHECK (length(body) <= 500),
  media_id     uuid REFERENCES media(id) ON DELETE SET NULL,
  target_type  text CHECK (target_type IN ('event','product','place','business','url')),
  target_id    uuid,
  target_url   text,
  status       text NOT NULL DEFAULT 'pending_review' CHECK (status IN ('draft','pending_review','approved','rejected','paused')),
  moderation_status text NOT NULL DEFAULT 'pending_review'
               CHECK (moderation_status IN ('approved','pending_review','restricted','removed','escalated')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX advertisements_campaign_idx ON advertisements (campaign_id);
