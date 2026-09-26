-- Fixes from the code review of the FAQ/ads/family/studio/live work.

-- The country a trusted CDN reports, kept separately from the one a person
-- chooses, so regional rules apply to both (choosing another country doesn't
-- lift a rule that applies where you are).
ALTER TABLE profiles ADD COLUMN cdn_country char(2) CHECK (cdn_country ~ '^[A-Z]{2}$');
UPDATE profiles SET cdn_country = country WHERE country_source = 'cdn';

-- A ticket is bought for one live, not for every live that reuses the product.
ALTER TABLE orders ADD COLUMN live_session_id uuid REFERENCES live_sessions(id) ON DELETE SET NULL;
CREATE INDEX orders_live_ticket_idx ON orders (live_session_id, buyer_id) WHERE live_session_id IS NOT NULL AND status = 'paid';

-- Unspent ad budget handed back when a campaign is rejected or ended.
ALTER TABLE ad_campaigns ADD COLUMN refunded_millicents bigint NOT NULL DEFAULT 0 CHECK (refunded_millicents >= 0);
