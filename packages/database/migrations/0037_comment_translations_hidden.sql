-- Comment translations also go when a comment is hidden (by the post author's
-- hidden words) or held back by a moderator, as they do on an edit or delete
-- (0035), so no copy of words taken out of sight is kept.
DROP TRIGGER comments_forget_translations ON comments;
CREATE TRIGGER comments_forget_translations AFTER UPDATE OF body, deleted_at, hidden_at, moderation_status ON comments FOR EACH ROW
  WHEN (OLD.body IS DISTINCT FROM NEW.body
        OR (NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL)
        OR (NEW.hidden_at IS NOT NULL AND OLD.hidden_at IS NULL)
        OR (NEW.moderation_status IN ('restricted', 'removed') AND OLD.moderation_status IS DISTINCT FROM NEW.moderation_status))
  EXECUTE FUNCTION forget_translations('comment');
