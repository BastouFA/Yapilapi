-- Recap videos from Memories and Chapters.
--
-- A recap is a short video (up to 60 s) made from photos and clips in a
-- memory, "On this day" or one of your own chapters, rendered by the
-- 'recap.render' job with ffmpeg. It is private to the person who made it:
-- they can watch it, download it, post it as a reel through the normal post
-- path, or send it in a chat. Deleting it removes the file, unless a post,
-- story or message it was shared to still uses it.
--
-- `items` keeps what was chosen, in order: [{ mediaId, from, fromId }]. The
-- job checks each one again when it renders and leaves out anything the maker
-- can no longer see; `used_media_ids` is what went in.
CREATE TABLE recaps (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_type    text NOT NULL CHECK (source_type IN ('memory', 'on_this_day', 'chapter')),
  source_id      uuid,
  title          text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 60),
  style          text NOT NULL CHECK (style IN ('calm', 'quick', 'film')),
  aspect         text NOT NULL CHECK (aspect IN ('9:16', '1:1')),
  sound_id       uuid REFERENCES sounds(id) ON DELETE SET NULL,
  length_seconds integer CHECK (length_seconds IS NULL OR length_seconds BETWEEN 3 AND 60),
  items          jsonb NOT NULL,
  used_media_ids uuid[],
  status         text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'rendering', 'ready', 'failed')),
  error          text,
  media_id       uuid REFERENCES media(id) ON DELETE SET NULL,
  duration_ms    integer,
  created_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  deleted_at     timestamptz,
  CHECK ((source_type = 'on_this_day') = (source_id IS NULL))
);
-- Listing and the daily limit (deleted recaps still count toward it).
CREATE INDEX recaps_owner_idx ON recaps (owner_id, created_at DESC);
CREATE INDEX recaps_media_idx ON recaps (media_id) WHERE media_id IS NOT NULL;
