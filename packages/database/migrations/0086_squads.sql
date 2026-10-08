-- Squads (docs/product/squads.md): small private groups of friends with a shared feed, a shared
-- story, a group chat and a weekly memory. Circles are audience lists one person owns; a squad is a
-- space its members share. Nobody outside a squad sees that it exists, who is in it or what is in it.

-- `color` is one of SQUAD_COLORS (packages/shared/src/constants.ts), shown when there's no cover
-- photo. `cover_media_id` is a processed photo its uploader chose. `conversation_id` is the squad's
-- chat: an ordinary group conversation whose members follow the squad's (lib/squads.ts).
CREATE TABLE squads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  color           text NOT NULL DEFAULT 'coral',
  cover_media_id  uuid REFERENCES media(id) ON DELETE SET NULL,
  conversation_id uuid UNIQUE REFERENCES conversations(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX squads_owner_idx ON squads (owner_id);
CREATE TRIGGER squads_updated BEFORE UPDATE ON squads FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Who is in a squad. 'invited' until they accept (declining deletes the row); invites count
-- towards the squad's size, so it never goes over MAX_SQUAD_MEMBERS. One owner; admins remove people.
CREATE TABLE squad_members (
  squad_id   uuid NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  status     text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active')),
  invited_by uuid REFERENCES users(id) ON DELETE SET NULL,
  invited_at timestamptz NOT NULL DEFAULT now(),
  joined_at  timestamptz,
  PRIMARY KEY (squad_id, user_id)
);
CREATE INDEX squad_members_user_idx ON squad_members (user_id, status);

-- "Your squad's week": made once a week for a squad that shared something (lib/squads.ts,
-- sweepSquadMemories). `summary` keeps counts, who shared and the top posts' ids; posts are read
-- back through the usual visibility rules each time.
CREATE TABLE squad_memories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  squad_id   uuid NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
  week_start date NOT NULL,
  summary    jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (squad_id, week_start)
);

-- Posts and reels shared with a squad. A deleted squad leaves them with their authors only (as a
-- deleted circle does): visibility stays 'squad' and nobody is a member of NULL.
ALTER TABLE posts ADD COLUMN squad_id uuid REFERENCES squads(id) ON DELETE SET NULL;
ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_visibility_check;
ALTER TABLE posts ADD CONSTRAINT posts_visibility_check
  CHECK (visibility IN ('public', 'followers', 'friends', 'circle', 'selected', 'private', 'subscribers', 'squad'));
CREATE INDEX posts_squad_idx ON posts (squad_id, created_at DESC) WHERE squad_id IS NOT NULL;

-- The squad's story: each member's stories for it, in one ring, seen by members only.
ALTER TABLE moments ADD COLUMN squad_id uuid REFERENCES squads(id) ON DELETE SET NULL;
ALTER TABLE moments DROP CONSTRAINT moments_visibility_check;
ALTER TABLE moments ADD CONSTRAINT moments_visibility_check
  CHECK (visibility IN ('public', 'followers', 'friends', 'circle', 'selected', 'private', 'close_friends', 'squad'));
CREATE INDEX moments_squad_idx ON moments (squad_id, created_at DESC) WHERE squad_id IS NOT NULL;

-- Pass the Mic for a squad: only its members see the chain and take the mic. Deleting the squad
-- deletes the chain (its reels stay, with their authors only).
ALTER TABLE reel_chains ADD COLUMN squad_id uuid REFERENCES squads(id) ON DELETE CASCADE;
CREATE INDEX reel_chains_squad_idx ON reel_chains (squad_id) WHERE squad_id IS NOT NULL;
