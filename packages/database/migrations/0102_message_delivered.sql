-- "Delivered": up to when each person's device has received a chat's messages (its app was connected,
-- it opened the app, or its browser got the notification). Read is last_read_at, as before.
ALTER TABLE conversation_members ADD COLUMN last_delivered_at timestamptz;
