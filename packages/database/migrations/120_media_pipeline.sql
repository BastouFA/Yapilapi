-- 120: Media pipeline (uploads, processing, serving authorization).

-- 'attachment' media is only served to people who can see the post / moment / message it is attached to (or the owner).
-- 'public' media (avatars, covers) is world-readable and cached immutably.
ALTER TABLE media ADD COLUMN purpose text NOT NULL DEFAULT 'attachment' CHECK (purpose IN ('attachment','public'));
-- Honest processing state: variants = derived renditions exist, metadata = only probed, passthrough = stored as uploaded.
ALTER TABLE media ADD COLUMN processing text CHECK (processing IN ('variants','metadata','passthrough'));
ALTER TABLE media ADD COLUMN processing_error text;
-- The uploader explicitly declared an image decorative (no alt text needed). Otherwise clients are prompted for alt text.
ALTER TABLE media ADD COLUMN alt_text_declined boolean NOT NULL DEFAULT false;
-- Storage objects of soft-deleted media are removed immediately (best effort) and swept later; NULL = still to purge.
ALTER TABLE media ADD COLUMN purged_at timestamptz;

-- Variants and captions are addressed by their own storage keys; the serving route resolves key -> media through these.
CREATE INDEX media_variants_gin ON media USING gin (variants jsonb_path_ops);
CREATE INDEX media_captions_gin ON media USING gin (captions jsonb_path_ops);
CREATE INDEX media_pending_idx ON media (created_at) WHERE status = 'pending';
CREATE INDEX media_unpurged_idx ON media (deleted_at) WHERE deleted_at IS NOT NULL AND purged_at IS NULL;
CREATE INDEX media_stuck_idx ON media (updated_at) WHERE status IN ('uploaded','processing');
CREATE INDEX post_media_media_idx ON post_media (media_id);

-- World-readable ('public') media must never be attached to audience-restricted content: the attachment would
-- silently bypass the post/moment/message visibility rules. Enforced in the database so every module is covered.
CREATE FUNCTION media_attach_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.media_id IS NOT NULL AND EXISTS (SELECT 1 FROM media WHERE id = NEW.media_id AND purpose = 'public') THEN
    RAISE EXCEPTION 'public media cannot be attached to posts, moments or messages' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER post_media_public_guard BEFORE INSERT ON post_media FOR EACH ROW EXECUTE FUNCTION media_attach_guard();
CREATE TRIGGER message_attachments_public_guard BEFORE INSERT ON message_attachments FOR EACH ROW EXECUTE FUNCTION media_attach_guard();
CREATE TRIGGER moments_public_guard BEFORE INSERT OR UPDATE OF media_id ON moments FOR EACH ROW EXECUTE FUNCTION media_attach_guard();
