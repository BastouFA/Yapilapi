-- Near you: a live map of what's happening around you (docs/product/city-map.md,
-- packages/shared/src/city-map.ts, apps/api/src/lib/city-map.ts).
--
-- Posts and lives can name a place (a place page, whose point is public already), so they can be
-- found on the map: reels and posts make a place "buzzing", lives show while they're on, and Pass
-- the Mic chains show where their reels were made. Nobody's own position is ever kept for this,
-- except a friend who chose "Show me on the map to friends" (map_presence below).

ALTER TABLE posts ADD COLUMN place_id uuid REFERENCES places(id) ON DELETE SET NULL;
-- A place's recent posts (Places buzzing, chains near you).
CREATE INDEX posts_place_idx ON posts (place_id, created_at DESC) WHERE place_id IS NOT NULL AND deleted_at IS NULL;

ALTER TABLE live_sessions ADD COLUMN place_id uuid REFERENCES places(id) ON DELETE SET NULL;
CREATE INDEX live_sessions_place_idx ON live_sessions (place_id) WHERE place_id IS NOT NULL AND status = 'live';

-- Events at a place by time (Today on the map).
CREATE INDEX events_place_starts_idx ON events (place_id, starts_at) WHERE place_id IS NOT NULL AND deleted_at IS NULL;
-- Places in a box, only the ones still up.
CREATE INDEX places_geo_live_idx ON places (lat, lng) WHERE deleted_at IS NULL AND lat IS NOT NULL;

-- "Show me on the map to friends": off unless someone turns it on, and then only for a time they
-- choose (1 hour, 4 hours or until midnight; never more than a day). The point is snapped to a grid
-- about a kilometre across before it's stored (LOCATION_APPROXIMATE_METRES), only the latest one is
-- kept, and the row is deleted when it ends or is stopped: no history.
CREATE TABLE map_presence (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  lat        double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng        double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ends_at    timestamptz NOT NULL,
  CHECK (ends_at > started_at AND ends_at <= started_at + interval '24 hours 1 minute')
);
CREATE INDEX map_presence_geo_idx ON map_presence (lat, lng);
CREATE INDEX map_presence_ends_idx ON map_presence (ends_at);
