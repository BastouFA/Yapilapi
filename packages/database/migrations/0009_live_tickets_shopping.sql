-- Ticketed lives (a ticket product the host sells; playback only for ticket holders)
-- and live shopping (products the host pins during a live).

ALTER TABLE live_sessions ADD COLUMN ticket_product_id uuid REFERENCES products(id) ON DELETE SET NULL;

CREATE TABLE live_products (
  session_id uuid NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  pinned_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, product_id)
);
