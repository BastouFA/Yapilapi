-- 232: Affiliate commission is paid out of the SELLER's revenue, so the seller must opt in: a product offers affiliates at most
-- `affiliate_max_bps` (0 = not offered). Creators cannot create a link above it. Also records who authored the current partnership terms.
ALTER TABLE products ADD COLUMN affiliate_max_bps integer NOT NULL DEFAULT 0 CHECK (affiliate_max_bps BETWEEN 0 AND 5000);
ALTER TABLE brand_partnerships ADD COLUMN terms_by text NOT NULL DEFAULT 'business' CHECK (terms_by IN ('creator','business'));
