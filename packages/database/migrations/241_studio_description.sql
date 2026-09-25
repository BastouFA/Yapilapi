-- 241: Studio projects keep the post description the creator is drafting (typed by them or accepted from a suggestion; never published by itself).
ALTER TABLE studio_projects ADD COLUMN description text NOT NULL DEFAULT '' CHECK (length(description) <= 10000);
