-- Photo and video editor: looks (filters), adjustments, crop, text and trim,
-- applied on the server to a copy of an upload before it is posted.
--
-- POST /v1/media/:id/edit creates the result media item at once (status
-- 'processing') and one row here; the 'media.editor' job renders it with
-- sharp or ffmpeg, runs the normal media processing on it and marks it done.
-- The source upload is never changed. (Studio trims and clips stay in
-- media_edits; this table is separate so neither listing shows the other.)
CREATE TABLE media_editor_renders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_media_id uuid NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  result_media_id uuid NOT NULL UNIQUE REFERENCES media(id) ON DELETE CASCADE,
  owner_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('image', 'video')),
  -- The validated request: filter, adjustments, crop, rotate, flips, trim, muted, coverMs, text.
  params          jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'rendering', 'done', 'failed')),
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);
CREATE INDEX media_editor_renders_source_idx ON media_editor_renders (source_media_id);
CREATE INDEX media_editor_renders_owner_idx ON media_editor_renders (owner_id, created_at DESC);
