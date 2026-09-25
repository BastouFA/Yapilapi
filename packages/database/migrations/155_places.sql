-- 155: Places: timezone-aware hours, claims by businesses (staff-verified), edit suggestions, photo moderation, review replies.

ALTER TABLE places
  ADD COLUMN timezone        text NOT NULL DEFAULT 'UTC',
  ADD COLUMN booking_enabled boolean NOT NULL DEFAULT false;
CREATE INDEX places_created_by_idx ON places (created_by) WHERE created_by IS NOT NULL;

ALTER TABLE place_media
  ADD COLUMN added_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN caption  text CHECK (caption IS NULL OR length(caption) <= 300),
  ADD COLUMN moderation_status text NOT NULL DEFAULT 'approved' CHECK (moderation_status IN ('approved','pending_review','removed')),
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX place_media_pending_idx ON place_media (place_id) WHERE moderation_status = 'pending_review';

-- Claim workflow: pending -> approved | rejected (staff, moderator+), or withdrawn by the claimant.
CREATE TABLE place_claims (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  place_id     uuid NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  claimant_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','withdrawn')),
  evidence     text NOT NULL DEFAULT '' CHECK (length(evidence) <= 2000),
  decided_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at   timestamptz,
  decision_note text CHECK (decision_note IS NULL OR length(decision_note) <= 1000),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX place_claims_pending_unique ON place_claims (place_id, business_id) WHERE status = 'pending';
CREATE INDEX place_claims_status_idx ON place_claims (status, created_at);
CREATE INDEX place_claims_business_idx ON place_claims (business_id, created_at DESC);
CREATE TRIGGER place_claims_updated BEFORE UPDATE ON place_claims FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE place_edit_suggestions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  place_id     uuid NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  suggested_by uuid REFERENCES users(id) ON DELETE CASCADE,
  changes      jsonb NOT NULL,
  note         text NOT NULL DEFAULT '' CHECK (length(note) <= 1000),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','withdrawn')),
  reviewed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at  timestamptz,
  review_note  text CHECK (review_note IS NULL OR length(review_note) <= 1000),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX place_edit_suggestions_place_idx ON place_edit_suggestions (place_id, status, created_at DESC);
CREATE INDEX place_edit_suggestions_user_idx ON place_edit_suggestions (suggested_by, created_at DESC);

ALTER TABLE reviews
  ADD COLUMN owner_reply    text CHECK (owner_reply IS NULL OR length(owner_reply) <= 2000),
  ADD COLUMN owner_reply_at timestamptz,
  ADD COLUMN owner_reply_by uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX reviews_author_idx ON reviews (author_id);

-- Reviews are report-able through the shared reports table. The constraint is rebuilt from its live definition so that
-- values added by other migrations are preserved.
DO $$
DECLARE def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conname = 'reports_target_type_check' AND conrelid = 'reports'::regclass;
  IF def IS NOT NULL AND def NOT LIKE '%''review''%' THEN
    EXECUTE 'ALTER TABLE reports DROP CONSTRAINT reports_target_type_check';
    EXECUTE 'ALTER TABLE reports ADD CONSTRAINT reports_target_type_check ' || replace(def, 'ARRAY[', 'ARRAY[''review''::text, ');
  END IF;
END $$;
