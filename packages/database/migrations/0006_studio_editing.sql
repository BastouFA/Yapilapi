-- Creator Studio editing: trimmed copies and clips of a video, and caption
-- (WebVTT subtitle) tracks per video.

-- ─── Trims and clips ───────────────────────────────────────────────────
-- Each row renders one segment of a source video into a new media item.
-- Rendering runs as a 'media.edit' job; the result then goes through the
-- normal 'media.process' job (poster, MP4, HLS), tracked by process_job_id.
CREATE TABLE media_edits (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_media_id uuid NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  owner_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('trim', 'clip')),
  start_ms        integer NOT NULL CHECK (start_ms >= 0),
  end_ms          integer NOT NULL,
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'rendering', 'processing', 'failed')),
  result_media_id uuid REFERENCES media(id) ON DELETE SET NULL,
  process_job_id  bigint,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  CHECK (end_ms - start_ms BETWEEN 1000 AND 600000)
);
CREATE INDEX media_edits_source_idx ON media_edits (source_media_id, created_at DESC);
CREATE INDEX media_edits_owner_idx ON media_edits (owner_id, created_at DESC);

-- ─── Captions ──────────────────────────────────────────────────────────
-- One track per language per video. The sanitized .vtt lives in media
-- storage under a fresh key on every save (stored objects are immutable).
CREATE TABLE caption_tracks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  media_id    uuid NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  lang        text NOT NULL CHECK (lang ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  label       text NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
  source      text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'upload', 'auto')),
  status      text NOT NULL DEFAULT 'ready' CHECK (status IN ('processing', 'ready', 'failed')),
  storage_key text,
  url         text,
  cue_count   integer NOT NULL DEFAULT 0,
  error       text,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (media_id, lang)
);
CREATE TRIGGER caption_tracks_updated BEFORE UPDATE ON caption_tracks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
