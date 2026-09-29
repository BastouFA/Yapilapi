-- Saved reel videos carry a watermark drawn when they were made. Which watermark it was, so a
-- video made with an older one is made again the next time someone saves the reel
-- (SHARE_MARK_VERSION in apps/api/src/lib/share-video.ts). Existing videos have the first one.

ALTER TABLE share_videos ADD COLUMN mark_version integer NOT NULL DEFAULT 1;
