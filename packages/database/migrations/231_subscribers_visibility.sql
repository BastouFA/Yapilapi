-- 231: A proper `subscribers` audience for posts (visibility 'private' would hide the post from the very people who paid for it).
-- The rule itself lives in apps/api/src/lib/visibility.ts (postVisibleSql): an entitled subscription of the AUTHOR, optionally
-- of at least the tier stored in posts.metadata.minTier. Creation is restricted to active creators in createPost.
ALTER TABLE posts DROP CONSTRAINT posts_visibility_check;
ALTER TABLE posts ADD CONSTRAINT posts_visibility_check CHECK (visibility IN ('public','followers','friends','circle','selected','private','community','subscribers'));
CREATE INDEX posts_subscribers_idx ON posts (author_id, created_at DESC, id DESC) WHERE visibility = 'subscribers' AND deleted_at IS NULL;
-- Entitlement lookups (postVisibleSql, hasActiveSubscription) hit (subscriber, creator).
CREATE INDEX subscriptions_entitlement_idx ON subscriptions (subscriber_id, creator_id) WHERE status IN ('active','past_due');
