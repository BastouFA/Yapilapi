-- Drops: a seller announces a launch of some of their own products ahead of time. A drop is a
-- draft until published; then it waits for its start time ('scheduled'), when a job opens it and
-- tells everyone who asked to be reminded. It ends at its end time or when everything has sold,
-- or the seller cancels it. Products in a published drop are only sold through it: not before it
-- opens, and not after it ends (until they are put in another drop).

CREATE TABLE drops (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title          text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  description    text NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  -- One of the seller's own photos (a processed size); cover_media_id says which upload, so a
  -- moderation decision on that photo can take it down.
  cover_url      text,
  cover_media_id uuid REFERENCES media(id) ON DELETE SET NULL,
  cover_alt      text CHECK (char_length(cover_alt) <= 300),
  starts_at      timestamptz NOT NULL,
  ends_at        timestamptz CHECK (ends_at IS NULL OR ends_at > starts_at),
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'open', 'ended', 'cancelled')),
  end_reason     text CHECK (end_reason IN ('time', 'sold_out')),
  published_at   timestamptz,
  opened_at      timestamptz,
  ended_at       timestamptz,
  cancelled_at   timestamptz,
  -- Removed by a moderator: hidden from everyone.
  deleted_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX drops_seller_idx ON drops (seller_id, starts_at DESC);
CREATE INDEX drops_live_idx ON drops (starts_at) WHERE status IN ('scheduled', 'open');

-- The products in a drop. `taken` counts units in paid orders and units held for unpaid ones;
-- it is raised in the same statement that checks it against `quantity`, so two buyers can never
-- take the last one, and the CHECK makes overselling impossible whatever the code does.
CREATE TABLE drop_items (
  drop_id         uuid NOT NULL REFERENCES drops(id) ON DELETE CASCADE,
  product_id      uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  position        smallint NOT NULL DEFAULT 0,
  quantity        integer CHECK (quantity IS NULL OR quantity > 0),
  per_buyer_limit integer CHECK (per_buyer_limit IS NULL OR per_buyer_limit > 0),
  taken           integer NOT NULL DEFAULT 0 CHECK (taken >= 0 AND (quantity IS NULL OR taken <= quantity)),
  sold_out_at     timestamptz,
  PRIMARY KEY (drop_id, product_id)
);
CREATE INDEX drop_items_product_idx ON drop_items (product_id);

-- "Notify me": people waiting for a drop to open. A reminder list, never a payment. Only the
-- seller sees how many; nobody sees who.
CREATE TABLE drop_reminders (
  drop_id     uuid NOT NULL REFERENCES drops(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz,
  PRIMARY KEY (drop_id, user_id)
);
CREATE INDEX drop_reminders_user_idx ON drop_reminders (user_id, created_at DESC);

-- Units of a drop in each order. 'held' while the order waits for payment (until hold_until),
-- 'paid', or 'released' (payment failed, not paid in time, or refunded) when they went back.
CREATE TABLE drop_orders (
  order_id    uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  drop_id     uuid NOT NULL REFERENCES drops(id) ON DELETE CASCADE,
  buyer_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  quantity    integer NOT NULL CHECK (quantity > 0),
  status      text NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'paid', 'released')),
  hold_until  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (order_id, product_id)
);
CREATE INDEX drop_orders_buyer_idx ON drop_orders (drop_id, product_id, buyer_id) WHERE status <> 'released';
CREATE INDEX drop_orders_mine_idx ON drop_orders (buyer_id, created_at DESC);

-- Drops can be reported.
ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_target_type_check;
ALTER TABLE reports ADD CONSTRAINT reports_target_type_check
  CHECK (target_type IN ('user', 'post', 'comment', 'message', 'community', 'event', 'product', 'story', 'room', 'live', 'drop'));
