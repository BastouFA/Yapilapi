-- What taking each payment cost (the provider's charge, estimated from PROCESSING_FEES in
-- packages/shared/src/constants.ts when the order is made). Creators and sellers pay it on top of the
-- platform fee, so earnings are total - platform_fee_cents - processing_fee_cents. Orders from before
-- this column were sold under terms without it and keep 0.
ALTER TABLE orders ADD COLUMN processing_fee_cents integer NOT NULL DEFAULT 0 CHECK (processing_fee_cents >= 0);
