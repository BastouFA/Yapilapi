-- Settings: who can message, comment on and mention you, notification quiet hours, and how
-- sensitive photos and videos are shown.

ALTER TABLE user_preferences
  -- Who can start a chat with you. Friends always can. 'following' is people you follow.
  ADD COLUMN messages_from text NOT NULL DEFAULT 'everyone' CHECK (messages_from IN ('everyone', 'following', 'friends')),
  -- Who can comment on your posts (on top of each post's own setting). Friends always can.
  ADD COLUMN comments_from text NOT NULL DEFAULT 'everyone' CHECK (comments_from IN ('everyone', 'following', 'followers')),
  -- Whose @mentions reach you as a notification.
  ADD COLUMN mentions_from text NOT NULL DEFAULT 'everyone' CHECK (mentions_from IN ('everyone', 'following', 'nobody')),
  -- Quiet hours: phone and browser notifications wait; they still land in the inbox.
  ADD COLUMN quiet_start time,
  ADD COLUMN quiet_end time,
  ADD COLUMN quiet_timezone text NOT NULL DEFAULT 'UTC',
  -- 'standard': sensitive photos and videos are covered until you choose to see them.
  -- 'less': they aren't shown at all (always the case under 18).
  ADD COLUMN sensitive_media text NOT NULL DEFAULT 'standard' CHECK (sensitive_media IN ('standard', 'less'));

-- "Report a problem" from Settings > Help: what went wrong, where, and on which app version.
CREATE TABLE problem_reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  body        text NOT NULL,
  platform    text NOT NULL CHECK (platform IN ('web', 'ios', 'android', 'other')),
  app_version text,
  page        text,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX problem_reports_open_idx ON problem_reports (created_at DESC) WHERE status = 'open';
