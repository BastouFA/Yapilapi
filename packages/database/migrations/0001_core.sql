-- YAPILAPI core schema.
-- Conventions: uuid primary keys, created_at/updated_at on mutable rows,
-- deleted_at for soft deletion of user-generated content, CHECK constraints
-- for enums (easier to evolve than Postgres ENUM types).

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ─── Identity ──────────────────────────────────────────────────────────
CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             text NOT NULL,
  email_verified_at timestamptz,
  password_hash     text,
  role              text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'moderator', 'admin')),
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  birth_date        date,
  mfa_enabled       boolean NOT NULL DEFAULT false,
  onboarded_at      timestamptz,
  is_dev_data       boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email)) WHERE deleted_at IS NULL;
CREATE TRIGGER users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE profiles (
  user_id      uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  username     text NOT NULL,
  display_name text NOT NULL,
  bio          text NOT NULL DEFAULT '',
  avatar_url   text,
  cover_url    text,
  links        jsonb NOT NULL DEFAULT '[]',
  mode         text NOT NULL DEFAULT 'personal' CHECK (mode IN ('personal', 'creator', 'professional', 'business')),
  locale       text NOT NULL DEFAULT 'en',
  is_private   boolean NOT NULL DEFAULT false,
  search       tsvector GENERATED ALWAYS AS (
                 setweight(to_tsvector('simple', coalesce(username, '')), 'A') ||
                 setweight(to_tsvector('simple', coalesce(display_name, '')), 'A') ||
                 setweight(to_tsvector('simple', coalesce(bio, '')), 'C')) STORED,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX profiles_username_key ON profiles (lower(username));
CREATE INDEX profiles_search_idx ON profiles USING gin (search);
CREATE INDEX profiles_name_trgm ON profiles USING gin (display_name gin_trgm_ops);
CREATE TRIGGER profiles_updated BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE devices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  platform     text NOT NULL DEFAULT 'web',
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX devices_user_idx ON devices (user_id);

CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id    uuid REFERENCES devices(id) ON DELETE SET NULL,
  token_hash   text NOT NULL UNIQUE,
  user_agent   text,
  ip           inet,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

-- One-time tokens: email verification, password reset, account recovery.
CREATE TABLE auth_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    text NOT NULL CHECK (purpose IN ('verify_email', 'reset_password', 'recovery')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- MFA and passkey architecture (credentials stored, verification flows gated).
CREATE TABLE mfa_factors (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('totp', 'passkey', 'recovery_codes')),
  label       text NOT NULL DEFAULT '',
  secret_enc  bytea,
  credential  jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX mfa_factors_user_idx ON mfa_factors (user_id);

CREATE TABLE security_events (
  id         bigserial PRIMARY KEY,
  user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  type       text NOT NULL,
  ip         inet,
  user_agent text,
  metadata   jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX security_events_user_idx ON security_events (user_id, created_at DESC);

-- ─── Interests ─────────────────────────────────────────────────────────
CREATE TABLE topics (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text NOT NULL UNIQUE,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_interests (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic_id   uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  weight     real NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, topic_id)
);

-- ─── Social graph ──────────────────────────────────────────────────────
CREATE TABLE follows (
  follower_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);
CREATE INDEX follows_followee_idx ON follows (followee_id);

CREATE TABLE friend_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  CHECK (from_user_id <> to_user_id)
);
CREATE UNIQUE INDEX friend_requests_pending_key ON friend_requests (from_user_id, to_user_id) WHERE status = 'pending';

-- Friendship is symmetric: stored once with user_a < user_b.
CREATE TABLE friendships (
  user_a     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_a, user_b),
  CHECK (user_a < user_b)
);
CREATE INDEX friendships_b_idx ON friendships (user_b);

CREATE TABLE circles (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       text NOT NULL,
  kind       text NOT NULL DEFAULT 'custom' CHECK (kind IN ('family', 'close_friends', 'work', 'business', 'travel', 'custom')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX circles_owner_idx ON circles (owner_id);

CREATE TABLE circle_members (
  circle_id uuid NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (circle_id, user_id)
);

CREATE TABLE blocks (
  blocker_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX blocks_blocked_idx ON blocks (blocked_id);

CREATE TABLE mutes (
  muter_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  muted_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (muter_id, muted_id)
);

CREATE TABLE restrictions (
  restrictor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  restricted_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restrictor_id, restricted_id)
);

-- ─── Communities ───────────────────────────────────────────────────────
CREATE TABLE communities (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text NOT NULL,
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  visibility   text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
  owner_id     uuid NOT NULL REFERENCES users(id),
  member_count integer NOT NULL DEFAULT 0 CHECK (member_count >= 0),
  topics       text[] NOT NULL DEFAULT '{}',
  rules        text[] NOT NULL DEFAULT '{}',
  search       tsvector GENERATED ALWAYS AS (
                 setweight(to_tsvector('simple', coalesce(name, '')), 'A') ||
                 setweight(to_tsvector('english', coalesce(description, '')), 'B')) STORED,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
CREATE UNIQUE INDEX communities_slug_key ON communities (lower(slug));
CREATE INDEX communities_search_idx ON communities USING gin (search);
CREATE TRIGGER communities_updated BEFORE UPDATE ON communities FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE community_members (
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'moderator', 'organizer', 'member', 'guest')),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'banned')),
  joined_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (community_id, user_id)
);
CREATE INDEX community_members_user_idx ON community_members (user_id);

