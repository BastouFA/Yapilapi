-- Music on stories, and "Both sides" (dual camera) photos.

-- A story can play part of a sound from the library in a loop (on a video story, instead of the
-- video's own sound). sound_id is kept as a column so sound pages can count the stories using it;
-- the rest (start, length, sticker style and position) is JSON validated by the API:
--   { "startMs": 30000, "durationMs": 15000, "style": "compact" | "card", "x": 0.5, "y": 0.78 }
ALTER TABLE moments
  ADD COLUMN sound_id uuid REFERENCES sounds(id) ON DELETE SET NULL,
  ADD COLUMN music    jsonb;
CREATE INDEX moments_sound_idx ON moments (sound_id, created_at DESC) WHERE sound_id IS NOT NULL AND deleted_at IS NULL;

-- "Both sides" photos go through the photo editor's renders: the source is the back camera photo,
-- second_media_id the front camera photo drawn in a rounded corner (params: { "dual": { "corner": ... } }).
ALTER TABLE media_editor_renders ADD COLUMN second_media_id uuid REFERENCES media(id) ON DELETE CASCADE;
