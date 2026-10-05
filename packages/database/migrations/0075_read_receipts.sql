-- Read receipts can be turned off. It works both ways: with them off you don't see when others
-- have read your messages either.
ALTER TABLE user_preferences ADD COLUMN read_receipts boolean NOT NULL DEFAULT true;
