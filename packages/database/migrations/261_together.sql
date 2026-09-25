-- 261: REAL TOGETHER (shared experiences): membership metadata, moderation, ordering by when a perspective happened, collaborative cover.
-- Design: docs/product/real-together.md.

ALTER TABLE shared_experience_members
  ADD COLUMN invited_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN invited_at      timestamptz NOT NULL DEFAULT now(),
  -- A member's experiences never show on their profile unless THEY switch this on.
  ADD COLUMN show_on_profile boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX shared_experience_one_owner ON shared_experience_members (experience_id) WHERE role = 'owner';

ALTER TABLE shared_experience_contributions
  ADD COLUMN moderation_status text NOT NULL DEFAULT 'approved'
    CHECK (moderation_status IN ('approved','pending_review','restricted','removed','escalated')),
  ADD COLUMN taken_at timestamptz NOT NULL DEFAULT now();       -- when the perspective happened (timeline order); created_at is when it was added
-- Withdrawn contributions are blanked (text erased) and soft-deleted: the "has content" rule only applies to live ones.
ALTER TABLE shared_experience_contributions DROP CONSTRAINT contribution_has_content;
ALTER TABLE shared_experience_contributions ADD CONSTRAINT contribution_has_content
  CHECK (deleted_at IS NOT NULL OR media_id IS NOT NULL OR real_capture_id IS NOT NULL OR length(body) > 0);
CREATE INDEX shared_experience_contrib_timeline_idx ON shared_experience_contributions (experience_id, taken_at, id) WHERE deleted_at IS NULL;
CREATE INDEX shared_experience_contrib_author_idx ON shared_experience_contributions (contributor_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX shared_experience_contrib_media_uniq ON shared_experience_contributions (experience_id, media_id) WHERE media_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX shared_experience_contrib_real_uniq ON shared_experience_contributions (experience_id, real_capture_id) WHERE real_capture_id IS NOT NULL AND deleted_at IS NULL;

ALTER TABLE shared_experiences
  ADD COLUMN cover_contribution_id uuid REFERENCES shared_experience_contributions(id) ON DELETE SET NULL,   -- owner's pinned cover (overrides votes)
  ADD COLUMN closed_at   timestamptz,
  ADD COLUMN archived_at timestamptz;
CREATE INDEX shared_experiences_event_idx ON shared_experiences (event_id) WHERE event_id IS NOT NULL AND deleted_at IS NULL;

-- Collaborative cover: every joined contributor may vote for one media/Real contribution; the owner may pin one.
CREATE TABLE shared_experience_cover_votes (
  experience_id   uuid NOT NULL REFERENCES shared_experiences(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contribution_id uuid NOT NULL REFERENCES shared_experience_contributions(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (experience_id, user_id)
);
