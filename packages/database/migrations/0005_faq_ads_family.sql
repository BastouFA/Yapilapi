-- Community FAQ and similar-question lookup, advertising campaigns (paid,
-- consent-gated, adults only), family links and teen controls, daily usage.

-- ─── Community FAQ ─────────────────────────────────────────────────────
CREATE TABLE community_faqs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  question     text NOT NULL CHECK (length(question) BETWEEN 5 AND 300),
  answer       text NOT NULL CHECK (length(answer) BETWEEN 1 AND 4000),
  position     integer NOT NULL DEFAULT 0,
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX community_faqs_community_idx ON community_faqs (community_id, position);
CREATE INDEX community_faqs_trgm_idx ON community_faqs USING gin (question gin_trgm_ops);
CREATE TRIGGER community_faqs_updated BEFORE UPDATE ON community_faqs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Trigram index for "has this been asked before?" inside a community.
CREATE INDEX posts_community_body_trgm_idx ON posts USING gin (body gin_trgm_ops) WHERE community_id IS NOT NULL AND deleted_at IS NULL;

-- ─── Advertising ───────────────────────────────────────────────────────
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_purpose_check;
ALTER TABLE orders ADD CONSTRAINT orders_purpose_check CHECK (purpose IN ('products', 'subscription', 'tip', 'booking', 'ad_budget'));

CREATE TABLE ad_campaigns (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  advertiser_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id            uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  name               text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'ended', 'rejected')),
  topics             text[] NOT NULL DEFAULT '{}',
  locales            text[] NOT NULL DEFAULT '{}',
  cpm_cents          integer NOT NULL DEFAULT 500 CHECK (cpm_cents BETWEEN 100 AND 10000),
  currency           text NOT NULL DEFAULT 'USD',
  -- Money is tracked in millicents (1/1000 of a cent) so a single impression can be charged.
  budget_millicents  bigint NOT NULL DEFAULT 0 CHECK (budget_millicents >= 0),
  spent_millicents   bigint NOT NULL DEFAULT 0 CHECK (spent_millicents >= 0),
  impressions        integer NOT NULL DEFAULT 0,
  clicks             integer NOT NULL DEFAULT 0,
  starts_at          timestamptz,
  ends_at            timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ad_campaigns_active_idx ON ad_campaigns (status) WHERE status = 'active';
CREATE INDEX ad_campaigns_advertiser_idx ON ad_campaigns (advertiser_id, created_at DESC);
CREATE TRIGGER ad_campaigns_updated BEFORE UPDATE ON ad_campaigns FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE orders ADD COLUMN campaign_id uuid REFERENCES ad_campaigns(id) ON DELETE SET NULL;

CREATE TABLE ad_events (
  id          bigserial PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  kind        text NOT NULL CHECK (kind IN ('impression', 'click', 'hide')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ad_events_campaign_idx ON ad_events (campaign_id, created_at);
CREATE INDEX ad_events_user_idx ON ad_events (user_id, campaign_id, created_at DESC);

-- ─── Family links and teen controls ────────────────────────────────────
CREATE TABLE family_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guardian_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  teen_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'ended')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  ended_at    timestamptz,
  CHECK (guardian_id <> teen_id)
);
CREATE UNIQUE INDEX family_links_open_key ON family_links (guardian_id, teen_id) WHERE status IN ('pending', 'active');
CREATE INDEX family_links_teen_idx ON family_links (teen_id) WHERE status IN ('pending', 'active');

CREATE TABLE teen_controls (
  teen_id              uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  messages_from        text NOT NULL DEFAULT 'friends' CHECK (messages_from IN ('friends', 'nobody')),
  daily_limit_minutes  integer CHECK (daily_limit_minutes BETWEEN 15 AND 720),
  quiet_start          time,
  quiet_end            time,
  timezone             text NOT NULL DEFAULT 'UTC',
  updated_by           uuid REFERENCES users(id),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE usage_days (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day     date NOT NULL,
  minutes integer NOT NULL DEFAULT 0 CHECK (minutes >= 0),
  last_beat_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day)
);

-- ─── Live gifts ────────────────────────────────────────────────────────
-- A paid tip sent during a live appears in the live chat as a gift.
ALTER TABLE live_chat DROP CONSTRAINT IF EXISTS live_chat_kind_check;
ALTER TABLE live_chat ADD CONSTRAINT live_chat_kind_check CHECK (kind IN ('chat', 'question', 'reaction', 'gift'));
ALTER TABLE live_chat ADD COLUMN amount_cents integer;
ALTER TABLE live_chat ADD COLUMN currency text;
