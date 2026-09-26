-- Money: subscriber-only posts and reels, digital downloads and service
-- bookings sold from profiles, post boosts, and payment providers chosen by
-- currency (Paystack for NGN, GHS, KES and ZAR).

-- ─── Subscriber-only posts ─────────────────────────────────────────────
-- 'subscribers': anyone who could see a public post sees a locked card; the
-- author and people with a paid, current subscription see the content.
ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_visibility_check;
ALTER TABLE posts ADD CONSTRAINT posts_visibility_check
  CHECK (visibility IN ('public', 'followers', 'friends', 'circle', 'selected', 'private', 'subscribers'));
-- Access checks look up (subscriber, creator) for current periods, including cancelled ones that haven't run out.
CREATE INDEX creator_subscriptions_access_idx ON creator_subscriptions (subscriber_id, creator_id, current_period_end)
  WHERE status IN ('active', 'cancelled');

-- ─── Digital products ──────────────────────────────────────────────────
-- The file a buyer downloads. Stored outside the public media paths; served
-- only through a short-lived download link to people who paid for it.
CREATE TABLE product_files (
  product_id  uuid PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  storage_key text NOT NULL,
  filename    text NOT NULL CHECK (length(filename) BETWEEN 1 AND 200),
  mime        text NOT NULL,
  size_bytes  bigint NOT NULL CHECK (size_bytes > 0),
  uploaded_at timestamptz NOT NULL DEFAULT now()
);

-- One row per download link. Only the SHA-256 of the token is stored.
CREATE TABLE download_links (
  token_hash text PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX download_links_expiry_idx ON download_links (expires_at);

-- ─── Service bookings ──────────────────────────────────────────────────
-- Bookings were for places only. A booking can now be for a service a
-- seller lists on their profile, paid through checkout: it waits for the
-- payment, then for the seller to confirm or decline (declining refunds).
ALTER TABLE bookings ALTER COLUMN place_id DROP NOT NULL;
ALTER TABLE bookings ADD COLUMN product_id uuid REFERENCES products(id) ON DELETE CASCADE;
ALTER TABLE bookings ADD COLUMN order_id uuid REFERENCES orders(id) ON DELETE SET NULL;
ALTER TABLE bookings ADD CONSTRAINT bookings_target_check CHECK ((place_id IS NULL) <> (product_id IS NULL));
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
  CHECK (status IN ('pending_payment', 'requested', 'confirmed', 'declined', 'cancelled'));
CREATE INDEX bookings_product_idx ON bookings (product_id, starts_at) WHERE product_id IS NOT NULL;
CREATE INDEX bookings_order_idx ON bookings (order_id) WHERE order_id IS NOT NULL;

-- ─── Boosts ────────────────────────────────────────────────────────────
-- A boost is an ad campaign for one of your posts, started from the post:
-- a budget, a number of days (counted from approval) and an audience by
-- country or interests.
ALTER TABLE ad_campaigns ADD COLUMN countries text[] NOT NULL DEFAULT '{}';
ALTER TABLE ad_campaigns ADD COLUMN boost_days smallint CHECK (boost_days BETWEEN 1 AND 30);
-- Local currencies have much larger numbers per impression than USD.
ALTER TABLE ad_campaigns DROP CONSTRAINT IF EXISTS ad_campaigns_cpm_cents_check;
ALTER TABLE ad_campaigns ADD CONSTRAINT ad_campaigns_cpm_cents_check CHECK (cpm_cents BETWEEN 1 AND 10000000);
CREATE INDEX ad_campaigns_post_idx ON ad_campaigns (post_id);

-- ─── Payments ──────────────────────────────────────────────────────────
-- Refunds and reconciliation look payments up by order.
CREATE INDEX IF NOT EXISTS payments_order_idx ON payments (order_id);
CREATE INDEX IF NOT EXISTS order_items_product_idx ON order_items (product_id);
