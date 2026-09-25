-- 262: MEMORY: provenance of how a memory came to be, dismissals of generated suggestions, AI drafts awaiting confirmation, slideshow exports.
-- Design: docs/product/memory.md.

ALTER TABLE memories
  ADD COLUMN source    text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','on_this_day','trip','experience_export')),
  ADD COLUMN shared_at timestamptz;      -- last time the owner widened privacy beyond 'private' (also written to the audit log)
CREATE INDEX memory_items_item_idx ON memory_items (item_type, item_id);

-- "Not now" on an on-this-day or trip suggestion. Suggestions themselves are never stored: they are recomputed deterministically.
CREATE TABLE memory_suggestion_dismissals (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

-- AI drafts: never applied until the owner confirms. Confirming sets memories.ai_generated + ai_provenance.
CREATE TABLE memory_ai_drafts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id   uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('title','summary','highlights')),
  payload     jsonb NOT NULL,
  provider    text NOT NULL,
  model       text NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','discarded')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX memory_ai_drafts_memory_idx ON memory_ai_drafts (memory_id, created_at DESC);

CREATE TABLE memory_exports (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id  uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('slideshow')),
  media_id   uuid REFERENCES media(id) ON DELETE SET NULL,
  item_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memory_exports_memory_idx ON memory_exports (memory_id, created_at DESC);
