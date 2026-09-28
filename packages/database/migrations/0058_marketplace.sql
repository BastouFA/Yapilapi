-- Market: people selling and buying used and local things near them, person to person
-- (packages/shared/src/market.ts, apps/api/src/modules/market.ts). Separate from the creator shop
-- (products and orders): nothing is paid in the app, people meet and pay in person.
--
-- A listing's place is kept only as a point snapped to a grid about a kilometre across, and is never
-- sent to anyone: others get the area text and a distance rounded to whole kilometres. Talking about a
-- listing happens in a one-to-one chat that starts with a card for it; offers are cards in that chat.

CREATE TABLE market_listings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title               text NOT NULL,
  description         text NOT NULL DEFAULT '',
  category            text NOT NULL CHECK (category IN ('electronics', 'phones', 'computers', 'home', 'furniture', 'appliances', 'clothing', 'shoes_bags',
                        'beauty', 'baby_kids', 'toys_games', 'sports', 'books', 'music', 'vehicles', 'bikes', 'tools', 'garden', 'art_crafts', 'other')),
  condition           text NOT NULL CHECK (condition IN ('new', 'like_new', 'good', 'fair')),
  -- Hundredths of the currency (the seller's country's when it was listed); NULL is Free.
  price_cents         bigint CHECK (price_cents IS NULL OR price_cents > 0),
  currency            char(3) NOT NULL,
  -- Where to pick it up, as the seller wrote it ("Yaba, Lagos"), and the approximate point (snapped, never exact).
  area                text NOT NULL,
  approx_lat          double precision CHECK (approx_lat BETWEEN -90 AND 90),
  approx_lng          double precision CHECK (approx_lng BETWEEN -180 AND 180),
  -- The seller's country when it was listed: listings without a nearby search show to people in the same country first.
  country             char(2),
  delivery            text[] NOT NULL CHECK (cardinality(delivery) BETWEEN 1 AND 3 AND delivery <@ ARRAY['pickup', 'seller_delivers', 'shipping']),
  status              text NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'reserved', 'sold')),
  -- Reserved for, or sold to, someone who wrote to the seller about it (NULL: someone else, or nobody in particular).
  reserved_for        uuid REFERENCES users(id) ON DELETE SET NULL,
  sold_to             uuid REFERENCES users(id) ON DELETE SET NULL,
  sold_at             timestamptz,
  -- 30 days from publishing or renewing. A reminder goes 3 days before, and a note when it ends.
  expires_at          timestamptz NOT NULL,
  renewed_at          timestamptz,
  reminded_at         timestamptz,
  ended_notified_at   timestamptz,
  -- 'review' waits for a moderator before anyone else sees it (why: review_reason); 'restricted' and 'removed' after a decision.
  moderation_status   text NOT NULL DEFAULT 'normal' CHECK (moderation_status IN ('normal', 'review', 'restricted', 'removed')),
  review_reason       text CHECK (review_reason IN ('prohibited', 'duplicate', 'low_price', 'photos', 'text')),
  -- The words of the title and description, lower case and evenly spaced, hashed: to spot the same listing posted many times.
  fingerprint         text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  CHECK ((approx_lat IS NULL) = (approx_lng IS NULL)),
  CHECK (status <> 'sold' OR sold_at IS NOT NULL)
);
CREATE INDEX market_listings_seller_idx ON market_listings (seller_id, created_at DESC);
-- Browsing: live listings, newest first, by country, and by place (a box around the viewer is narrowed by distance).
CREATE INDEX market_listings_browse_idx ON market_listings (country, created_at DESC) WHERE deleted_at IS NULL AND moderation_status = 'normal' AND status <> 'sold';
CREATE INDEX market_listings_place_idx ON market_listings (approx_lat, approx_lng) WHERE deleted_at IS NULL AND moderation_status = 'normal' AND status <> 'sold';
CREATE INDEX market_listings_category_idx ON market_listings (category, currency, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX market_listings_expiry_idx ON market_listings (expires_at) WHERE deleted_at IS NULL AND status <> 'sold';
CREATE INDEX market_listings_fingerprint_idx ON market_listings (fingerprint, created_at DESC);

-- Up to 10 photos, in order: the seller's own uploads.
CREATE TABLE market_listing_photos (
  listing_id uuid NOT NULL REFERENCES market_listings(id) ON DELETE CASCADE,
  media_id   uuid NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  position   smallint NOT NULL CHECK (position BETWEEN 0 AND 9),
  alt_text   text,
  PRIMARY KEY (listing_id, position),
  UNIQUE (listing_id, media_id)
);
CREATE INDEX market_listing_photos_media_idx ON market_listing_photos (media_id);

CREATE TABLE market_saves (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id uuid NOT NULL REFERENCES market_listings(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, listing_id)
);

-- A buyer's one-to-one chat with the seller about a listing, and the card at its top.
CREATE TABLE market_chats (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id      uuid NOT NULL REFERENCES market_listings(id) ON DELETE CASCADE,
  buyer_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id      uuid REFERENCES messages(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (listing_id, buyer_id)
);
CREATE INDEX market_chats_conversation_idx ON market_chats (conversation_id);
CREATE INDEX market_chats_buyer_idx ON market_chats (buyer_id);

-- Offers and counter-offers, each a card in the chat. One pending offer per buyer per listing.
CREATE TABLE market_offers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id      uuid NOT NULL REFERENCES market_listings(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id      uuid UNIQUE REFERENCES messages(id) ON DELETE SET NULL,
  buyer_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seller_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  made_by         text NOT NULL CHECK (made_by IN ('buyer', 'seller')),
  amount_cents    bigint NOT NULL CHECK (amount_cents > 0),
  currency        char(3) NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'countered', 'withdrawn')),
  counter_of      uuid REFERENCES market_offers(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  responded_at    timestamptz
);
CREATE UNIQUE INDEX market_offers_one_pending ON market_offers (listing_id, buyer_id) WHERE status = 'pending';
CREATE INDEX market_offers_buyer_idx ON market_offers (buyer_id, created_at DESC);
CREATE INDEX market_offers_seller_idx ON market_offers (seller_id, created_at DESC);

-- After a sale to a buyer from a chat, the buyer and the seller can each rate the other once. The
-- listing's title is kept with the rating, so it still reads well after the listing is gone.
CREATE TABLE market_ratings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id    uuid REFERENCES market_listings(id) ON DELETE SET NULL,
  listing_title text NOT NULL,
  rater_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ratee_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rater_role    text NOT NULL CHECK (rater_role IN ('buyer', 'seller')),
  stars         smallint NOT NULL CHECK (stars BETWEEN 1 AND 5),
  body          text NOT NULL DEFAULT '',
  -- Held ones (the words may break the rules) show only to their writer until a moderator clears them.
  moderation_status text NOT NULL DEFAULT 'normal' CHECK (moderation_status IN ('normal', 'review', 'restricted', 'removed')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  UNIQUE (listing_id, rater_id)
);
CREATE INDEX market_ratings_ratee_idx ON market_ratings (ratee_id, created_at DESC);
CREATE INDEX market_ratings_rater_idx ON market_ratings (rater_id);

-- Listings can be reported (by anyone who can see them).
ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_target_type_check;
ALTER TABLE reports ADD CONSTRAINT reports_target_type_check
  CHECK (target_type IN ('user', 'post', 'comment', 'message', 'community', 'event', 'product', 'story', 'room', 'live', 'question', 'answer', 'drop', 'mix', 'together_item', 'listing'));

-- Profiles can show a Market tab (packages/shared/src/profile-style.ts PROFILE_TABS).
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_tabs_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_tabs_check CHECK (tabs IS NULL OR (cardinality(tabs) BETWEEN 1 AND 10));
