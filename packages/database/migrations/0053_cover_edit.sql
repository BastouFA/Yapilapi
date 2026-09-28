-- Edited cover photos. A cover can be framed, straightened, given a look and adjusted in the
-- editor. The original upload stays untouched (cover_media_id); cover_edit keeps the recipe
-- (look and strength, adjustments, turns, flips, straighten, crop) so "Edit cover" opens the
-- original again as it was left; cover_render_media_id is the copy the server rendered from the
-- original with that recipe, and cover_url its address. A new edit always renders from the
-- original, never from an earlier copy; the copy it replaces is marked deleted and cleaned up
-- with other deleted media.
ALTER TABLE profiles ADD COLUMN cover_edit jsonb;
ALTER TABLE profiles ADD COLUMN cover_render_media_id uuid REFERENCES media(id) ON DELETE SET NULL;
CREATE INDEX profiles_cover_render_idx ON profiles (cover_render_media_id) WHERE cover_render_media_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS profiles_cover_media_idx ON profiles (cover_media_id) WHERE cover_media_id IS NOT NULL;
