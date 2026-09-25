-- 003: Messaging, calls, plans, communities.

-- ---------------------------------------------------------------- communities (before channels so conversations can FK)
CREATE TABLE communities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          citext NOT NULL,
  name          text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  description   text NOT NULL DEFAULT '' CHECK (length(description) <= 5000),
  avatar_url    text,
  cover_url     text,
  visibility    text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private','secret')),
  join_policy   text NOT NULL DEFAULT 'open' CHECK (join_policy IN ('open','request','invite')),
  created_by    uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  member_count  integer NOT NULL DEFAULT 0,
  rules         jsonb NOT NULL DEFAULT '[]'::jsonb,
  language      text,
  is_paid       boolean NOT NULL DEFAULT false,
  price_cents   integer CHECK (price_cents IS NULL OR price_cents >= 0),
  currency      text CHECK (currency IS NULL OR length(currency) = 3),
  search_tsv    tsvector GENERATED ALWAYS AS (
                  to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(description,''))
                ) STORED,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  CONSTRAINT slug_format CHECK (slug::text ~ '^[a-z0-9-]{3,50}$'),
  CONSTRAINT paid_requires_price CHECK (NOT is_paid OR (price_cents IS NOT NULL AND currency IS NOT NULL))
);
CREATE UNIQUE INDEX communities_slug_unique ON communities (slug) WHERE deleted_at IS NULL;
CREATE INDEX communities_search_idx ON communities USING gin (search_tsv);
CREATE INDEX communities_name_trgm_idx ON communities USING gin (name gin_trgm_ops);
CREATE INDEX communities_visibility_idx ON communities (visibility) WHERE deleted_at IS NULL;
CREATE TRIGGER communities_updated BEFORE UPDATE ON communities FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE community_topics (
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  topic_id     uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  PRIMARY KEY (community_id, topic_id)
);
CREATE INDEX community_topics_topic_idx ON community_topics (topic_id);

-- CommunityRole: permission sets per community. System roles are seeded on creation.
CREATE TABLE community_roles (
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  key          text NOT NULL CHECK (key ~ '^[a-z_]{3,30}$'),
  name         text NOT NULL,
  permissions  text[] NOT NULL DEFAULT '{}',
  is_system    boolean NOT NULL DEFAULT false,
  rank         smallint NOT NULL DEFAULT 0,     -- higher outranks lower
  PRIMARY KEY (community_id, key)
);

CREATE TABLE community_members (
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_key     text NOT NULL DEFAULT 'member',
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending','invited','banned','left')),
  joined_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (community_id, user_id),
  FOREIGN KEY (community_id, role_key) REFERENCES community_roles (community_id, key)
);
CREATE INDEX community_members_user_idx ON community_members (user_id, status);

CREATE TABLE community_resources (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  title        text NOT NULL,
  url          text,
  body         text NOT NULL DEFAULT '',
  created_by   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pinned       boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
CREATE INDEX community_resources_idx ON community_resources (community_id, pinned DESC, created_at DESC) WHERE deleted_at IS NULL;

-- Human-authored decisions/FAQ entries the community AI may quote. AI must not invent these.
CREATE TABLE community_decisions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('faq','decision','rule')),
  question     text,
  body         text NOT NULL,
  decided_by   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
