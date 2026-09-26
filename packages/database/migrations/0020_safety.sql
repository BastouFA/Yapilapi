-- Launch safety pack: phone verification, spam and bot signals, and automated
-- image and video moderation.

-- ── Phone verification ─────────────────────────────────────────────────
-- The number someone added (E.164) and when they confirmed it with a code.
ALTER TABLE users ADD COLUMN phone_e164 text;
ALTER TABLE users ADD COLUMN phone_verified_at timestamptz;
-- A number can be verified on one account at a time.
CREATE UNIQUE INDEX users_verified_phone_key ON users (phone_e164) WHERE phone_verified_at IS NOT NULL AND deleted_at IS NULL;

-- One row per code sent. The provider keeps the code itself; this records who
-- asked, from where and how many guesses were made, for rate limits and audits.
CREATE TABLE phone_verifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phone_e164  text NOT NULL,
  ip          inet,
  provider    text NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  verified_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX phone_verifications_phone_idx ON phone_verifications (phone_e164, created_at DESC);
CREATE INDEX phone_verifications_ip_idx ON phone_verifications (ip, created_at DESC);
CREATE INDEX phone_verifications_user_idx ON phone_verifications (user_id, created_at DESC);

-- ── Spam and bot signals ───────────────────────────────────────────────
-- Set when repeated flags limit an account until a moderator reviews it.
ALTER TABLE users ADD COLUMN restricted_at timestamptz;

-- Why an account looks risky: signup signals (disposable email, many sign-ups
-- from one address) and behaviour (velocity, repeated text, link spam).
-- Moderators clear or confirm them from the console.
CREATE TABLE risk_signals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  weight      integer NOT NULL DEFAULT 0,
  detail      jsonb NOT NULL DEFAULT '{}',
  target_type text,
  target_id   uuid,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'cleared', 'confirmed')),
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX risk_signals_user_idx ON risk_signals (user_id, created_at DESC);
CREATE INDEX risk_signals_open_idx ON risk_signals (created_at DESC) WHERE status = 'open';

-- Sign-up velocity per address and per /24 looks back over recent sign-ups.
CREATE INDEX security_events_signup_idx ON security_events (created_at DESC) WHERE type = 'account_created';

-- Repeated identical text: posts are matched on a normalized fingerprint of the body.
CREATE INDEX posts_body_fingerprint_idx ON posts (md5(regexp_replace(lower(body), '\s+', ' ', 'g')), created_at DESC)
  WHERE body <> '' AND deleted_at IS NULL;

-- Messages flagged as spam wait for a moderator; only the sender sees them meanwhile.
ALTER TABLE messages ADD COLUMN moderation_status text NOT NULL DEFAULT 'normal' CHECK (moderation_status IN ('normal', 'review', 'removed'));
CREATE INDEX messages_sender_idx ON messages (sender_id, created_at DESC);

-- ── Image and video moderation ─────────────────────────────────────────
-- pending: not checked yet. ok. sensitive: blurred for everyone, never shown to
-- people under 18. blocked: removed, with a moderation case.
ALTER TABLE media ADD COLUMN moderation text NOT NULL DEFAULT 'pending' CHECK (moderation IN ('pending', 'ok', 'sensitive', 'blocked'));
ALTER TABLE media ADD COLUMN moderation_labels jsonb NOT NULL DEFAULT '[]';
ALTER TABLE media ADD COLUMN moderation_provider text;
ALTER TABLE media ADD COLUMN moderated_at timestamptz;
