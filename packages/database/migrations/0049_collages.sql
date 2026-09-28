-- Photo collages: 2 to 9 of your own processed photos put together on the server, in a layout from
-- @yapilapi/shared (collage.ts). The result is an ordinary photo (media_id) that goes through the
-- same processing and checks as an upload. One row per client key, so a request that is sent again
-- (a flaky connection, a double tap) gives back the same collage instead of making a second one.
-- media_id is empty while the collage is being made.

CREATE TABLE media_collages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_key  text NOT NULL CHECK (char_length(client_key) BETWEEN 8 AND 64),
  media_id    uuid REFERENCES media(id) ON DELETE CASCADE,
  -- The photos it was made from, in cell order: a collage is at least as sensitive as they are.
  source_ids  uuid[] NOT NULL,
  -- Layout, shape, gap, corners, background and each cell's photo, focus and zoom.
  spec        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, client_key)
);
CREATE INDEX media_collages_media_idx ON media_collages (media_id);
