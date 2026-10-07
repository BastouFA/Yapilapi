-- Video covers: the owner of a reel or video post picks a moment of the video, or one of their own
-- photos, as its cover, and can change it again or go back to the default at any time.
--
-- The cover itself is a poster like the default one (poster_url, variants.thumb, blurhash and
-- variant_bytes.poster/thumb on the video's media row), written under a new file name each time
-- (<key>_cover_<rev>.jpg and <key>_cover_<rev>_thumb.webp), so no app or cache keeps the old one.
--
--   cover_ms             the moment chosen (ms from the start), when the cover is a frame
--   cover_image_media_id the photo it was made from, when it is a photo (the cover is a cropped
--                        copy; it is taken off when that photo is marked sensitive or blocked)
--   default_poster       the poster processing made, kept while a custom cover is up so "Use
--                        default" can put it back: {"url", "thumb", "placeholder", "bytes": {"poster", "thumb"}}.
--                        NULL means the video shows its default poster.
--
-- Choosing which photo of a carousel is its cover needs nothing new: that photo moves to the
-- first position in post_media.
ALTER TABLE media ADD COLUMN IF NOT EXISTS cover_ms integer CHECK (cover_ms IS NULL OR cover_ms >= 0);
ALTER TABLE media ADD COLUMN IF NOT EXISTS cover_image_media_id uuid REFERENCES media(id) ON DELETE SET NULL;
ALTER TABLE media ADD COLUMN IF NOT EXISTS default_poster jsonb;
CREATE INDEX IF NOT EXISTS media_cover_image_idx ON media (cover_image_media_id) WHERE cover_image_media_id IS NOT NULL;
