-- 006: Safety & moderation, privacy/consents, notifications, preferences, audit logs,
-- AI (conversations, memory, tool audit, artifacts), recommendation signals, analytics,
-- feature flags, developer platform, mini apps.
--
-- Append-only tables (consents, audit_logs) deliberately carry plain uuid actor columns
-- (no FK) so that deleting a user never has to mutate them; they hold pseudonymous ids only.

-- ---------------------------------------------------------------- safety & moderation
CREATE TABLE reports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type   text NOT NULL CHECK (target_type IN ('user','post','comment','moment','message','community','event','product','place','business','live_session')),
  target_id     uuid NOT NULL,
  reason        text NOT NULL CHECK (reason IN ('spam','harassment','hate','violence','sexual_content','self_harm','misinformation','scam','impersonation','minor_safety','illegal','ip_violation','other')),
  details       text CHECK (details IS NULL OR char_length(details) <= 2000),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','triaged','actioned','dismissed')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reporter_id, target_type, target_id, reason)
);
CREATE INDEX reports_target_idx ON reports (target_type, target_id);
CREATE INDEX reports_status_idx ON reports (status, created_at);

CREATE TABLE moderation_cases (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type   text NOT NULL,
  target_id     uuid NOT NULL,
  subject_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  source        text NOT NULL CHECK (source IN ('user_report','automated','staff')),
  risk_level    text NOT NULL DEFAULT 'low' CHECK (risk_level IN ('low','medium','high','critical')),
  categories    text[] NOT NULL DEFAULT '{}',
  signals       jsonb NOT NULL DEFAULT '{}'::jsonb,   -- classifier output, explainable
  -- pipeline: Content -> Analysis -> Risk -> Normal/Review/Restrict/Escalate -> Appeal -> Final
  state         text NOT NULL DEFAULT 'review' CHECK (state IN ('normal','review','restricted','escalated','appealed','resolved')),
  decision      text CHECK (decision IN ('no_action','label','limit_reach','remove','suspend_user','ban_user')),
  assigned_to   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz
);
CREATE INDEX moderation_cases_state_idx ON moderation_cases (state, risk_level, created_at);
CREATE INDEX moderation_cases_target_idx ON moderation_cases (target_type, target_id);
CREATE TRIGGER moderation_cases_updated BEFORE UPDATE ON moderation_cases FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE report_cases (
  report_id uuid NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  case_id   uuid NOT NULL REFERENCES moderation_cases(id) ON DELETE CASCADE,
  PRIMARY KEY (report_id, case_id)
);

CREATE TABLE enforcements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       uuid REFERENCES moderation_cases(id) ON DELETE SET NULL,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('warning','content_removed','limit_reach','feature_restriction','suspension','ban')),
  reason        text NOT NULL,
  starts_at     timestamptz NOT NULL DEFAULT now(),
  ends_at       timestamptz,
  revoked_at    timestamptz,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX enforcements_user_idx ON enforcements (user_id, starts_at DESC);

CREATE TABLE appeals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       uuid NOT NULL REFERENCES moderation_cases(id) ON DELETE CASCADE,
  enforcement_id uuid REFERENCES enforcements(id) ON DELETE SET NULL,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  statement     text NOT NULL CHECK (char_length(statement) BETWEEN 1 AND 4000),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','upheld','overturned')),
  reviewer_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewer_note text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  UNIQUE (case_id, user_id)
);

-- ---------------------------------------------------------------- notifications
CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL,              -- e.g. follow, like, comment, message, event_reminder
  actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  target_type text,
  target_id   uuid,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

CREATE TABLE notification_preferences (
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind      text NOT NULL,
  channel   text NOT NULL CHECK (channel IN ('in_app','push','email')),
  enabled   boolean NOT NULL DEFAULT true,
  PRIMARY KEY (user_id, kind, channel)
);

CREATE TABLE push_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id   uuid REFERENCES devices(id) ON DELETE CASCADE,
  platform    text NOT NULL CHECK (platform IN ('ios','android','web')),
  token       text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- preferences & attention controls
