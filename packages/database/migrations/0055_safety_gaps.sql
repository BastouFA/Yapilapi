-- Safety and legal gaps from the legal review (docs/legal/review-pack.md, "Findings").

-- ── Appeals get a different reviewer ────────────────────────────────────
-- Who made the decision being appealed: they can't decide the appeal. Recorded when the appeal
-- is made (the case's reviewer changes once the appeal is decided). An appeal waits until
-- someone else reviews it, and says whether the first decision was upheld or overturned.
ALTER TABLE appeals
  ADD COLUMN original_reviewer_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN reviewer_id          uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN decided_at           timestamptz;
UPDATE appeals a SET original_reviewer_id = mc.reviewer_id FROM moderation_cases mc WHERE mc.id = a.case_id AND mc.status = 'appealed';

-- ── Reports: when they were closed ──────────────────────────────────────
-- Reports and moderation decisions are kept for a period after the case closes (lib/retention.ts).
ALTER TABLE reports ADD COLUMN closed_at timestamptz;
CREATE INDEX reports_closed_idx ON reports (closed_at) WHERE status = 'closed';
CREATE INDEX moderation_cases_decided_idx ON moderation_cases (decided_at) WHERE status IN ('decided', 'final');

-- ── Indexes for the daily retention clean-up ────────────────────────────
CREATE INDEX calls_ended_idx ON calls (coalesce(ended_at, created_at)) WHERE status NOT IN ('ringing', 'active');
CREATE INDEX watch_sessions_ended_idx ON watch_sessions (ended_at) WHERE status = 'ended';
CREATE INDEX chat_games_ended_idx ON chat_games (ended_at) WHERE status <> 'active';
CREATE INDEX known_sign_ins_seen_idx ON known_sign_ins (last_seen_at);
CREATE INDEX username_history_held_idx ON username_history (held_until);
CREATE INDEX business_views_day_idx ON business_views (day);
CREATE INDEX ad_events_created_idx ON ad_events (created_at) WHERE kind <> 'hide';
CREATE INDEX post_views_viewed_idx ON post_views (viewed_at);
CREATE INDEX orders_created_idx ON orders (created_at);
