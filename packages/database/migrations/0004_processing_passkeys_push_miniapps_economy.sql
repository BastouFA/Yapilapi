-- Media processing, passkeys, push, Mini Apps, creator economy, place reviews and bookings.

-- ─── Media processing ──────────────────────────────────────────────────
ALTER TABLE media ADD COLUMN variants jsonb NOT NULL DEFAULT '{}';
ALTER TABLE media ADD COLUMN poster_url text;
ALTER TABLE media ADD COLUMN hls_url text;
ALTER TABLE media ADD COLUMN blurhash text;

-- A small, durable job queue (FOR UPDATE SKIP LOCKED); good until a dedicated queue is needed.
CREATE TABLE jobs (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL,
  payload     jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  attempts    smallint NOT NULL DEFAULT 0,
  last_error  text,
  run_at      timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX jobs_due_idx ON jobs (run_at) WHERE status = 'queued';

-- ─── Passkeys (WebAuthn) ───────────────────────────────────────────────
CREATE TABLE passkeys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id text NOT NULL UNIQUE,
  public_key    bytea NOT NULL,
  counter       bigint NOT NULL DEFAULT 0,
  transports    text[] NOT NULL DEFAULT '{}',
  device_type   text,
  backed_up     boolean NOT NULL DEFAULT false,
  label         text NOT NULL DEFAULT 'Passkey',
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);
CREATE INDEX passkeys_user_idx ON passkeys (user_id);

CREATE TABLE webauthn_challenges (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  purpose    text NOT NULL CHECK (purpose IN ('register', 'login')),
  challenge  text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);

-- ─── Push notifications ────────────────────────────────────────────────
CREATE TABLE push_subscriptions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('webpush', 'expo')),
  endpoint   text NOT NULL,
  keys       jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_ok_at timestamptz,
  UNIQUE (kind, endpoint)
);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id);

-- ─── Mini Apps ─────────────────────────────────────────────────────────
CREATE TABLE mini_apps (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id      uuid NOT NULL REFERENCES developer_apps(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  entry_url   text NOT NULL,
  permissions text[] NOT NULL DEFAULT '{}' CHECK (permissions <@ ARRAY['profile', 'members', 'post_message']::text[]),
  surfaces    text[] NOT NULL CHECK (surfaces <@ ARRAY['conversation', 'community', 'event', 'profile', 'business']::text[] AND cardinality(surfaces) > 0),
  status      text NOT NULL DEFAULT 'review' CHECK (status IN ('review', 'approved', 'rejected')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mini_app_installs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mini_app_id  uuid NOT NULL REFERENCES mini_apps(id) ON DELETE CASCADE,
  surface      text NOT NULL CHECK (surface IN ('conversation', 'community', 'event', 'profile', 'business')),
  surface_id   uuid NOT NULL,
  installed_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mini_app_id, surface, surface_id)
);

-- ─── Creator economy ───────────────────────────────────────────────────
CREATE TABLE creator_plans (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  price_cents integer NOT NULL CHECK (price_cents >= 100),
  currency    char(3) NOT NULL DEFAULT 'USD',
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE creator_subscriptions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id            uuid NOT NULL REFERENCES creator_plans(id),
  subscriber_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  creator_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'cancelled', 'expired')),
  current_period_end timestamptz,
  order_id           uuid REFERENCES orders(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  cancelled_at       timestamptz
);
CREATE UNIQUE INDEX creator_subscriptions_one_live ON creator_subscriptions (subscriber_id, creator_id) WHERE status IN ('pending', 'active');

CREATE TABLE tips (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id    uuid REFERENCES posts(id) ON DELETE SET NULL,
  live_id    uuid REFERENCES live_sessions(id) ON DELETE SET NULL,
  message    text NOT NULL DEFAULT '',
  order_id   uuid NOT NULL REFERENCES orders(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_id <> to_id)
);

-- Orders can now pay for a subscription or a tip as well as products.
ALTER TABLE orders ADD COLUMN purpose text NOT NULL DEFAULT 'products' CHECK (purpose IN ('products', 'subscription', 'tip', 'booking'));
ALTER TABLE orders ADD COLUMN payee_id uuid REFERENCES users(id);

-- ─── Places: reviews and bookings ──────────────────────────────────────
CREATE TABLE place_reviews (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  place_id   uuid NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  author_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating     smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body       text NOT NULL DEFAULT '',
  moderation_status text NOT NULL DEFAULT 'normal' CHECK (moderation_status IN ('normal', 'review', 'restricted', 'removed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (place_id, author_id)
);

CREATE TABLE bookings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  place_id    uuid NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  party_size  smallint NOT NULL CHECK (party_size BETWEEN 1 AND 50),
  starts_at   timestamptz NOT NULL,
  status      text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'confirmed', 'declined', 'cancelled')),
  note        text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  decided_at  timestamptz
);
CREATE INDEX bookings_place_idx ON bookings (place_id, starts_at);
ALTER TABLE places ADD COLUMN booking_capacity smallint;
