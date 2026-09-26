-- YAPILAPI Plus: a paid month at a time, never renewed automatically.
-- plus_until lives on profiles (one row per user, already joined wherever a
-- public user is shown) so the Plus badge costs no extra join.
ALTER TABLE profiles ADD COLUMN plus_until timestamptz;

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_purpose_check;
ALTER TABLE orders ADD CONSTRAINT orders_purpose_check CHECK (purpose IN ('products', 'subscription', 'tip', 'booking', 'ad_budget', 'plus'));

-- Every period of Plus someone received, bought or earned by inviting friends.
CREATE TABLE plus_grants (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source         text NOT NULL CHECK (source IN ('purchase', 'referral')),
  days           integer NOT NULL CHECK (days > 0),
  -- A purchase is granted once per paid order.
  order_id       uuid UNIQUE REFERENCES orders(id) ON DELETE SET NULL,
  -- The nth referral reward (1 for the first 3 friends, 2 for the next 3, ...), granted once.
  referral_batch integer CHECK (referral_batch > 0),
  starts_at      timestamptz NOT NULL,
  ends_at        timestamptz NOT NULL,
  revoked_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((source = 'referral') = (referral_batch IS NOT NULL)),
  CHECK (ends_at > starts_at)
);
CREATE INDEX plus_grants_user_idx ON plus_grants (user_id, created_at DESC);
CREATE UNIQUE INDEX plus_grants_referral_batch_idx ON plus_grants (user_id, referral_batch) WHERE referral_batch IS NOT NULL;

-- Invites: one stable, short code per person, created the first time they look for it.
CREATE TABLE invite_codes (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code       text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9]{8}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Who joined with whose code. One referral per new account, never your own.
CREATE TABLE referrals (
  invitee_id   uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  inviter_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The invitee's email with +tags (and Gmail dots) removed, so one mailbox counts once per inviter.
  email_key    text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Set when the invitee confirms their email; only these count toward rewards.
  qualified_at timestamptz,
  CHECK (invitee_id <> inviter_id)
);
CREATE INDEX referrals_inviter_idx ON referrals (inviter_id, created_at DESC);
