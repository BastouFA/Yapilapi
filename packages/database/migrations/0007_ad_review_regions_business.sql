-- Ad review before a campaign runs, regional moderation rules (content withheld
-- per country, never deleted), and business insights (page views).

-- ─── Posts: updated_at means "content last edited" ─────────────────────
-- Counters (likes, comments) and moderation changes no longer bump it, so it
-- can be compared with an ad approval time.
DROP TRIGGER IF EXISTS posts_updated ON posts;
CREATE TRIGGER posts_updated BEFORE UPDATE OF kind, body, link_url, topics, event_id, product_id, metadata ON posts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── Ad review ─────────────────────────────────────────────────────────
ALTER TABLE ad_campaigns DROP CONSTRAINT IF EXISTS ad_campaigns_status_check;
ALTER TABLE ad_campaigns ADD CONSTRAINT ad_campaigns_status_check
  CHECK (status IN ('draft', 'pending_review', 'active', 'paused', 'ended', 'rejected'));
ALTER TABLE ad_campaigns ADD COLUMN submitted_at timestamptz;
ALTER TABLE ad_campaigns ADD COLUMN approved_at timestamptz;
ALTER TABLE ad_campaigns ADD COLUMN reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL;
-- Shown to the advertiser when a campaign is rejected.
ALTER TABLE ad_campaigns ADD COLUMN review_note text;
ALTER TABLE ad_campaigns ADD COLUMN review_case_id uuid REFERENCES moderation_cases(id) ON DELETE SET NULL;
CREATE INDEX ad_campaigns_review_idx ON ad_campaigns (submitted_at) WHERE status = 'pending_review';

-- Campaigns that already ran before review existed keep running without a new review.
UPDATE ad_campaigns SET approved_at = now() WHERE status IN ('active', 'paused', 'ended') AND approved_at IS NULL;

ALTER TABLE moderation_cases DROP CONSTRAINT IF EXISTS moderation_cases_source_check;
ALTER TABLE moderation_cases ADD CONSTRAINT moderation_cases_source_check CHECK (source IN ('report', 'automated', 'appeal', 'ad_review'));
ALTER TABLE moderation_cases DROP CONSTRAINT IF EXISTS moderation_cases_decision_check;
ALTER TABLE moderation_cases ADD CONSTRAINT moderation_cases_decision_check
  CHECK (decision IN ('no_action', 'restrict', 'remove', 'suspend_user', 'approve_ad', 'reject_ad'));

-- ─── Regional moderation rules ─────────────────────────────────────────
-- The viewer's country (ISO 3166-1 alpha-2). Set by the person in Settings,
-- or recorded from a trusted CDN header (TRUSTED_COUNTRY_HEADER) when they
-- haven't chosen one.
ALTER TABLE profiles ADD COLUMN country char(2) CHECK (country ~ '^[A-Z]{2}$');
ALTER TABLE profiles ADD COLUMN country_source text CHECK (country_source IN ('user', 'cdn'));

CREATE TABLE regional_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country     char(2) NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  kind        text NOT NULL CHECK (kind IN ('blocked_term', 'restrict_topic')),
  term        text CHECK (term IS NULL OR length(term) BETWEEN 2 AND 100),
  topic       text CHECK (topic IS NULL OR topic ~ '^[a-z0-9_-]{1,40}$'),
  legal_basis text NOT NULL CHECK (length(legal_basis) BETWEEN 3 AND 1000),
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'blocked_term' AND term IS NOT NULL AND topic IS NULL) OR (kind = 'restrict_topic' AND topic IS NOT NULL AND term IS NULL))
);
CREATE UNIQUE INDEX regional_rules_once_key ON regional_rules (country, kind, lower(coalesce(term, topic)));

-- Which posts are withheld where. Maintained by the triggers below, so a
-- read only needs one primary-key probe per post: (post_id, country).
CREATE TABLE post_withholdings (
  post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  country char(2) NOT NULL,
  rule_id uuid NOT NULL REFERENCES regional_rules(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, country, rule_id)
);
CREATE INDEX post_withholdings_rule_idx ON post_withholdings (rule_id);

-- Literal, case-insensitive substring match: % and _ in a term are not wildcards.
CREATE OR REPLACE FUNCTION regional_rule_matches(r regional_rules, body text, topics text[]) RETURNS boolean AS $$
  SELECT CASE r.kind
    WHEN 'restrict_topic' THEN r.topic = ANY(topics)
    WHEN 'blocked_term' THEN body ILIKE '%' || replace(replace(replace(r.term, '\', '\\'), '%', '\%'), '_', '\_') || '%'
    ELSE false END;
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION posts_refresh_withholdings() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    DELETE FROM post_withholdings WHERE post_id = NEW.id;
  END IF;
  INSERT INTO post_withholdings (post_id, country, rule_id)
    SELECT NEW.id, r.country, r.id FROM regional_rules r WHERE regional_rule_matches(r, NEW.body, NEW.topics);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER posts_withholdings AFTER INSERT OR UPDATE OF body, topics ON posts
  FOR EACH ROW EXECUTE FUNCTION posts_refresh_withholdings();

CREATE OR REPLACE FUNCTION regional_rules_apply() RETURNS trigger AS $$
BEGIN
  INSERT INTO post_withholdings (post_id, country, rule_id)
    SELECT p.id, NEW.country, NEW.id FROM posts p WHERE p.deleted_at IS NULL AND regional_rule_matches(NEW, p.body, p.topics);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER regional_rules_applied AFTER INSERT ON regional_rules
  FOR EACH ROW EXECUTE FUNCTION regional_rules_apply();

-- ─── Business insights ─────────────────────────────────────────────────
-- One row per signed-in viewer per page per day (the owner's own visits are not recorded).
CREATE TABLE business_views (
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('business', 'place')),
  target_id   uuid NOT NULL,
  viewer_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day         date NOT NULL DEFAULT current_date,
  PRIMARY KEY (target_id, day, viewer_id)
);
CREATE INDEX business_views_business_idx ON business_views (business_id, day);
