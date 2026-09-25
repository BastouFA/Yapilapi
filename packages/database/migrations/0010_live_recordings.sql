-- Live recordings (written by MediaMTX when LIVE_RECORDINGS_DIR is set) and
-- automatic highlight clips cut from them.
ALTER TABLE live_sessions ADD COLUMN recording_media_id uuid REFERENCES media(id) ON DELETE SET NULL;
ALTER TABLE live_sessions ADD COLUMN recording_status text CHECK (recording_status IN ('pending', 'ready', 'none', 'failed'));
ALTER TABLE media_edits ADD COLUMN auto boolean NOT NULL DEFAULT false;
