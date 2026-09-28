-- When an order was paid. A sale's earnings are held for EARNINGS_HOLD_DAYS (packages/shared/src/constants.ts)
-- before they can be paid out, so a refund or chargeback in the first days comes out of money still here
-- rather than money already sent to the seller. Orders paid before this column existed count from their
-- last update, which for a paid order is when it was paid.
ALTER TABLE orders ADD COLUMN paid_at timestamptz;
UPDATE orders SET paid_at = updated_at WHERE status = 'paid';
