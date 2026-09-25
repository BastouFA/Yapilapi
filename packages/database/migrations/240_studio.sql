-- 240: Creator Studio runtime. Builds on 005 `studio_projects` (project shell). Non-destructive edit decision list (EDL), caption tracks,
-- render jobs (ffmpeg, honest when unavailable), AI/heuristic suggestions (never applied automatically), publish confirmations.

ALTER TABLE studio_projects DROP CONSTRAINT studio_projects_status_check;
ALTER TABLE studio_projects
  ADD CONSTRAINT studio_projects_status_check CHECK (status IN ('draft','processing','ready','failed','published')),
  -- The EDL never modifies the source media: it is a recipe applied at render time. See apps/api/src/modules/studio/edl.ts.
  ADD COLUMN edl              jsonb NOT NULL DEFAULT '{"version":1,"segments":[],"aspect":null,"thumbnail":null,"captions":null}'::jsonb,
  ADD COLUMN edl_version      integer NOT NULL DEFAULT 1,
  ADD COLUMN output_media_id  uuid REFERENCES media(id) ON DELETE SET NULL,
  ADD COLUMN rendered_edl_hash text,
  ADD COLUMN render_error     text,
  ADD COLUMN ai_assisted      text[] NOT NULL DEFAULT '{}',        -- names of assist features whose output the user accepted (feeds ai_provenance)
  ADD COLUMN deleted_at       timestamptz;
CREATE INDEX studio_projects_owner_live_idx ON studio_projects (owner_id, updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE studio_caption_tracks (
  project_id uuid NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE,
  lang       text NOT NULL CHECK (length(lang) BETWEEN 2 AND 12),
  label      text NOT NULL DEFAULT '',
  kind       text NOT NULL DEFAULT 'captions' CHECK (kind IN ('captions','subtitles')),
  source     text NOT NULL CHECK (source IN ('manual','imported','speech','ai_translation')),
  cues       jsonb NOT NULL,                                      -- [{startMs,endMs,text}] validated by studio/captions.ts
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, lang)
);

CREATE TABLE studio_render_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE,
  requested_by    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  edl_hash        text NOT NULL,
  options         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed')),
  error_code      text,
  output_media_id uuid REFERENCES media(id) ON DELETE SET NULL,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);
CREATE INDEX studio_render_jobs_project_idx ON studio_render_jobs (project_id, started_at DESC);
-- One render at a time per project (double clicks and retries cannot fork the output).
CREATE UNIQUE INDEX studio_render_one_running ON studio_render_jobs (project_id) WHERE status = 'running';

CREATE TABLE studio_suggestions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('title','description','thumbnail','silence_cuts','highlights','captions_review')),
  source      text NOT NULL CHECK (source IN ('heuristic','ffmpeg','ai_module')),
  provider    text,
  payload     jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested','accepted','dismissed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  decided_at  timestamptz
);
CREATE INDEX studio_suggestions_project_idx ON studio_suggestions (project_id, created_at DESC);

-- A publication is what the USER explicitly confirmed: the exact post content + the exact media. `content_hash` binds the two, so a
-- scheduled publish can be refused if anything changed after the confirmation. Nothing is ever published without a confirmed row.
CREATE TABLE studio_publications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE,
  confirmed_by  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode          text NOT NULL CHECK (mode IN ('now','scheduled')),
  publish_at    timestamptz,
  post_input    jsonb NOT NULL,
  media_id      uuid NOT NULL REFERENCES media(id) ON DELETE RESTRICT,
  content_hash  text NOT NULL,
  status        text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','published','cancelled','stale','failed')),
  post_id       uuid REFERENCES posts(id) ON DELETE SET NULL,
  error         text,
  confirmed_at  timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz,
  CONSTRAINT publication_schedule CHECK ((mode = 'scheduled') = (publish_at IS NOT NULL))
);
CREATE INDEX studio_publications_due_idx ON studio_publications (publish_at) WHERE status = 'confirmed' AND mode = 'scheduled';
CREATE UNIQUE INDEX studio_publications_one_open ON studio_publications (project_id) WHERE status = 'confirmed';
