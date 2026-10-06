-- Changing an account's email: a link sent to the new address confirms it, and only then does
-- the email change. The pending address rides on the token.
ALTER TABLE auth_tokens ADD COLUMN IF NOT EXISTS new_email text;
ALTER TABLE auth_tokens DROP CONSTRAINT IF EXISTS auth_tokens_purpose_check;
ALTER TABLE auth_tokens ADD CONSTRAINT auth_tokens_purpose_check
  CHECK (purpose IN ('verify_email', 'reset_password', 'recovery', 'appeal', 'change_email'));
ALTER TABLE auth_tokens DROP CONSTRAINT IF EXISTS auth_tokens_new_email_check;
ALTER TABLE auth_tokens ADD CONSTRAINT auth_tokens_new_email_check CHECK ((purpose = 'change_email') = (new_email IS NOT NULL));
