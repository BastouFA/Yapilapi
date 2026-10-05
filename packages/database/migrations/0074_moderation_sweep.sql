-- Trust and safety sweep (2026-10-05).

-- ── Stories can be held and restricted like posts ──────────────────────
-- A minor-safety report hides a story at once (its author still sees it) until a moderator
-- decides, and "Restrict" now means something for a story.
ALTER TABLE moments ADD COLUMN moderation_status text NOT NULL DEFAULT 'normal'
  CHECK (moderation_status IN ('normal', 'review', 'restricted', 'removed'));

-- ── A warning ───────────────────────────────────────────────────────────
-- The content stays up; the person is told it broke the rules and can appeal.
ALTER TABLE moderation_cases DROP CONSTRAINT IF EXISTS moderation_cases_decision_check;
ALTER TABLE moderation_cases ADD CONSTRAINT moderation_cases_decision_check
  CHECK (decision IN ('no_action', 'warn', 'restrict', 'remove', 'suspend_user', 'approve_ad', 'reject_ad'));

-- ── Suspensions made from the admin console are cases too ──────────────
-- So they reach the person the same way and can be appealed.
ALTER TABLE moderation_cases DROP CONSTRAINT IF EXISTS moderation_cases_source_check;
ALTER TABLE moderation_cases ADD CONSTRAINT moderation_cases_source_check
  CHECK (source IN ('report', 'automated', 'appeal', 'ad_review', 'admin'));

-- ── What an appeal was against ─────────────────────────────────────────
-- The case's decision changes when an appeal overturns it; the appeal keeps the first one, so
-- Settings can say "Post: removed. Your appeal was accepted" and the decision can be undone.
ALTER TABLE appeals ADD COLUMN original_decision text;
UPDATE appeals a SET original_decision = mc.decision FROM moderation_cases mc WHERE mc.id = a.case_id AND a.status IN ('open', 'upheld');

-- ── Appealing a suspension ─────────────────────────────────────────────
-- A suspended account can't sign in, so signing in with the right password gives a short-lived
-- token that can only send an appeal against the suspension.
ALTER TABLE auth_tokens DROP CONSTRAINT IF EXISTS auth_tokens_purpose_check;
ALTER TABLE auth_tokens ADD CONSTRAINT auth_tokens_purpose_check CHECK (purpose IN ('verify_email', 'reset_password', 'recovery', 'appeal'));
