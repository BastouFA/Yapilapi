-- Stickers in chats: the ones each person made (a photo cut to a shape in the app) or saved from a
-- chat, kept to send again from the Stickers tab beside the emojis. Each is a photo of their own;
-- one saved from someone else's message is a copy of it, and from_media_id is the photo it was
-- copied from, so the same sticker isn't saved twice. A sticker message is a chat message with
-- one photo and messages.meta.sticker = true.
CREATE TABLE stickers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id      uuid NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  from_media_id uuid REFERENCES media(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, media_id)
);
CREATE INDEX stickers_owner_idx ON stickers (owner_id, created_at DESC);
CREATE UNIQUE INDEX stickers_owner_from_key ON stickers (owner_id, from_media_id) WHERE from_media_id IS NOT NULL;