CREATE TABLE user_preferences (
  user_id            uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  locale             text NOT NULL DEFAULT 'en',
  timezone           text NOT NULL DEFAULT 'UTC',
  currency           text NOT NULL DEFAULT 'USD',
  theme              text NOT NULL DEFAULT 'system' CHECK (theme IN ('system','light','dark')),
  reduced_motion     boolean NOT NULL DEFAULT false,
  low_bandwidth      boolean NOT NULL DEFAULT false,
  -- attention controls
  daily_limit_minutes integer CHECK (daily_limit_minutes IS NULL OR daily_limit_minutes BETWEEN 5 AND 1440),
  quiet_hours_start  smallint CHECK (quiet_hours_start IS NULL OR quiet_hours_start BETWEEN 0 AND 1439),
  quiet_hours_end    smallint CHECK (quiet_hours_end IS NULL OR quiet_hours_end BETWEEN 0 AND 1439),
  focus_mode         boolean NOT NULL DEFAULT false,
  sensitive_content  text NOT NULL DEFAULT 'limit' CHECK (sensitive_content IN ('hide','limit','allow')),
  -- privacy defaults
  default_post_visibility text NOT NULL DEFAULT 'followers' CHECK (default_post_visibility IN ('public','followers','friends','private')),
  who_can_message    text NOT NULL DEFAULT 'everyone' CHECK (who_can_message IN ('everyone','followers','friends','nobody')),
  discoverable       boolean NOT NULL DEFAULT true,
  personalization    boolean NOT NULL DEFAULT true,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER user_preferences_updated BEFORE UPDATE ON user_preferences FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------- consents & privacy requests
CREATE TABLE consents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL,                 -- no FK: append-only evidence
  purpose     text NOT NULL,                 -- e.g. ai_memory, ai_message_access, personalization, marketing
  granted     boolean NOT NULL,
  scope       jsonb NOT NULL DEFAULT '{}'::jsonb,
  source      text NOT NULL DEFAULT 'user',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consents_user_purpose_idx ON consents (user_id, purpose, created_at DESC);
CREATE TRIGGER consents_immutable BEFORE UPDATE OR DELETE ON consents FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE privacy_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('export','delete','rectify','restrict_processing')),
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','rejected','cancelled')),
  result      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX privacy_requests_user_idx ON privacy_requests (user_id, created_at DESC);

-- ---------------------------------------------------------------- audit log (append-only)
CREATE TABLE audit_logs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id    uuid,
  actor_type  text NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user','staff','system','ai','service')),
  action      text NOT NULL,
  target_type text,
  target_id   text,
  request_id  text,
  ip_hash     text,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,  -- never contains secrets or raw payment data
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_id, created_at DESC);
CREATE INDEX audit_logs_target_idx ON audit_logs (target_type, target_id);
CREATE INDEX audit_logs_action_idx ON audit_logs (action, created_at DESC);
CREATE TRIGGER audit_logs_immutable BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- AI
CREATE TABLE ai_conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope       text NOT NULL DEFAULT 'personal' CHECK (scope IN ('personal','community','business','creator')),
  scope_id    uuid,
  title       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_conversations_user_idx ON ai_conversations (user_id, updated_at DESC);

CREATE TABLE ai_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('user','assistant','tool','system')),
  content         text NOT NULL,
  provider        text,
  model           text,
  sources         jsonb NOT NULL DEFAULT '[]'::jsonb,   -- what context the answer used (transparency)
  safety          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_messages_conv_idx ON ai_messages (conversation_id, created_at);

-- Permission-aware, user-controlled, deletable memory.
CREATE TABLE ai_memories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content     text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 2000),
  source_type text NOT NULL CHECK (source_type IN ('user_stated','user_approved_suggestion')),
  source_ref  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX ai_memories_user_idx ON ai_memories (user_id, created_at DESC);

