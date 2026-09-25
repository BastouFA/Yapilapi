-- 230: Creator economy runtime (creator onboarding + KYC flow, subscription tiers and renewals, tips, gifts, affiliate tracking,
-- brand partnerships). Builds on 005 (creators, subscription_plans, subscriptions, tips, gift_catalog, gifts, affiliate_links,
-- brand_partnerships) and 170 (payments, ledger, payout accounts). Never edits those files. Range 230-259: creator/studio/live/ads.

-- ---------------------------------------------------------------- payments: two more purposes that flow through the same provider + ledger
ALTER TABLE payments DROP CONSTRAINT payments_purpose_check;
ALTER TABLE payments ADD CONSTRAINT payments_purpose_check CHECK (purpose IN ('order','subscription','tip','gift','ticket','booking','community_membership','partnership'));

-- ---------------------------------------------------------------- creators: terms + verification workflow
ALTER TABLE creators
  ADD COLUMN terms_version     text,
  ADD COLUMN kyc_submitted_at  timestamptz,
  ADD COLUMN kyc_decided_at    timestamptz,
  ADD COLUMN kyc_decided_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN kyc_note          text,
  ADD COLUMN previous_mode     text CHECK (previous_mode IS NULL OR previous_mode IN ('personal','creator','professional','business'));

-- Every verification-state change (creator submissions, staff decisions, provider events) is kept: an evidence trail next to audit_logs.
CREATE TABLE creator_kyc_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  creator_id  uuid NOT NULL REFERENCES creators(user_id) ON DELETE CASCADE,
  from_status text NOT NULL,
  to_status   text NOT NULL,
  actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_type  text NOT NULL CHECK (actor_type IN ('creator','staff','provider','system')),
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX creator_kyc_events_creator_idx ON creator_kyc_events (creator_id, created_at DESC);

-- ---------------------------------------------------------------- subscription tiers and renewals
ALTER TABLE subscription_plans
  ADD COLUMN tier integer NOT NULL DEFAULT 1 CHECK (tier BETWEEN 1 AND 10),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX subscription_plans_tier_unique ON subscription_plans (creator_id, tier, interval) WHERE active;
CREATE TRIGGER subscription_plans_updated BEFORE UPDATE ON subscription_plans FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE subscriptions
  ADD COLUMN payment_method_enc text,                      -- opaque provider token, AES-GCM encrypted at rest; never returned by the API
  ADD COLUMN renewal_attempts   integer NOT NULL DEFAULT 0 CHECK (renewal_attempts >= 0),
  ADD COLUMN next_retry_at      timestamptz,
  ADD COLUMN last_failure_code  text,
  ADD COLUMN started_at         timestamptz,
  ADD COLUMN cancelled_at       timestamptz,
  ADD COLUMN ended_at           timestamptz,
  ADD COLUMN end_reason         text CHECK (end_reason IS NULL OR end_reason IN ('cancelled_by_subscriber','cancelled_by_creator','payment_failed','initial_payment_failed','creator_closed','account_deleted'));
CREATE INDEX subscriptions_due_idx ON subscriptions (current_period_end) WHERE status IN ('active','past_due');
CREATE INDEX subscriptions_subscriber_idx ON subscriptions (subscriber_id, status);

