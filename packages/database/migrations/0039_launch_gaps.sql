-- Launch gaps: reporting stories, audio rooms and lives; the daily data retention job.

-- Stories (moments), audio rooms and lives can be reported too.
ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_target_type_check;
ALTER TABLE reports ADD CONSTRAINT reports_target_type_check
  CHECK (target_type IN ('user', 'post', 'comment', 'message', 'community', 'event', 'product', 'story', 'room', 'live'));

-- Scheduled housekeeping that must run at most once per period across every API instance
-- (see apps/api/src/lib/retention.ts). A row per task, holding when it last ran.
CREATE TABLE maintenance_runs (
  name    text PRIMARY KEY,
  ran_at  timestamptz NOT NULL
);

-- The retention job deletes by age; these keep it from scanning whole tables.
CREATE INDEX IF NOT EXISTS analytics_events_created_idx ON analytics_events (created_at);
-- Turning analytics off unlinks that person's events.
CREATE INDEX IF NOT EXISTS analytics_events_user_idx ON analytics_events (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS security_events_created_idx ON security_events (created_at);
CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs (created_at);
CREATE INDEX IF NOT EXISTS ai_tool_calls_created_idx ON ai_tool_calls (created_at);
CREATE INDEX IF NOT EXISTS notifications_created_idx ON notifications (created_at);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);
CREATE INDEX IF NOT EXISTS posts_deleted_idx ON posts (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS comments_deleted_idx ON comments (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_deleted_idx ON messages (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS moments_deleted_idx ON moments (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS media_deleted_idx ON media (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS media_private_idx ON media (created_at) WHERE private;
