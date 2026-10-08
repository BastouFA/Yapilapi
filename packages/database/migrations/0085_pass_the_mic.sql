-- Pass the Mic and Fair start (docs/product/pass-the-mic.md): reels made together one after
-- another (chains), and a fair first audience for new creators' reels.

-- A chain: a prompt someone starts with one of their reels ("Show your city's best street food"),
-- that others answer with reels of their own, in order. `who_can_join` 'nobody' is a closed chain.
-- `sound_id` is the starter reel's sound, offered to whoever takes the mic next.
CREATE TABLE reel_chains (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  starter_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  first_post_id uuid REFERENCES posts(id) ON DELETE SET NULL,
  prompt        text NOT NULL CHECK (char_length(prompt) BETWEEN 1 AND 120),
  sound_id      uuid REFERENCES sounds(id) ON DELETE SET NULL,
  who_can_join  text NOT NULL DEFAULT 'everyone' CHECK (who_can_join IN ('everyone', 'following', 'nobody')),
  -- Each new link takes the next number, so the order never changes when links leave.
  next_position integer NOT NULL DEFAULT 1,
  last_link_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reel_chains_starter_idx ON reel_chains (starter_id, created_at DESC);
-- Active chains for Wander.
CREATE INDEX reel_chains_active_idx ON reel_chains (last_link_at DESC);

-- A chain's reels, in order. A reel is in one chain at most; removing it from the chain (or
-- leaving) deletes the row and never the reel.
CREATE TABLE reel_chain_links (
  post_id    uuid PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  chain_id   uuid NOT NULL REFERENCES reel_chains(id) ON DELETE CASCADE,
  author_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  position   integer NOT NULL CHECK (position > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id, position)
);
CREATE INDEX reel_chain_links_author_idx ON reel_chain_links (author_id, created_at DESC);

-- "Pass the mic": someone in a chain invited a friend to add the next reel. Once per person.
CREATE TABLE reel_chain_passes (
  chain_id   uuid NOT NULL REFERENCES reel_chains(id) ON DELETE CASCADE,
  from_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, from_id, to_id),
  CHECK (from_id <> to_id)
);

-- Fair start: a new creator's reel shown to up to `target` real people (FAIR_START in
-- packages/shared/src/constants.ts). 'active' while it's being shown; 'done' when it reached its
-- target or its time ran out (the creator gets the report); 'stopped' when it was taken down.
-- `slowed`: early viewers mostly moved on at once, or it was reported, so it goes to fewer people.
CREATE TABLE fair_start_reels (
  post_id     uuid PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  author_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done', 'stopped')),
  target      integer NOT NULL CHECK (target > 0),
  reached     integer NOT NULL DEFAULT 0 CHECK (reached >= 0),
  slowed      boolean NOT NULL DEFAULT false,
  started_at  timestamptz NOT NULL DEFAULT now(),
  ends_at     timestamptz NOT NULL,
  finished_at timestamptz,
  -- What the report said when it finished: { reached, finished, shared, followed }.
  report      jsonb
);
CREATE INDEX fair_start_reels_author_idx ON fair_start_reels (author_id, started_at DESC);
-- One running at a time per creator.
CREATE UNIQUE INDEX fair_start_reels_one_active ON fair_start_reels (author_id) WHERE status = 'active';
CREATE INDEX fair_start_reels_active_idx ON fair_start_reels (ends_at) WHERE status = 'active';

-- Each real person who saw a fair-start reel, once: who counts toward its target, and who never
-- gets it again in a fair-start slot.
CREATE TABLE fair_start_views (
  post_id    uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  viewer_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, viewer_id)
);
CREATE INDEX fair_start_views_viewer_idx ON fair_start_views (viewer_id);

