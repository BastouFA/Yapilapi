-- 002: Media, content engine (posts, polls, comments, reactions, saves, shares),
-- moments, real captures, shared experiences (Real Together), memories.
-- Columns that reference tables created in later migrations (communities, events, products,
-- places) are plain uuids here and get their foreign keys in migration 004.

CREATE TABLE media (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('image','video','audio','file')),
  storage_key   text NOT NULL UNIQUE,
  mime_type     text NOT NULL,
  size_bytes    bigint NOT NULL CHECK (size_bytes >= 0),
  width         integer,
  height        integer,
  duration_ms   integer,
  alt_text      text,
  blurhash      text,
  checksum_sha256 text,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','uploaded','processing','ready','failed','blocked')),
  variants      jsonb NOT NULL DEFAULT '[]'::jsonb,   -- transcoded renditions / HLS manifests
  captions      jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{lang, storage_key, kind}]
  upload_state  jsonb NOT NULL DEFAULT '{}'::jsonb,   -- resumable upload bookkeeping
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE INDEX media_owner_idx ON media (owner_id, created_at DESC);
CREATE TRIGGER media_updated BEFORE UPDATE ON media FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------- posts
CREATE TABLE posts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          text NOT NULL DEFAULT 'text'
                CHECK (kind IN ('text','photo','video','carousel','audio','poll','link','community','event','product','live_announcement')),
  body          text NOT NULL DEFAULT '' CHECK (length(body) <= 10000),
  language      text,
  visibility    text NOT NULL DEFAULT 'public'
                CHECK (visibility IN ('public','followers','friends','circle','selected','private','community')),
  circle_id     uuid REFERENCES circles(id) ON DELETE SET NULL,
  community_id  uuid,
  event_id      uuid,
  product_id    uuid,
  place_id      uuid,
  link_url      text,
  link_preview  jsonb,
  latitude      double precision,
  longitude     double precision,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  rights        jsonb NOT NULL DEFAULT '{"license":"all_rights_reserved"}'::jsonb,
  ai_provenance jsonb NOT NULL DEFAULT '{"generated":false,"assisted":[]}'::jsonb,
  moderation_status text NOT NULL DEFAULT 'approved'
                CHECK (moderation_status IN ('approved','pending_review','restricted','removed','escalated')),
  risk_level    text NOT NULL DEFAULT 'low' CHECK (risk_level IN ('low','medium','high','critical')),
  like_count    integer NOT NULL DEFAULT 0,
  comment_count integer NOT NULL DEFAULT 0,
  share_count   integer NOT NULL DEFAULT 0,
  save_count    integer NOT NULL DEFAULT 0,
  view_count    bigint  NOT NULL DEFAULT 0,
  edited_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  search_tsv    tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(body,''))) STORED,
  CONSTRAINT circle_visibility_requires_circle CHECK ((visibility = 'circle') = (circle_id IS NOT NULL)),
  CONSTRAINT community_visibility_requires_community CHECK (visibility <> 'community' OR community_id IS NOT NULL),
  CONSTRAINT lat_lng_pair CHECK ((latitude IS NULL) = (longitude IS NULL))
);
CREATE INDEX posts_author_idx ON posts (author_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX posts_created_idx ON posts (created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX posts_public_idx ON posts (created_at DESC, id DESC) WHERE deleted_at IS NULL AND visibility = 'public';
CREATE INDEX posts_community_idx ON posts (community_id, created_at DESC, id DESC) WHERE community_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX posts_event_idx ON posts (event_id, created_at DESC) WHERE event_id IS NOT NULL;
CREATE INDEX posts_product_idx ON posts (product_id) WHERE product_id IS NOT NULL;
CREATE INDEX posts_search_idx ON posts USING gin (search_tsv);
CREATE INDEX posts_moderation_idx ON posts (moderation_status) WHERE moderation_status <> 'approved';
CREATE TRIGGER posts_updated BEFORE UPDATE ON posts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE post_media (
  post_id   uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  media_id  uuid NOT NULL REFERENCES media(id) ON DELETE RESTRICT,
  position  smallint NOT NULL DEFAULT 0,
  PRIMARY KEY (post_id, media_id)
);
CREATE INDEX post_media_post_idx ON post_media (post_id, position);

-- Audience list for visibility = 'selected'.
CREATE TABLE post_audience (
  post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, user_id)
);
CREATE INDEX post_audience_user_idx ON post_audience (user_id);

CREATE TABLE post_topics (
  post_id  uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  topic_id uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, topic_id)
);
CREATE INDEX post_topics_topic_idx ON post_topics (topic_id);

