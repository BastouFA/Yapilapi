-- Yap Radio: hands-free listening, one Yap after another, from stations (docs/product/yap-radio.md,
-- apps/api/src/modules/radio.ts, packages/shared/src/radio.ts).
--
-- The stations are read from the tables Yaps already use (posts, voice_clips, places, follows,
-- squads, user_interests). The radio's own listening is written to feed_events with the surface
-- 'radio', so the recommender learns from it like any listening, and the stations leave out what
-- you finished anywhere and what you quickly skipped on the radio (RADIO_SKIP_DAYS).

ALTER TABLE feed_events DROP CONSTRAINT IF EXISTS feed_events_surface_check;
ALTER TABLE feed_events ADD CONSTRAINT feed_events_surface_check
  CHECK (surface IN ('for_you', 'reels', 'following', 'friends', 'communities', 'profile', 'tag', 'search', 'other', 'yaps', 'squad', 'place', 'radio'));

-- "Already heard": what each person finished, and skipped, looked up per Yap.
CREATE INDEX feed_events_heard_idx ON feed_events (user_id, post_id, created_at DESC) WHERE kind IN ('listen_complete', 'skip');

-- For you on the radio is ranked like the Yaps filter, as its own surface: Yaps that were only on
-- screen in the filter can still play, and the order is kept for the next pages like Pulse's.
ALTER TABLE feed_sessions DROP CONSTRAINT IF EXISTS feed_sessions_surface_check;
ALTER TABLE feed_sessions ADD CONSTRAINT feed_sessions_surface_check CHECK (surface IN ('for_you', 'reels', 'yaps', 'radio'));