-- ─── Places, business, events ──────────────────────────────────────────
CREATE TABLE businesses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES users(id),
  slug        text NOT NULL,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  category    text NOT NULL DEFAULT 'general',
  website     text,
  verified_at timestamptz,
  search      tsvector GENERATED ALWAYS AS (
                setweight(to_tsvector('simple', coalesce(name, '')), 'A') ||
                setweight(to_tsvector('english', coalesce(description, '')), 'B')) STORED,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE UNIQUE INDEX businesses_slug_key ON businesses (lower(slug));
CREATE INDEX businesses_search_idx ON businesses USING gin (search);

CREATE TABLE places (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  category    text NOT NULL CHECK (category IN ('restaurant', 'store', 'venue', 'attraction', 'service')),
  description text NOT NULL DEFAULT '',
  address     text,
  city        text,
  country     char(2),
  lat         double precision,
  lng         double precision,
  hours       jsonb NOT NULL DEFAULT '{}',
  business_id uuid REFERENCES businesses(id) ON DELETE SET NULL,
  created_by  uuid NOT NULL REFERENCES users(id),
  search      tsvector GENERATED ALWAYS AS (
                setweight(to_tsvector('simple', coalesce(name, '')), 'A') ||
                setweight(to_tsvector('simple', coalesce(city, '')), 'B') ||
                setweight(to_tsvector('english', coalesce(description, '')), 'C')) STORED,
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE INDEX places_search_idx ON places USING gin (search);
CREATE INDEX places_geo_idx ON places (lat, lng);

CREATE TABLE events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id       uuid NOT NULL REFERENCES users(id),
  community_id  uuid REFERENCES communities(id) ON DELETE SET NULL,
  place_id      uuid REFERENCES places(id) ON DELETE SET NULL,
  title         text NOT NULL,
  description   text NOT NULL DEFAULT '',
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz,
  timezone      text NOT NULL DEFAULT 'UTC',
  location_text text,
  online        boolean NOT NULL DEFAULT false,
  capacity      integer CHECK (capacity IS NULL OR capacity > 0),
  visibility    text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'followers', 'friends', 'private')),
  search        tsvector GENERATED ALWAYS AS (
                  setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
                  setweight(to_tsvector('english', coalesce(description, '')), 'B') ||
                  setweight(to_tsvector('simple', coalesce(location_text, '')), 'B')) STORED,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX events_starts_idx ON events (starts_at) WHERE deleted_at IS NULL;
CREATE INDEX events_search_idx ON events USING gin (search);