CREATE INDEX community_decisions_idx ON community_decisions (community_id, kind) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------- conversations / messages
CREATE TABLE conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('direct','group','community_channel')),
  title           text,
  direct_key      text,                                   -- "<low uuid>:<high uuid>" for kind = 'direct'
  community_id    uuid REFERENCES communities(id) ON DELETE CASCADE,
  channel_name    text,
  channel_kind    text CHECK (channel_kind IN ('text','voice')),
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  last_message_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT direct_has_key CHECK ((kind = 'direct') = (direct_key IS NOT NULL)),
  CONSTRAINT channel_has_community CHECK ((kind = 'community_channel') = (community_id IS NOT NULL))
);
CREATE UNIQUE INDEX conversations_direct_key_unique ON conversations (direct_key) WHERE direct_key IS NOT NULL;
CREATE UNIQUE INDEX conversations_channel_unique ON conversations (community_id, channel_name) WHERE kind = 'community_channel';
CREATE INDEX conversations_last_message_idx ON conversations (last_message_at DESC NULLS LAST);
CREATE TRIGGER conversations_updated BEFORE UPDATE ON conversations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE conversation_members (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  joined_at       timestamptz NOT NULL DEFAULT now(),
  left_at         timestamptz,
  last_read_at    timestamptz,
  muted_until     timestamptz,
  pinned          boolean NOT NULL DEFAULT false,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX conversation_members_user_idx ON conversation_members (user_id) WHERE left_at IS NULL;

CREATE TABLE messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  kind             text NOT NULL DEFAULT 'text'
                   CHECK (kind IN ('text','media','file','voice','poll','plan','system','call')),
  body             text NOT NULL DEFAULT '' CHECK (length(body) <= 8000),
  reply_to_id      uuid REFERENCES messages(id) ON DELETE SET NULL,
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  client_message_id text,
  moderation_status text NOT NULL DEFAULT 'approved'
                   CHECK (moderation_status IN ('approved','pending_review','restricted','removed','escalated')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  edited_at        timestamptz,
  deleted_at       timestamptz
);
CREATE INDEX messages_conversation_idx ON messages (conversation_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX messages_idempotency_unique ON messages (conversation_id, sender_id, client_message_id)
  WHERE client_message_id IS NOT NULL;

CREATE TABLE message_attachments (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  media_id   uuid NOT NULL REFERENCES media(id) ON DELETE RESTRICT,
  position   smallint NOT NULL DEFAULT 0,
  PRIMARY KEY (message_id, media_id)
);

CREATE TABLE message_polls (
  message_id uuid PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  question   text NOT NULL,
  multiple   boolean NOT NULL DEFAULT false,
  options    jsonb NOT NULL                         -- [{id,label}]
);
CREATE TABLE message_poll_votes (
  message_id uuid NOT NULL REFERENCES message_polls(message_id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  option_id  text NOT NULL,
  PRIMARY KEY (message_id, user_id, option_id)
);

CREATE TABLE calls (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  initiator_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('audio','video')),
  status          text NOT NULL DEFAULT 'ringing' CHECK (status IN ('ringing','active','ended','missed','declined')),
  room_id         text NOT NULL UNIQUE,             -- opaque id handed to the RTC/SFU provider
  started_at      timestamptz,
  ended_at        timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX calls_conversation_idx ON calls (conversation_id, created_at DESC);
CREATE TABLE call_participants (
  call_id    uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at  timestamptz,
  left_at    timestamptz,
  PRIMARY KEY (call_id, user_id)
);

-- ---------------------------------------------------------------- plans (conversation -> structured activity)
CREATE TABLE plans (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  created_by      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           text NOT NULL,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','proposed','confirmed','cancelled','done')),
  destination     text,
  starts_on       date,
  ends_on         date,
  budget_cents    bigint CHECK (budget_cents IS NULL OR budget_cents >= 0),
  currency        text CHECK (currency IS NULL OR length(currency) = 3),
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,   -- transport, accommodation, activities
  ai_generated    boolean NOT NULL DEFAULT false,
  ai_provenance   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER plans_updated BEFORE UPDATE ON plans FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TABLE plan_participants (
  plan_id   uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rsvp      text NOT NULL DEFAULT 'invited' CHECK (rsvp IN ('invited','going','maybe','declined')),
  PRIMARY KEY (plan_id, user_id)
);
CREATE INDEX plan_participants_user_idx ON plan_participants (user_id);
CREATE TABLE plan_tasks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id     uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  title       text NOT NULL,
  assignee_id uuid REFERENCES users(id) ON DELETE SET NULL,
  done        boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX plan_tasks_plan_idx ON plan_tasks (plan_id);
