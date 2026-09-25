-- 190: Trust & safety. Extends the moderation pipeline (Content -> Analysis -> Risk -> Normal/Review/Restrict/Escalate ->
-- Appeal -> Final) with the data the staff console and appeals flow need. Migration 006 is never edited.

ALTER TABLE moderation_cases
  ADD COLUMN risk_rank        smallint GENERATED ALWAYS AS (CASE risk_level WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END) STORED,
  ADD COLUMN content_snapshot jsonb,                                   -- evidence: what the content said when it was reported/flagged
  ADD COLUMN report_count     integer NOT NULL DEFAULT 0,
  ADD COLUMN claimed_at       timestamptz,
  ADD COLUMN decided_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN decided_at       timestamptz,
  ADD COLUMN decision_reason  text,
  ADD COLUMN decision_note    text,                                    -- internal, never shown to the subject
  ADD COLUMN effects          jsonb NOT NULL DEFAULT '{}'::jsonb;      -- what the decision changed, so an overturned appeal can restore it
CREATE INDEX moderation_cases_queue_idx ON moderation_cases (risk_rank DESC, created_at ASC, id) WHERE state <> 'resolved';
CREATE INDEX moderation_cases_subject_idx ON moderation_cases (subject_user_id, created_at DESC);
CREATE INDEX moderation_cases_assigned_idx ON moderation_cases (assigned_to) WHERE assigned_to IS NOT NULL AND state <> 'resolved';

-- Case timeline: every pipeline transition and staff action, in order.
CREATE TABLE moderation_case_events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id    uuid NOT NULL REFERENCES moderation_cases(id) ON DELETE CASCADE,
  actor_id   uuid,                                                     -- null = system
  event      text NOT NULL,
  from_state text,
  to_state   text,
  data       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX moderation_case_events_case_idx ON moderation_case_events (case_id, id);

ALTER TABLE enforcements
  ADD COLUMN strike_points smallint NOT NULL DEFAULT 0 CHECK (strike_points >= 0),
  ADD COLUMN metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Suspended users cannot sign in, so their appeal link carries a single-purpose token (hash only; emailed to them).
  ADD COLUMN appeal_token_hash text;
CREATE UNIQUE INDEX enforcements_appeal_token_idx ON enforcements (appeal_token_hash) WHERE appeal_token_hash IS NOT NULL;
CREATE INDEX enforcements_active_idx ON enforcements (user_id, kind) WHERE revoked_at IS NULL;
CREATE INDEX enforcements_expiry_idx ON enforcements (ends_at) WHERE revoked_at IS NULL AND ends_at IS NOT NULL;

-- Appeals: the reviewer must not be the person who made the original decision (also enforced in the API).
ALTER TABLE appeals
  ADD COLUMN original_decider_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT appeal_reviewer_not_original_decider CHECK (reviewer_id IS NULL OR original_decider_id IS NULL OR reviewer_id <> original_decider_id),
  ADD CONSTRAINT appeal_reviewer_not_appellant CHECK (reviewer_id IS NULL OR reviewer_id <> user_id);
CREATE INDEX appeals_status_idx ON appeals (status, created_at);

CREATE INDEX reports_reporter_idx ON reports (reporter_id, created_at DESC);

-- Guardian links: the teen invites, the guardian accepts. A guardian sees safety settings and an enforcement summary
-- for the teen, NEVER message content (enforced by what the endpoints select, and documented in docs/security).
ALTER TABLE guardian_links
  ADD COLUMN invited_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN accepted_at timestamptz,
  ADD COLUMN revoked_at  timestamptz;
CREATE INDEX guardian_links_guardian_idx ON guardian_links (guardian_id, status);

-- Behaviour signals raised by the anti-spam scorer and other automated checks (explainable, dedupes case creation).
CREATE TABLE safety_signals (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL,
  score      smallint NOT NULL DEFAULT 0,
  details    jsonb NOT NULL DEFAULT '{}'::jsonb,
  case_id    uuid REFERENCES moderation_cases(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX safety_signals_user_idx ON safety_signals (user_id, kind, created_at DESC);
