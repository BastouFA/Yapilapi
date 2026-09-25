-- 192: Notifications: delivery bookkeeping, pause control, push token lifecycle, digest state.

ALTER TABLE user_preferences ADD COLUMN notifications_paused_until timestamptz;

ALTER TABLE notifications
  ADD COLUMN pushed_at  timestamptz,      -- handed to the push adapter
  ADD COLUMN emailed_at timestamptz;      -- included in an email digest
CREATE INDEX notifications_feed_idx ON notifications (user_id, created_at DESC, id DESC);
CREATE INDEX notifications_kind_idx ON notifications (user_id, kind);
CREATE INDEX notifications_digest_idx ON notifications (user_id, created_at) WHERE emailed_at IS NULL AND read_at IS NULL;

ALTER TABLE push_tokens
  ADD COLUMN provider     text NOT NULL DEFAULT 'expo' CHECK (provider IN ('expo','fcm','apns','webpush')),
  ADD COLUMN last_used_at timestamptz,
  ADD COLUMN disabled_at  timestamptz;
CREATE INDEX push_tokens_user_idx ON push_tokens (user_id) WHERE disabled_at IS NULL;

CREATE TABLE email_digest_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_count  integer NOT NULL,
  sent_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_digest_log_user_idx ON email_digest_log (user_id, sent_at DESC);