-- Every tool invocation by the AI is audited here.
CREATE TABLE ai_tool_calls (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES ai_conversations(id) ON DELETE SET NULL,
  tool        text NOT NULL,
  input       jsonb NOT NULL DEFAULT '{}'::jsonb,
  outcome     text NOT NULL CHECK (outcome IN ('allowed','denied','error')),
  denial_reason text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_tool_calls_user_idx ON ai_tool_calls (user_id, created_at DESC);

-- AI-generated drafts. Nothing is published without explicit confirmation.
CREATE TABLE ai_artifacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('caption','post_draft','reply_draft','summary','translation','plan','event_draft','listing_draft','other')),
  payload     jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed','discarded')),
  confirmed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_artifacts_user_idx ON ai_artifacts (user_id, created_at DESC);

-- ---------------------------------------------------------------- recommendation signals
CREATE TABLE recommendation_feedback (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id     uuid REFERENCES posts(id) ON DELETE CASCADE,
  creator_id  uuid REFERENCES users(id) ON DELETE CASCADE,
  signal      text NOT NULL CHECK (signal IN ('more_like_this','less_like_this','not_interested','hide_creator')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recommendation_feedback_user_idx ON recommendation_feedback (user_id, created_at DESC);

CREATE TABLE user_topic_affinity (
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic_id  uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  score     real NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, topic_id)
);

-- ---------------------------------------------------------------- analytics (privacy-preserving)
CREATE TABLE analytics_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     uuid,                        -- nullable: anonymous events; no FK so deletion keeps aggregates
  name        text NOT NULL,
  properties  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX analytics_events_name_idx ON analytics_events (name, created_at DESC);

-- ---------------------------------------------------------------- feature flags
CREATE TABLE feature_flags (
  key         text PRIMARY KEY,
  description text NOT NULL,
  enabled     boolean NOT NULL DEFAULT false,
  rollout_pct smallint NOT NULL DEFAULT 0 CHECK (rollout_pct BETWEEN 0 AND 100),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER feature_flags_updated BEFORE UPDATE ON feature_flags FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE feature_flag_overrides (
  flag_key   text NOT NULL REFERENCES feature_flags(key) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  enabled    boolean NOT NULL,
  PRIMARY KEY (flag_key, user_id)
);

INSERT INTO feature_flags (key, description, enabled, rollout_pct) VALUES
  ('LIVE',            'Live sessions (streaming architecture; ingest provider required for real video)', false, 0),
  ('COMMERCE',        'Marketplace: products, orders, bookings, checkout',                                true,  100),
  ('AI_TRANSLATION',  'AI translation of content and messages',                                          true,  100),
  ('MEMORY',          'User-controlled AI memory and memory timelines',                                   true,  100),
  ('NOW',             'NOW: what is happening around me',                                                 false, 0),
  ('MINI_APPS',       'Sandboxed mini apps inside YAPILAPI',                                              false, 0),
  ('PLAY',            'PLAY: shared games and activities',                                                false, 0),
  ('REAL',            'REAL: unfiltered capture moments',                                                 true,  100),
  ('REAL_TOGETHER',   'REAL TOGETHER: shared experiences',                                                true,  100);

-- ---------------------------------------------------------------- developer platform & mini apps
CREATE TABLE developer_apps (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 80),
  description   text,
  redirect_uris text[] NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id      uuid NOT NULL REFERENCES developer_apps(id) ON DELETE CASCADE,
  key_prefix  text NOT NULL,
  key_hash    text NOT NULL UNIQUE,       -- sha256 of the secret; secret shown once
  scopes      text[] NOT NULL DEFAULT '{}',
  last_used_at timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_endpoints (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id      uuid NOT NULL REFERENCES developer_apps(id) ON DELETE CASCADE,
  url         text NOT NULL CHECK (url ~ '^https://'),
  events      text[] NOT NULL DEFAULT '{}',
  secret_enc  text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mini_apps (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  developer_app_id uuid NOT NULL REFERENCES developer_apps(id) ON DELETE CASCADE,
  slug          citext NOT NULL UNIQUE,
  name          text NOT NULL,
  manifest      jsonb NOT NULL,             -- declared permissions; user must grant each
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_review','published','rejected','suspended')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mini_app_installs (
  mini_app_id   uuid NOT NULL REFERENCES mini_apps(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_permissions text[] NOT NULL DEFAULT '{}',
  installed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mini_app_id, user_id)
);
