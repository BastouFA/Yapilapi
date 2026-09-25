-- 210: AI platform (gateway, permission-aware context, tools, memory, translation, budgets).
-- Builds on the 006 tables (ai_conversations, ai_messages, ai_memories, ai_tool_calls, ai_artifacts) and 002
-- content_translations. Never edits shipped migrations: everything here is additive.

-- ---------------------------------------------------------------- conversations / messages
ALTER TABLE ai_conversations ADD COLUMN agent text NOT NULL DEFAULT 'social';
ALTER TABLE ai_messages ADD COLUMN tool_calls jsonb NOT NULL DEFAULT '[]'::jsonb;  -- names + outcomes only, never tool payloads (they hold other people's content)

-- ---------------------------------------------------------------- memory: transparency ("when was it used?") + dedupe
ALTER TABLE ai_memories ADD COLUMN use_count integer NOT NULL DEFAULT 0;
ALTER TABLE ai_memories ADD COLUMN content_hash text;
CREATE UNIQUE INDEX ai_memories_user_hash_uniq ON ai_memories (user_id, content_hash) WHERE content_hash IS NOT NULL;

-- ---------------------------------------------------------------- tool audit
ALTER TABLE ai_tool_calls ADD COLUMN agent text;
ALTER TABLE ai_tool_calls ADD COLUMN duration_ms integer;
ALTER TABLE ai_tool_calls ADD COLUMN sources jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE ai_tool_calls ADD COLUMN request_id text;
CREATE INDEX ai_tool_calls_denied_idx ON ai_tool_calls (created_at DESC) WHERE outcome = 'denied';

-- ---------------------------------------------------------------- artifacts (drafts a human confirms)
ALTER TABLE ai_artifacts ADD COLUMN conversation_id uuid REFERENCES ai_conversations(id) ON DELETE SET NULL;
ALTER TABLE ai_artifacts ADD COLUMN tool text;
ALTER TABLE ai_artifacts ADD COLUMN provider text;
ALTER TABLE ai_artifacts ADD COLUMN sources jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE ai_artifacts ADD COLUMN edited boolean NOT NULL DEFAULT false;
ALTER TABLE ai_artifacts ADD COLUMN result_ref jsonb;          -- what confirmation created: {type:'post', id}
ALTER TABLE ai_artifacts ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE TRIGGER ai_artifacts_updated BEFORE UPDATE ON ai_artifacts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX ai_artifacts_conv_idx ON ai_artifacts (conversation_id) WHERE conversation_id IS NOT NULL;

-- ---------------------------------------------------------------- translation cache: stale detection
-- A cached translation is served only while the original is unchanged (source_hash) — authorisation is re-checked on every read.
ALTER TABLE content_translations ADD COLUMN source_hash text;
ALTER TABLE content_translations ADD COLUMN source_language text;

-- ---------------------------------------------------------------- budgets & metrics (persisted, per day)
CREATE TABLE ai_usage (
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day           date NOT NULL,
  task          text NOT NULL CHECK (task IN ('chat','summarise','translate','classify','embed')),
  requests      integer NOT NULL DEFAULT 0,
  tokens_in     bigint NOT NULL DEFAULT 0,
  tokens_out    bigint NOT NULL DEFAULT 0,
  cost_micros   bigint NOT NULL DEFAULT 0,      -- millionths of a USD, estimated from a static price table
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day, task)
);

CREATE TABLE ai_usage_global (
  day           date NOT NULL,
  task          text NOT NULL CHECK (task IN ('chat','summarise','translate','classify','embed')),
  provider      text NOT NULL,
  requests      integer NOT NULL DEFAULT 0,
  failures      integer NOT NULL DEFAULT 0,
  tokens_in     bigint NOT NULL DEFAULT 0,
  tokens_out    bigint NOT NULL DEFAULT 0,
  cost_micros   bigint NOT NULL DEFAULT 0,
  latency_ms_total bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day, task, provider)
);
