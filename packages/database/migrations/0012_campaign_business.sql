-- A campaign can be run for one of the advertiser's businesses, so that
-- business's insights show its own ads.
ALTER TABLE ad_campaigns ADD COLUMN business_id uuid REFERENCES businesses(id) ON DELETE SET NULL;
CREATE INDEX ad_campaigns_business_idx ON ad_campaigns (business_id) WHERE business_id IS NOT NULL;
