-- Share a post to your story: a story can show someone's post (or your own) as a card, credited
-- to its author, that opens the post. Only public posts can be added, and the card opens only
-- while the post is still public and the viewer can see it; otherwise the story says the post
-- isn't available.
--
-- No foreign key: a post removed for good leaves the story saying so, rather than an empty story.
ALTER TABLE moments ADD COLUMN shared_post_id uuid;

CREATE INDEX moments_shared_post_idx ON moments (shared_post_id) WHERE shared_post_id IS NOT NULL;
