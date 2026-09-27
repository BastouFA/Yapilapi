-- Data saver.
--
-- The setting lives on the account so it follows the person to every device:
-- 'off', 'on', or 'auto' (the app turns it on by itself on slow or metered
-- connections, or when the browser asks to save data). Each device can still
-- override it locally; that choice never reaches the server.
ALTER TABLE user_preferences ADD COLUMN data_saver text NOT NULL DEFAULT 'auto' CHECK (data_saver IN ('off', 'on', 'auto'));

-- How big each processed file of a photo or video is, in bytes, keyed like
-- media.variants (thumb, medium, large, mp4, mp4_360, hls_360, poster ...).
-- Clients use it to pick a size and to show what a download will cost.
ALTER TABLE media ADD COLUMN variant_bytes jsonb NOT NULL DEFAULT '{}';
