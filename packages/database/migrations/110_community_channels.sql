-- 110: Community channels can be archived (soft) without freeing their name for another channel to collide
-- with historical messages. The unique-name index only applies to live channels so a name can be reused after archiving.
ALTER TABLE conversations ADD COLUMN archived_at timestamptz;
DROP INDEX IF EXISTS conversations_channel_unique;
CREATE UNIQUE INDEX conversations_channel_unique ON conversations (community_id, channel_name)
  WHERE kind = 'community_channel' AND archived_at IS NULL;
CREATE INDEX conversations_community_channels_idx ON conversations (community_id, created_at) WHERE kind = 'community_channel';

-- Account deletion must never be blocked by, or destroy, community governance data: creator/author references
-- become nullable and are cleared (not cascaded) when the user row goes away.
ALTER TABLE communities ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE communities DROP CONSTRAINT communities_created_by_fkey;
ALTER TABLE communities ADD CONSTRAINT communities_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE community_resources ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE community_resources DROP CONSTRAINT community_resources_created_by_fkey;
ALTER TABLE community_resources ADD CONSTRAINT community_resources_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE community_decisions ALTER COLUMN decided_by DROP NOT NULL;
ALTER TABLE community_decisions DROP CONSTRAINT community_decisions_decided_by_fkey;
ALTER TABLE community_decisions ADD CONSTRAINT community_decisions_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE SET NULL;
