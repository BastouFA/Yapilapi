-- Watch together, better (docs/product/status.md, "Watch together").
--
-- One line in the chat per session: the session remembers its line, and when people first watched
-- together (a session nobody else joined can be opened again by its starter for a few minutes,
-- keeping the same line, and its line leaves the chat afterwards; an ended session's line says how
-- long people watched).
--
-- The queue holds more than posts: a photo or video someone in the chat added from their device
-- (uploaded through POST /v1/media?for=watch; never posted, shown only to the chat, deleted when
-- the session ends) and YouTube videos (only the 11-character id, and the title and picture
-- YouTube's oEmbed gives).

ALTER TABLE watch_sessions
  ADD COLUMN line_id     uuid REFERENCES messages(id) ON DELETE SET NULL,
  ADD COLUMN together_at timestamptz;

UPDATE watch_sessions s SET line_id = m.id
  FROM messages m
  WHERE m.conversation_id = s.conversation_id AND m.kind = 'system' AND m.meta->>'type' = 'watch' AND m.meta->>'sessionId' = s.id::text;
UPDATE watch_sessions s SET together_at = s.created_at
  WHERE EXISTS (SELECT 1 FROM watch_participants wp WHERE wp.session_id = s.id AND wp.user_id <> s.started_by);

-- One device per person: the device (a random id each open watch screen makes) the person last
-- joined from plays; their other devices show "Watching on another device" with "Watch here".
ALTER TABLE watch_participants ADD COLUMN device_id text CHECK (device_id IS NULL OR length(device_id) <= 64);

-- Files uploaded for watch together: shown only through a session, and deleted when it ends.
ALTER TABLE media ADD COLUMN for_watch boolean NOT NULL DEFAULT false;

ALTER TABLE watch_queue_items
  ALTER COLUMN post_id DROP NOT NULL,
  ADD COLUMN kind          text NOT NULL DEFAULT 'post' CHECK (kind IN ('post', 'upload', 'youtube')),
  ADD COLUMN media_id      uuid REFERENCES media(id) ON DELETE CASCADE,
  ADD COLUMN youtube_id    text CHECK (youtube_id IS NULL OR youtube_id ~ '^[A-Za-z0-9_-]{11}$'),
  ADD COLUMN title         text CHECK (title IS NULL OR length(title) <= 300),
  ADD COLUMN thumbnail_url text CHECK (thumbnail_url IS NULL OR thumbnail_url ~ '^https://i[0-9]?\.ytimg\.com/'),
  ADD CONSTRAINT watch_queue_items_source_check CHECK (
    (kind = 'post' AND post_id IS NOT NULL AND media_id IS NULL AND youtube_id IS NULL)
    OR (kind = 'upload' AND media_id IS NOT NULL AND post_id IS NULL AND youtube_id IS NULL)
    OR (kind = 'youtube' AND youtube_id IS NOT NULL AND post_id IS NULL AND media_id IS NULL)
  );
-- The same upload or YouTube video waits in a queue once at a time (posts already have theirs).
CREATE UNIQUE INDEX watch_queue_items_waiting_media_idx ON watch_queue_items (session_id, media_id) WHERE status IN ('queued', 'playing') AND media_id IS NOT NULL;
CREATE UNIQUE INDEX watch_queue_items_waiting_youtube_idx ON watch_queue_items (session_id, youtube_id) WHERE status IN ('queued', 'playing') AND youtube_id IS NOT NULL;
CREATE INDEX watch_queue_items_media_idx ON watch_queue_items (media_id) WHERE media_id IS NOT NULL;