CREATE TABLE event_attendees (
  event_id   uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     text NOT NULL CHECK (status IN ('going', 'interested', 'not_going', 'waitlist')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id)
);

-- ─── Commerce & payments ───────────────────────────────────────────────
CREATE TABLE products (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id      uuid NOT NULL REFERENCES users(id),
  business_id    uuid REFERENCES businesses(id) ON DELETE SET NULL,
  event_id       uuid REFERENCES events(id) ON DELETE SET NULL,
  kind           text NOT NULL CHECK (kind IN ('product', 'service', 'ticket', 'booking', 'digital')),
  title          text NOT NULL,
  description    text NOT NULL DEFAULT '',
  price_cents    integer NOT NULL CHECK (price_cents >= 0),
  currency       char(3) NOT NULL DEFAULT 'USD',
  inventory      integer CHECK (inventory IS NULL OR inventory >= 0),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'archived')),
  search         tsvector GENERATED ALWAYS AS (
                   setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
                   setweight(to_tsvector('english', coalesce(description, '')), 'B')) STORED,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);
CREATE INDEX products_search_idx ON products USING gin (search);
CREATE INDEX products_seller_idx ON products (seller_id);

CREATE TABLE orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id        uuid NOT NULL REFERENCES users(id),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'refunded', 'partially_refunded', 'cancelled')),
  total_cents     integer NOT NULL CHECK (total_cents >= 0),
  platform_fee_cents integer NOT NULL DEFAULT 0,
  currency        char(3) NOT NULL,
  idempotency_key text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (buyer_id, idempotency_key)
);

CREATE TABLE order_items (
  order_id    uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id  uuid NOT NULL REFERENCES products(id),
  quantity    integer NOT NULL CHECK (quantity > 0),
  unit_cents  integer NOT NULL CHECK (unit_cents >= 0),
  PRIMARY KEY (order_id, product_id)
);

-- Only provider references are stored. Never raw card data.
CREATE TABLE payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid NOT NULL REFERENCES orders(id),
  provider      text NOT NULL,
  provider_ref  text NOT NULL,
  status        text NOT NULL CHECK (status IN ('requires_action', 'succeeded', 'failed', 'refunded')),
  amount_cents  integer NOT NULL,
  currency      char(3) NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_ref)
);

CREATE TABLE refunds (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id   uuid NOT NULL REFERENCES payments(id),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  reason       text,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
  requested_by uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payment_webhook_events (
  id          text PRIMARY KEY,
  provider    text NOT NULL,
  type        text NOT NULL,
  payload     jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE TABLE payouts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  currency     char(3) NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'paid', 'failed')),
  provider_ref text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ─── Content ───────────────────────────────────────────────────────────
CREATE TABLE posts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('text', 'photo', 'video', 'carousel', 'audio', 'poll', 'link')),
  body              text NOT NULL DEFAULT '',
  visibility        text NOT NULL CHECK (visibility IN ('public', 'followers', 'friends', 'circle', 'selected', 'private')),
  circle_id         uuid REFERENCES circles(id) ON DELETE SET NULL,
  community_id      uuid REFERENCES communities(id) ON DELETE CASCADE,
  event_id          uuid REFERENCES events(id) ON DELETE SET NULL,
  product_id        uuid REFERENCES products(id) ON DELETE SET NULL,
  link_url          text,
  topics            text[] NOT NULL DEFAULT '{}',
  metadata          jsonb NOT NULL DEFAULT '{}',
  rights            jsonb NOT NULL DEFAULT '{}',
  ai_provenance     jsonb NOT NULL DEFAULT '{}',
  moderation_status text NOT NULL DEFAULT 'normal' CHECK (moderation_status IN ('normal', 'review', 'restricted', 'removed')),
  like_count        integer NOT NULL DEFAULT 0 CHECK (like_count >= 0),
  comment_count     integer NOT NULL DEFAULT 0 CHECK (comment_count >= 0),
  search            tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(body, ''))) STORED,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);
