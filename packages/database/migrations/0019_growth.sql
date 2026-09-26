-- Growth: find friends from your contacts, share a reel as a watermarked video,
-- and the two settings that control them.

-- ── Contact matching ─────────────────────────────────────────────────────
-- A salt fixed for this deployment. Apps hash each contact on the device as
-- sha256("<salt>:<kind>:<normalized value>") and send only the hashes. The salt
-- is not a secret (apps read it from GET /v1/contacts/salt); it keeps these
-- hashes from being comparable with other services' hashes.
CREATE TABLE deployment_secrets (
  name       text PRIMARY KEY,
  value      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO deployment_secrets (name, value)
VALUES ('contact_salt', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
ON CONFLICT (name) DO NOTHING;

-- kind is 'email' today. Phone numbers would use 'phone' with the E.164 form,
-- so adding them later needs a column and a trigger line, not a new app release.
CREATE FUNCTION contact_hash(kind text, value text) RETURNS bytea LANGUAGE sql STABLE AS $$
  SELECT sha256(convert_to((SELECT d.value FROM deployment_secrets d WHERE d.name = 'contact_salt') || ':' || kind || ':' || value, 'UTF8'))
$$;

-- "Let people who have my email or phone number find me". On by default; it
-- never applies to people under 18 (checked when matching, so it follows age).
ALTER TABLE users ADD COLUMN findable_by_contacts boolean NOT NULL DEFAULT true;
-- Hash of the verified email only. Unverified addresses never match.
ALTER TABLE users ADD COLUMN contact_email_hash bytea;
CREATE INDEX users_contact_email_hash_idx ON users (contact_email_hash) WHERE contact_email_hash IS NOT NULL;

CREATE FUNCTION users_contact_hash() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.contact_email_hash := CASE
    WHEN NEW.email_verified_at IS NOT NULL AND NEW.deleted_at IS NULL THEN contact_hash('email', lower(trim(NEW.email)))
  END;
  RETURN NEW;
END $$;
CREATE TRIGGER users_contact_hash BEFORE INSERT OR UPDATE OF email, email_verified_at, deleted_at ON users
  FOR EACH ROW EXECUTE FUNCTION users_contact_hash();
UPDATE users SET contact_email_hash = contact_hash('email', lower(trim(email)))
WHERE email_verified_at IS NOT NULL AND deleted_at IS NULL;

-- ── Sharing reels as videos ─────────────────────────────────────────────
-- Whether others may download your reels as a video to share elsewhere.
-- NULL means the default: on for public accounts, off for private ones.
-- Never on for people under 18.
ALTER TABLE profiles ADD COLUMN allow_download boolean;

-- One rendered share video per reel. The handle drawn on it is kept so a
-- renamed account gets a fresh render instead of an old @name.
CREATE TABLE share_videos (
  post_id      uuid PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'ready', 'failed')),
  username     text NOT NULL,
  storage_key  text,
  url          text,
  error        text,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER share_videos_updated BEFORE UPDATE ON share_videos FOR EACH ROW EXECUTE FUNCTION set_updated_at();
