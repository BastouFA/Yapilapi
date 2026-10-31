-- Translation is something people choose: "Translate automatically" is off by default, and
-- everyone starts with it off (0084 turned it on for everyone, so nobody has chosen it yet).
-- Every message, post and comment in another language still offers "See translation", and the
-- switch is in a chat's menu and in Settings > Language.
ALTER TABLE user_preferences ALTER COLUMN auto_translate SET DEFAULT false;
UPDATE user_preferences SET auto_translate = false WHERE auto_translate;