CREATE INDEX posts_author_idx ON posts (author_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX posts_recent_idx ON posts (created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX posts_community_idx ON posts (community_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX posts_topics_idx ON posts USING gin (topics);
CREATE INDEX posts_search_idx ON posts USING gin (search);
CREATE TRIGGER posts_updated BEFORE UPDATE ON posts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE post_audience (
  post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE media (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('image', 'video', 'audio', 'file')),
  url         text NOT NULL,
  mime        text,
  width       integer,
  height      integer,
  duration_ms integer,
  alt_text    text,
  status      text NOT NULL DEFAULT 'ready' CHECK (status IN ('uploading', 'processing', 'ready', 'failed')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE post_media (
  post_id  uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  media_id uuid NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  position smallint NOT NULL,
  PRIMARY KEY (post_id, media_id)
);

CREATE TABLE poll_options (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id  uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  label    text NOT NULL,
  position smallint NOT NULL
);
CREATE TABLE poll_votes (
  post_id   uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  option_id uuid NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE comments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id           uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id         uuid REFERENCES comments(id) ON DELETE CASCADE,
  body              text NOT NULL,
  moderation_status text NOT NULL DEFAULT 'normal' CHECK (moderation_status IN ('normal', 'review', 'restricted', 'removed')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);
CREATE INDEX comments_post_idx ON comments (post_id, created_at);

CREATE TABLE reactions (
  post_id    uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL DEFAULT 'like',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);
CREATE INDEX reactions_user_idx ON reactions (user_id, created_at DESC);

CREATE TABLE saves (
  post_id    uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE feed_feedback (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  signal     text NOT NULL CHECK (signal IN ('more_like_this', 'less_like_this', 'not_interested', 'mute_topic', 'mute_creator')),
  post_id    uuid REFERENCES posts(id) ON DELETE CASCADE,
  author_id  uuid REFERENCES users(id) ON DELETE CASCADE,
  topic      text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX feed_feedback_user_idx ON feed_feedback (user_id, signal);

CREATE TABLE moments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body          text NOT NULL DEFAULT '',
  media_url     text,
  media_kind    text CHECK (media_kind IN ('image', 'video', 'audio')),
  visibility    text NOT NULL CHECK (visibility IN ('public', 'followers', 'friends', 'circle', 'selected', 'private')),
  location_text text,
  expires_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE INDEX moments_author_idx ON moments (author_id, created_at DESC);

-- ─── Messaging ─────────────────────────────────────────────────────────
CREATE TABLE conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('direct', 'group', 'community')),
  title           text,
  community_id    uuid REFERENCES communities(id) ON DELETE CASCADE,
  direct_key      text UNIQUE,
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE conversation_members (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  joined_at       timestamptz NOT NULL DEFAULT now(),
  last_read_at    timestamptz NOT NULL DEFAULT now(),
  left_at         timestamptz,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX conversation_members_user_idx ON conversation_members (user_id) WHERE left_at IS NULL;

CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body            text NOT NULL DEFAULT '',
  reply_to_id     uuid REFERENCES messages(id) ON DELETE SET NULL,
  attachments     jsonb NOT NULL DEFAULT '[]',
  client_id       text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  edited_at       timestamptz,
  deleted_at      timestamptz
);
CREATE INDEX messages_conversation_idx ON messages (conversation_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX messages_client_id_key ON messages (sender_id, client_id) WHERE client_id IS NOT NULL;

CREATE TABLE message_reactions (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      text NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE plans (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
  created_by      uuid NOT NULL REFERENCES users(id),
  title           text NOT NULL,
  details         jsonb NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'cancelled')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ─── Notifications ─────────────────────────────────────────────────────
CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category    text NOT NULL,
  type        text NOT NULL,
  actor_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  entity_type text,
  entity_id   uuid,
  data        jsonb NOT NULL DEFAULT '{}',
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);

CREATE TABLE user_preferences (
  user_id                   uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  notification_categories   jsonb NOT NULL DEFAULT '{}',
  focus_mode                boolean NOT NULL DEFAULT false,
  quiet_mode                boolean NOT NULL DEFAULT false,
  friends_only              boolean NOT NULL DEFAULT false,
  reduced_recommendations   boolean NOT NULL DEFAULT false,
  daily_time_budget_minutes integer,
  notifications_paused_until timestamptz,
  updated_at                timestamptz NOT NULL DEFAULT now()
);

-- ─── Trust & safety ────────────────────────────────────────────────────
CREATE TABLE reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type text NOT NULL CHECK (target_type IN ('user', 'post', 'comment', 'message', 'community', 'event', 'product')),
  target_id   uuid NOT NULL,
  reason      text NOT NULL,
  details     text,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_review', 'closed')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reports_target_idx ON reports (target_type, target_id);
CREATE UNIQUE INDEX reports_once_key ON reports (reporter_id, target_type, target_id) WHERE status <> 'closed';

CREATE TABLE moderation_cases (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type text NOT NULL,
  target_id   uuid NOT NULL,
  subject_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  source      text NOT NULL CHECK (source IN ('report', 'automated', 'appeal')),
  risk        text NOT NULL CHECK (risk IN ('normal', 'review', 'restrict', 'escalate')),
  signals     jsonb NOT NULL DEFAULT '{}',
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'decided', 'appealed', 'final')),
  decision    text CHECK (decision IN ('no_action', 'restrict', 'remove', 'suspend_user')),
  reviewer_id uuid REFERENCES users(id),
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  decided_at  timestamptz
);
CREATE UNIQUE INDEX moderation_cases_open_key ON moderation_cases (target_type, target_id) WHERE status = 'open';

CREATE TABLE appeals (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id    uuid NOT NULL REFERENCES moderation_cases(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  statement  text NOT NULL,
  status     text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'upheld', 'overturned')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (case_id, user_id)
);

CREATE TABLE enforcements (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id    uuid REFERENCES moderation_cases(id) ON DELETE SET NULL,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action     text NOT NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ─── Privacy, consent, audit ───────────────────────────────────────────
CREATE TABLE consents (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    text NOT NULL CHECK (purpose IN ('personalization', 'ai_processing', 'advertising', 'analytics')),
  granted    boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, purpose)
);

CREATE TABLE privacy_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('export', 'delete')),
  status       text NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'failed')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE audit_logs (
  id          bigserial PRIMARY KEY,
  actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  action      text NOT NULL,
  entity_type text,
  entity_id   text,
  ip          inet,
  request_id  text,
  metadata    jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_id, created_at DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id);

-- ─── Platform ──────────────────────────────────────────────────────────
CREATE TABLE feature_flags (
  key         text PRIMARY KEY,
  enabled     boolean NOT NULL,
  rollout_pct smallint NOT NULL DEFAULT 100 CHECK (rollout_pct BETWEEN 0 AND 100),
  description text NOT NULL DEFAULT '',
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE analytics_events (
  id          bigserial PRIMARY KEY,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  name        text NOT NULL,
  meaningful  boolean NOT NULL DEFAULT false,
  properties  jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX analytics_events_name_idx ON analytics_events (name, created_at DESC);

-- ─── AI ────────────────────────────────────────────────────────────────
CREATE TABLE ai_conversations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent      text NOT NULL DEFAULT 'assistant',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ai_tool_calls (
  id              bigserial PRIMARY KEY,
  user_id         uuid REFERENCES users(id) ON DELETE CASCADE,
  task            text NOT NULL,
  provider        text NOT NULL,
  model           text NOT NULL,
  context_scopes  text[] NOT NULL DEFAULT '{}',
  status          text NOT NULL CHECK (status IN ('ok', 'denied', 'blocked', 'error')),
  latency_ms      integer,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- User-controlled AI memory: visible, editable, deletable.
CREATE TABLE ai_memories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content    text NOT NULL,
  source     text NOT NULL DEFAULT 'user',
  created_at timestamptz NOT NULL DEFAULT now()
);