-- One row per charge that belongs to a subscription (first payment or renewal). `applied_at` makes the effect (period extension or
-- failure handling) exactly-once no matter how often the settle job runs.
CREATE TABLE subscription_payments (
  payment_id      uuid PRIMARY KEY REFERENCES payments(id) ON DELETE RESTRICT,
  subscription_id uuid NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('initial','renewal')),
  period_start    timestamptz NOT NULL,
  period_end      timestamptz NOT NULL,
  attempt         integer NOT NULL DEFAULT 1,
  applied_at      timestamptz,
  outcome         text CHECK (outcome IS NULL OR outcome IN ('paid','failed')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscription_payments_sub_idx ON subscription_payments (subscription_id, created_at DESC);
CREATE INDEX subscription_payments_open_idx ON subscription_payments (created_at) WHERE applied_at IS NULL;
-- At most one unapplied charge per subscription and period: two workers can never bill the same period twice.
CREATE UNIQUE INDEX subscription_payments_period_unique ON subscription_payments (subscription_id, period_start, attempt);

-- ---------------------------------------------------------------- tips and gifts (money flows through payments; these rows are the meaning)
ALTER TABLE tips
  ADD COLUMN status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed','refunded')),
  ADD COLUMN settled_at timestamptz;
CREATE UNIQUE INDEX tips_payment_unique ON tips (payment_id) WHERE payment_id IS NOT NULL;

ALTER TABLE gift_catalog
  ADD COLUMN description text NOT NULL DEFAULT '',
  ADD COLUMN sort_order integer NOT NULL DEFAULT 0,
  ADD COLUMN created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT gift_code_format CHECK (code ~ '^[a-z0-9_]{2,40}$');
ALTER TABLE gifts
  ADD COLUMN amount_cents bigint CHECK (amount_cents IS NULL OR amount_cents > 0),   -- snapshot of the catalog price at purchase
  ADD COLUMN currency text CHECK (currency IS NULL OR length(currency) = 3),
  ADD COLUMN message text NOT NULL DEFAULT '' CHECK (length(message) <= 200),
  ADD COLUMN status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed','refunded')),
  ADD COLUMN settled_at timestamptz;
CREATE UNIQUE INDEX gifts_payment_unique ON gifts (payment_id) WHERE payment_id IS NOT NULL;
CREATE INDEX gifts_live_idx ON gifts (live_session_id, created_at DESC) WHERE live_session_id IS NOT NULL;

-- ---------------------------------------------------------------- affiliate: clicks (deduplicated per visitor/day) and conversions
ALTER TABLE affiliate_links
  ADD COLUMN active boolean NOT NULL DEFAULT true,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE TRIGGER affiliate_links_updated BEFORE UPDATE ON affiliate_links FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE affiliate_clicks (
  link_id      uuid NOT NULL REFERENCES affiliate_links(id) ON DELETE CASCADE,
  visitor_hash text NOT NULL,                  -- HMAC of (ip, user agent, day): never a raw address, never comparable across days
  day          date NOT NULL,
  viewer_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  hits         integer NOT NULL DEFAULT 1,
  verdict      text NOT NULL CHECK (verdict IN ('counted','bot','self','excessive')),
  first_at     timestamptz NOT NULL DEFAULT now(),
  last_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (link_id, visitor_hash, day)
);
CREATE INDEX affiliate_clicks_viewer_idx ON affiliate_clicks (viewer_id, link_id, day DESC) WHERE viewer_id IS NOT NULL AND verdict = 'counted';
CREATE INDEX affiliate_clicks_day_idx ON affiliate_clicks (link_id, day);

CREATE TABLE affiliate_conversions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id          uuid NOT NULL REFERENCES affiliate_links(id) ON DELETE RESTRICT,
  creator_id       uuid NOT NULL REFERENCES creators(user_id) ON DELETE RESTRICT,
  order_id         uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  order_item_id    uuid NOT NULL REFERENCES order_items(id) ON DELETE RESTRICT,
  buyer_id         uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  seller_user_id   uuid REFERENCES users(id) ON DELETE RESTRICT,
  seller_business_id uuid REFERENCES businesses(id) ON DELETE RESTRICT,
  line_cents       bigint NOT NULL CHECK (line_cents >= 0),
  commission_bps   integer NOT NULL,
  commission_cents bigint NOT NULL CHECK (commission_cents >= 0),
  currency         text NOT NULL CHECK (length(currency) = 3),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','settled','reversed')),
  click_day        date NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  settled_at       timestamptz,
  CONSTRAINT conversion_single_seller CHECK ((seller_user_id IS NULL) <> (seller_business_id IS NULL)),
  UNIQUE (order_item_id)                        -- an order line is attributed at most once, to one link
);
CREATE INDEX affiliate_conversions_creator_idx ON affiliate_conversions (creator_id, created_at DESC);
CREATE INDEX affiliate_conversions_status_idx ON affiliate_conversions (status) WHERE status = 'pending';

-- ---------------------------------------------------------------- brand partnerships: negotiation, deliverables, payment
ALTER TABLE brand_partnerships DROP CONSTRAINT brand_partnerships_status_check;
UPDATE brand_partnerships SET status = 'in_progress' WHERE status = 'active';
UPDATE brand_partnerships SET status = 'paid' WHERE status = 'completed';
ALTER TABLE brand_partnerships
  ADD CONSTRAINT brand_partnerships_status_check CHECK (status IN ('proposed','negotiating','accepted','in_progress','delivered','paid','declined','cancelled')),
  ADD COLUMN title            text NOT NULL DEFAULT '',
  ADD COLUMN brief            text NOT NULL DEFAULT '' CHECK (length(brief) <= 4000),
  ADD COLUMN amount_cents     bigint CHECK (amount_cents IS NULL OR amount_cents > 0),
  ADD COLUMN currency         text CHECK (currency IS NULL OR length(currency) = 3),
  ADD COLUMN proposed_by      text NOT NULL DEFAULT 'business' CHECK (proposed_by IN ('creator','business')),
  ADD COLUMN terms_version    integer NOT NULL DEFAULT 1,
  ADD COLUMN creator_accepted_version  integer,
  ADD COLUMN business_accepted_version integer,
  ADD COLUMN payment_id       uuid REFERENCES payments(id) ON DELETE RESTRICT,
  ADD COLUMN updated_at       timestamptz NOT NULL DEFAULT now(),
  -- Disclosure is not optional: the flag exists for the record, and the constraint keeps it true.
  ADD CONSTRAINT brand_partnerships_disclosure_check CHECK (disclosure_required);
CREATE TRIGGER brand_partnerships_updated BEFORE UPDATE ON brand_partnerships FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX brand_partnerships_business_idx ON brand_partnerships (business_id, status);
CREATE UNIQUE INDEX brand_partnerships_payment_unique ON brand_partnerships (payment_id) WHERE payment_id IS NOT NULL;

CREATE TABLE partnership_deliverables (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partnership_id uuid NOT NULL REFERENCES brand_partnerships(id) ON DELETE CASCADE,
  title          text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  kind           text NOT NULL DEFAULT 'post' CHECK (kind IN ('post','video','story','live','other')),
  due_at         timestamptz,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','submitted','approved','rejected')),
  post_id        uuid REFERENCES posts(id) ON DELETE SET NULL,
  review_note    text,
  submitted_at   timestamptz,
  decided_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX partnership_deliverables_idx ON partnership_deliverables (partnership_id, status);

CREATE TABLE partnership_events (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  partnership_id uuid NOT NULL REFERENCES brand_partnerships(id) ON DELETE CASCADE,
  actor_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_side     text NOT NULL CHECK (actor_side IN ('creator','business','system')),
  event          text NOT NULL,
  from_status    text,
  to_status      text,
  data           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX partnership_events_idx ON partnership_events (partnership_id, id);

-- Sponsored posts carry posts.metadata.sponsored = {partnershipId, businessId, label}. This index finds them.
CREATE INDEX posts_sponsored_idx ON posts ((metadata->'sponsored'->>'partnershipId')) WHERE metadata ? 'sponsored';