CREATE TABLE polls (
  post_id     uuid PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  question    text NOT NULL,
  multiple    boolean NOT NULL DEFAULT false,
  closes_at   timestamptz
);
CREATE TABLE poll_options (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id    uuid NOT NULL REFERENCES polls(post_id) ON DELETE CASCADE,
  label      text NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  position   smallint NOT NULL,
  vote_count integer NOT NULL DEFAULT 0
);
CREATE INDEX poll_options_post_idx ON poll_options (post_id, position);
CREATE TABLE poll_votes (
  option_id uuid NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  post_id   uuid NOT NULL REFERENCES polls(post_id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (option_id, user_id)
);
CREATE INDEX poll_votes_user_idx ON poll_votes (post_id, user_id);

-- ---------------------------------------------------------------- comments / reactions
CREATE TABLE comments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id     uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id   uuid REFERENCES comments(id) ON DELETE CASCADE,
  body        text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  like_count  integer NOT NULL DEFAULT 0,
  reply_count integer NOT NULL DEFAULT 0,
  moderation_status text NOT NULL DEFAULT 'approved'
              CHECK (moderation_status IN ('approved','pending_review','restricted','removed','escalated')),
  hidden_by_restriction boolean NOT NULL DEFAULT false,
  edited_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE INDEX comments_post_idx ON comments (post_id, created_at, id) WHERE deleted_at IS NULL;
CREATE INDEX comments_parent_idx ON comments (parent_id, created_at) WHERE parent_id IS NOT NULL;
CREATE TRIGGER comments_updated BEFORE UPDATE ON comments FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE reactions (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type text NOT NULL CHECK (target_type IN ('post','comment','moment','message')),
  target_id   uuid NOT NULL,
  kind        text NOT NULL DEFAULT 'like' CHECK (kind IN ('like','love','laugh','wow','sad','insightful')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, target_type, target_id)
);
CREATE INDEX reactions_target_idx ON reactions (target_type, target_id);

CREATE TABLE saves (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type text NOT NULL CHECK (target_type IN ('post','event','place','product','community')),
  target_id  uuid NOT NULL,
  collection text NOT NULL DEFAULT 'default',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, target_type, target_id)
);
CREATE INDEX saves_user_idx ON saves (user_id, created_at DESC);

