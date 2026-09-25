-- 250: Advertising runtime. Builds on 005 (ad_campaigns, advertisements). Contextual/interest/geo targeting only (validated in the API),
-- staff review with reasons, signed impression tokens, deduplicated impressions/clicks with fraud verdicts, budget-safe spend accrual
-- and ledger settlement (receivable from the advertiser, revenue for the platform).

ALTER TABLE ad_campaigns
  ALTER COLUMN business_id DROP NOT NULL,
  ADD COLUMN owner_user_id     uuid REFERENCES users(id) ON DELETE CASCADE,       -- creators can advertise as themselves
  ADD COLUMN bid_model         text NOT NULL DEFAULT 'cpm' CHECK (bid_model IN ('cpm','cpc')),
  ADD COLUMN bid_cents         integer NOT NULL DEFAULT 100 CHECK (bid_cents BETWEEN 1 AND 100000),   -- per 1000 impressions (cpm) or per click (cpc)
  ADD COLUMN spent_milli       bigint NOT NULL DEFAULT 0 CHECK (spent_milli >= 0),                    -- 1/1000 cent: exact per-impression accrual
  ADD COLUMN settled_milli     bigint NOT NULL DEFAULT 0 CHECK (settled_milli >= 0),
  ADD COLUMN submitted_at      timestamptz,
  ADD COLUMN review_note       text,
  ADD COLUMN reviewed_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN reviewed_at       timestamptz,
  ADD COLUMN frequency_cap     integer NOT NULL DEFAULT 3 CHECK (frequency_cap BETWEEN 1 AND 20),     -- impressions per viewer per ad per 24h
  ADD CONSTRAINT ad_campaign_one_owner CHECK ((business_id IS NULL) <> (owner_user_id IS NULL)),
  ADD CONSTRAINT ad_campaign_budget_order CHECK (daily_budget_cents <= total_budget_cents),
  ADD CONSTRAINT ad_campaign_schedule_order CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at),
  ADD CONSTRAINT ad_campaign_settled_within_spent CHECK (settled_milli <= spent_milli);
CREATE INDEX ad_campaigns_owner_user_idx ON ad_campaigns (owner_user_id, created_at DESC) WHERE owner_user_id IS NOT NULL;
CREATE INDEX ad_campaigns_business_idx ON ad_campaigns (business_id, created_at DESC) WHERE business_id IS NOT NULL;
CREATE INDEX ad_campaigns_review_idx ON ad_campaigns (submitted_at) WHERE status = 'pending_review';
CREATE INDEX ad_campaigns_active_idx ON ad_campaigns (starts_at, ends_at) WHERE status = 'active';

ALTER TABLE advertisements
  ADD COLUMN placement    text NOT NULL DEFAULT 'feed' CHECK (placement IN ('feed','search','discover','profile')),
  ADD COLUMN review_note  text,
  ADD COLUMN reviewed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN reviewed_at  timestamptz,
  ADD COLUMN updated_at   timestamptz NOT NULL DEFAULT now();
CREATE TRIGGER advertisements_updated BEFORE UPDATE ON advertisements FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX advertisements_serving_idx ON advertisements (placement, campaign_id) WHERE status = 'approved';

CREATE TABLE ad_review_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  ad_id       uuid REFERENCES advertisements(id) ON DELETE CASCADE,
  actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  event       text NOT NULL,
  from_status text,
  to_status   text,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ad_review_events_campaign_idx ON ad_review_events (campaign_id, id);

-- Each impression is bound to a server-issued token (unique nonce): a replayed or forged log request cannot create a second one.
CREATE TABLE ad_impressions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ad_id       uuid NOT NULL REFERENCES advertisements(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  viewer_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  nonce       text NOT NULL UNIQUE,
  placement   text NOT NULL,
  issued_at   timestamptz NOT NULL,
  ip_hash     text,
  valid       boolean NOT NULL,
  reason      text,
  cost_milli  bigint NOT NULL DEFAULT 0 CHECK (cost_milli >= 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ad_impressions_freq_idx ON ad_impressions (viewer_id, ad_id, created_at DESC) WHERE valid AND viewer_id IS NOT NULL;
CREATE INDEX ad_impressions_campaign_idx ON ad_impressions (campaign_id, created_at);

CREATE TABLE ad_clicks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  impression_id uuid NOT NULL UNIQUE REFERENCES ad_impressions(id) ON DELETE CASCADE,   -- at most one billable click per impression
  ad_id         uuid NOT NULL REFERENCES advertisements(id) ON DELETE CASCADE,
  campaign_id   uuid NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  viewer_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  ip_hash       text,
  valid         boolean NOT NULL,
  reason        text,
  cost_milli    bigint NOT NULL DEFAULT 0 CHECK (cost_milli >= 0),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ad_clicks_campaign_idx ON ad_clicks (campaign_id, created_at);
CREATE INDEX ad_clicks_ip_idx ON ad_clicks (ip_hash, created_at) WHERE ip_hash IS NOT NULL;

CREATE TABLE ad_daily_spend (
  campaign_id uuid NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  day         date NOT NULL,
  spent_milli bigint NOT NULL DEFAULT 0 CHECK (spent_milli >= 0),
  PRIMARY KEY (campaign_id, day)
);

CREATE TABLE ad_settlements (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  uuid NOT NULL REFERENCES ad_campaigns(id) ON DELETE RESTRICT,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  currency     text NOT NULL CHECK (length(currency) = 3),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ad_settlements_campaign_idx ON ad_settlements (campaign_id, created_at);