CREATE TABLE shares (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id    uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  comment    text,
  channel    text NOT NULL DEFAULT 'repost' CHECK (channel IN ('repost','message','external')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shares_post_idx ON shares (post_id);

-- ---------------------------------------------------------------- moments (temporary content)
CREATE TABLE moments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('photo','video','text','audio')),
  media_id    uuid REFERENCES media(id) ON DELETE SET NULL,
  body        text NOT NULL DEFAULT '' CHECK (length(body) <= 2000),
  music       jsonb,
  latitude    double precision,
  longitude   double precision,
  place_id    uuid,
  visibility  text NOT NULL DEFAULT 'friends'
              CHECK (visibility IN ('public','followers','friends','circle','selected','private')),
  circle_id   uuid REFERENCES circles(id) ON DELETE SET NULL,
  expiry      text NOT NULL DEFAULT '24h' CHECK (expiry IN ('1h','24h','custom','permanent')),
  expires_at  timestamptz,               -- NULL = permanent
  moderation_status text NOT NULL DEFAULT 'approved'
              CHECK (moderation_status IN ('approved','pending_review','restricted','removed','escalated')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  CONSTRAINT moment_circle_visibility CHECK ((visibility = 'circle') = (circle_id IS NOT NULL)),
  CONSTRAINT moment_expiry_consistency CHECK ((expiry = 'permanent') = (expires_at IS NULL))
);
CREATE INDEX moments_author_idx ON moments (author_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX moments_expiry_idx ON moments (expires_at) WHERE expires_at IS NOT NULL AND deleted_at IS NULL;
CREATE TABLE moment_audience (
  moment_id uuid NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (moment_id, user_id)
);
CREATE TABLE moment_views (
  moment_id uuid NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
  viewer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (moment_id, viewer_id)
);

-- ---------------------------------------------------------------- Real (authenticity capture)
CREATE TABLE real_captures (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  front_media_id uuid REFERENCES media(id) ON DELETE SET NULL,
  rear_media_id  uuid REFERENCES media(id) ON DELETE SET NULL,
  caption       text NOT NULL DEFAULT '',
  latitude      double precision,
  longitude     double precision,
  captured_at   timestamptz NOT NULL,     -- device clock claim
  received_at   timestamptz NOT NULL DEFAULT now(),
  authenticity  jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {capture_window_ok, clock_skew_ms, edited:false, device_attested}
  visibility    text NOT NULL DEFAULT 'friends'
                CHECK (visibility IN ('public','followers','friends','circle','selected','private')),
  circle_id     uuid REFERENCES circles(id) ON DELETE SET NULL,
  deleted_at    timestamptz,
  CONSTRAINT real_has_media CHECK (front_media_id IS NOT NULL OR rear_media_id IS NOT NULL)
);
CREATE INDEX real_captures_author_idx ON real_captures (author_id, captured_at DESC) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------- Real Together (shared experiences)
CREATE TABLE shared_experiences (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       text NOT NULL,
  description text NOT NULL DEFAULT '',
  event_id    uuid,
  place_id    uuid,
  starts_at   timestamptz,
  ends_at     timestamptz,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','archived')),
  visibility  text NOT NULL DEFAULT 'private' CHECK (visibility IN ('public','friends','private')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE TRIGGER shared_experiences_updated BEFORE UPDATE ON shared_experiences FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TABLE shared_experience_members (
  experience_id uuid NOT NULL REFERENCES shared_experiences(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          text NOT NULL DEFAULT 'contributor' CHECK (role IN ('owner','contributor','viewer')),
  status        text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','joined','declined','left')),
  joined_at     timestamptz,
  PRIMARY KEY (experience_id, user_id)
);
CREATE INDEX shared_experience_members_user_idx ON shared_experience_members (user_id, status);
CREATE TABLE shared_experience_contributions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experience_id uuid NOT NULL REFERENCES shared_experiences(id) ON DELETE CASCADE,
  contributor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id      uuid REFERENCES media(id) ON DELETE SET NULL,
  real_capture_id uuid REFERENCES real_captures(id) ON DELETE SET NULL,
  body          text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  CONSTRAINT contribution_has_content CHECK (media_id IS NOT NULL OR real_capture_id IS NOT NULL OR length(body) > 0)
);
CREATE INDEX shared_experience_contributions_idx ON shared_experience_contributions (experience_id, created_at);

-- ---------------------------------------------------------------- memories
CREATE TABLE memories (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('highlight','recap','timeline','collection','trip','on_this_day')),
  title        text NOT NULL,
  summary      text NOT NULL DEFAULT '',
  date_start   date,
  date_end     date,
  privacy      text NOT NULL DEFAULT 'private' CHECK (privacy IN ('private','friends','public')),
  ai_generated boolean NOT NULL DEFAULT false,
  ai_provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
CREATE INDEX memories_owner_idx ON memories (owner_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE TRIGGER memories_updated BEFORE UPDATE ON memories FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TABLE memory_items (
  memory_id  uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  item_type  text NOT NULL CHECK (item_type IN ('post','moment','media','event','real_capture','experience','message')),
  item_id    uuid NOT NULL,
  position   integer NOT NULL DEFAULT 0,
  PRIMARY KEY (memory_id, item_type, item_id)
);
-- Organizing dimensions: people, places, events, trips, dates, communities, experiences.
CREATE TABLE memory_links (
  memory_id   uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('person','place','event','trip','community','experience')),
  entity_id   uuid NOT NULL,
  PRIMARY KEY (memory_id, entity_type, entity_id)
);
CREATE INDEX memory_links_entity_idx ON memory_links (entity_type, entity_id);

-- ---------------------------------------------------------------- translations (cache; originals are never overwritten)
CREATE TABLE content_translations (
  target_type text NOT NULL CHECK (target_type IN ('post','comment','message','caption','community','event')),
  target_id   uuid NOT NULL,
  language    text NOT NULL,
  translated_text text NOT NULL,
  provider    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (target_type, target_id, language)
);
