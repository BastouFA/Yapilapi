-- 004: Businesses, places, events, products/services, bookings, orders, reviews, offers.

-- ---------------------------------------------------------------- businesses
CREATE TABLE businesses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  slug          citext NOT NULL,
  name          text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  category      text NOT NULL DEFAULT 'general',
  description   text NOT NULL DEFAULT '',
  logo_url      text,
  cover_url     text,
  contact       jsonb NOT NULL DEFAULT '{}'::jsonb,       -- {email, phone, website}
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('pending','active','suspended','closed')),
  verified_at   timestamptz,
  ai_assistant_enabled boolean NOT NULL DEFAULT false,
  -- Knowledge the business AI is allowed to use. Nothing outside this column/these rows is ever retrieved.
  ai_knowledge  jsonb NOT NULL DEFAULT '[]'::jsonb,
  search_tsv    tsvector GENERATED ALWAYS AS (
                  to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(category,'') || ' ' || coalesce(description,''))
                ) STORED,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  CONSTRAINT business_slug_format CHECK (slug::text ~ '^[a-z0-9-]{3,50}$')
);
CREATE UNIQUE INDEX businesses_slug_unique ON businesses (slug) WHERE deleted_at IS NULL;
CREATE INDEX businesses_search_idx ON businesses USING gin (search_tsv);
CREATE INDEX businesses_owner_idx ON businesses (owner_id);
CREATE TRIGGER businesses_updated BEFORE UPDATE ON businesses FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE business_members (
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'staff' CHECK (role IN ('owner','manager','staff')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, user_id)
);
CREATE INDEX business_members_user_idx ON business_members (user_id);

-- ---------------------------------------------------------------- places
CREATE TABLE places (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL CHECK (length(name) BETWEEN 2 AND 160),
  kind          text NOT NULL CHECK (kind IN ('restaurant','store','venue','attraction','service')),
  description   text NOT NULL DEFAULT '',
  latitude      double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude     double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  address       jsonb NOT NULL DEFAULT '{}'::jsonb,       -- {line1, city, region, postal_code, country}
  hours         jsonb NOT NULL DEFAULT '{}'::jsonb,       -- {mon:[["09:00","17:00"]], ...}
  phone         text,
  website       text,
  capacity      integer CHECK (capacity IS NULL OR capacity > 0),
  business_id   uuid REFERENCES businesses(id) ON DELETE SET NULL,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  rating_avg    numeric(3,2) NOT NULL DEFAULT 0,
  rating_count  integer NOT NULL DEFAULT 0,
  search_tsv    tsvector GENERATED ALWAYS AS (
                  to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(kind,'') || ' ' || coalesce(description,'') || ' ' || coalesce(address->>'city',''))
                ) STORED,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE INDEX places_search_idx ON places USING gin (search_tsv);
CREATE INDEX places_kind_idx ON places (kind) WHERE deleted_at IS NULL;
CREATE INDEX places_geo_idx ON places (latitude, longitude) WHERE deleted_at IS NULL;
CREATE INDEX places_business_idx ON places (business_id) WHERE business_id IS NOT NULL;
CREATE INDEX places_name_trgm_idx ON places USING gin (name gin_trgm_ops);
CREATE TRIGGER places_updated BEFORE UPDATE ON places FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE place_media (
  place_id  uuid NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  media_id  uuid NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  position  smallint NOT NULL DEFAULT 0,
  PRIMARY KEY (place_id, media_id)
);

-- ---------------------------------------------------------------- events
CREATE TABLE events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title         text NOT NULL CHECK (length(title) BETWEEN 2 AND 160),
  description   text NOT NULL DEFAULT '' CHECK (length(description) <= 10000),
  host_id       uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  host_business_id uuid REFERENCES businesses(id) ON DELETE SET NULL,
  community_id  uuid REFERENCES communities(id) ON DELETE SET NULL,
  place_id      uuid REFERENCES places(id) ON DELETE SET NULL,
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz,
  timezone      text NOT NULL DEFAULT 'UTC',
  location_text text,
  latitude      double precision,
  longitude     double precision,
  online_url    text,
  capacity      integer CHECK (capacity IS NULL OR capacity > 0),
  visibility    text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','community','friends','private')),
  status        text NOT NULL DEFAULT 'published' CHECK (status IN ('draft','published','cancelled','ended')),
  rules         text NOT NULL DEFAULT '',
  cover_url     text,
  going_count   integer NOT NULL DEFAULT 0,
  interested_count integer NOT NULL DEFAULT 0,
  search_tsv    tsvector GENERATED ALWAYS AS (
                  to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(description,'') || ' ' || coalesce(location_text,''))
                ) STORED,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  CONSTRAINT event_end_after_start CHECK (ends_at IS NULL OR ends_at >= starts_at),
  CONSTRAINT event_lat_lng_pair CHECK ((latitude IS NULL) = (longitude IS NULL)),
  CONSTRAINT event_community_visibility CHECK (visibility <> 'community' OR community_id IS NOT NULL)
);
CREATE INDEX events_starts_idx ON events (starts_at) WHERE deleted_at IS NULL AND status = 'published';
CREATE INDEX events_host_idx ON events (host_id);
CREATE INDEX events_community_idx ON events (community_id) WHERE community_id IS NOT NULL;
CREATE INDEX events_place_idx ON events (place_id) WHERE place_id IS NOT NULL;
CREATE INDEX events_search_idx ON events USING gin (search_tsv);
CREATE TRIGGER events_updated BEFORE UPDATE ON events FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE event_ticket_types (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name          text NOT NULL,
  price_cents   integer NOT NULL CHECK (price_cents >= 0),
  currency      text NOT NULL CHECK (length(currency) = 3),
  quantity      integer NOT NULL CHECK (quantity >= 0),
  sold          integer NOT NULL DEFAULT 0 CHECK (sold >= 0),
  sales_start   timestamptz,
  sales_end     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tickets_not_oversold CHECK (sold <= quantity)
);
CREATE INDEX event_ticket_types_event_idx ON event_ticket_types (event_id);

CREATE TABLE event_attendees (
  event_id      uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status        text NOT NULL CHECK (status IN ('interested','going','waitlist','cancelled','attended')),
  checked_in_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX event_attendees_user_idx ON event_attendees (user_id, status);
CREATE TRIGGER event_attendees_updated BEFORE UPDATE ON event_attendees FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------- products / services
CREATE TABLE products (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid REFERENCES businesses(id) ON DELETE CASCADE,
  seller_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('physical','service','digital','ticket','booking')),
  title         text NOT NULL CHECK (length(title) BETWEEN 2 AND 160),
  description   text NOT NULL DEFAULT '' CHECK (length(description) <= 10000),
  price_cents   integer NOT NULL CHECK (price_cents >= 0),
  currency      text NOT NULL CHECK (length(currency) = 3),
  stock         integer CHECK (stock IS NULL OR stock >= 0),     -- NULL = unlimited (services, digital)
  delivery      jsonb NOT NULL DEFAULT '{}'::jsonb,               -- {methods:[...], estimate_days, shipping_cents}
  returns_policy text NOT NULL DEFAULT '',
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','sold_out','archived')),
  rating_avg    numeric(3,2) NOT NULL DEFAULT 0,
  rating_count  integer NOT NULL DEFAULT 0,
  search_tsv    tsvector GENERATED ALWAYS AS (
                  to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(description,''))
                ) STORED,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  CONSTRAINT product_has_exactly_one_seller CHECK ((business_id IS NULL) <> (seller_user_id IS NULL))
);
CREATE INDEX products_business_idx ON products (business_id) WHERE deleted_at IS NULL;
CREATE INDEX products_seller_user_idx ON products (seller_user_id) WHERE seller_user_id IS NOT NULL;
CREATE INDEX products_search_idx ON products USING gin (search_tsv);
CREATE INDEX products_status_idx ON products (status) WHERE deleted_at IS NULL;
CREATE TRIGGER products_updated BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE product_media (
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  media_id   uuid NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  position   smallint NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, media_id)
);
-- Files delivered after purchase (digital products). Never exposed through public product reads.
CREATE TABLE product_files (
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  media_id   uuid NOT NULL REFERENCES media(id) ON DELETE RESTRICT,
  PRIMARY KEY (product_id, media_id)
);

CREATE TABLE offers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  title         text NOT NULL,
  description   text NOT NULL DEFAULT '',
  code          text,
  discount_bps  integer CHECK (discount_bps IS NULL OR discount_bps BETWEEN 1 AND 10000),
  starts_at     timestamptz NOT NULL DEFAULT now(),
  ends_at       timestamptz,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','expired','cancelled')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX offers_business_idx ON offers (business_id, status);

CREATE TABLE reviews (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type text NOT NULL CHECK (target_type IN ('place','product','business')),
  target_id   uuid NOT NULL,
  rating      smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body        text NOT NULL DEFAULT '' CHECK (length(body) <= 4000),
  verified_purchase boolean NOT NULL DEFAULT false,
  moderation_status text NOT NULL DEFAULT 'approved'
              CHECK (moderation_status IN ('approved','pending_review','restricted','removed','escalated')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  UNIQUE (author_id, target_type, target_id)
);
CREATE INDEX reviews_target_idx ON reviews (target_type, target_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE TRIGGER reviews_updated BEFORE UPDATE ON reviews FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------- orders / bookings / tickets
CREATE TABLE orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id         uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  seller_business_id uuid REFERENCES businesses(id) ON DELETE RESTRICT,
  seller_user_id   uuid REFERENCES users(id) ON DELETE RESTRICT,
  status           text NOT NULL DEFAULT 'pending_payment'
                   CHECK (status IN ('pending_payment','paid','fulfilled','cancelled','refunded','partially_refunded','under_review')),
  currency         text NOT NULL CHECK (length(currency) = 3),
  subtotal_cents   bigint NOT NULL CHECK (subtotal_cents >= 0),
  shipping_cents   bigint NOT NULL DEFAULT 0 CHECK (shipping_cents >= 0),
  platform_fee_cents bigint NOT NULL DEFAULT 0 CHECK (platform_fee_cents >= 0),
  total_cents      bigint NOT NULL CHECK (total_cents >= 0),
  idempotency_key  text NOT NULL,
  shipping_address jsonb,
  fraud_score      integer NOT NULL DEFAULT 0,
  fraud_flags      text[] NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_has_exactly_one_seller CHECK ((seller_business_id IS NULL) <> (seller_user_id IS NULL)),
  CONSTRAINT order_total_consistent CHECK (total_cents = subtotal_cents + shipping_cents),
  UNIQUE (buyer_id, idempotency_key)
);
CREATE INDEX orders_buyer_idx ON orders (buyer_id, created_at DESC);
CREATE INDEX orders_seller_business_idx ON orders (seller_business_id, created_at DESC) WHERE seller_business_id IS NOT NULL;
CREATE INDEX orders_status_idx ON orders (status);
CREATE TRIGGER orders_updated BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE order_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_type       text NOT NULL CHECK (item_type IN ('product','ticket','booking')),
  product_id      uuid REFERENCES products(id) ON DELETE RESTRICT,
  ticket_type_id  uuid REFERENCES event_ticket_types(id) ON DELETE RESTRICT,
  title_snapshot  text NOT NULL,
  quantity        integer NOT NULL CHECK (quantity > 0 AND quantity <= 100),
  unit_price_cents bigint NOT NULL CHECK (unit_price_cents >= 0),
  CONSTRAINT order_item_target CHECK (
    (item_type = 'ticket' AND ticket_type_id IS NOT NULL) OR
    (item_type IN ('product','booking') AND product_id IS NOT NULL)
  )
);
CREATE INDEX order_items_order_idx ON order_items (order_id);

CREATE TABLE bookings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  uuid REFERENCES products(id) ON DELETE SET NULL,
  place_id    uuid REFERENCES places(id) ON DELETE SET NULL,
  customer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id    uuid REFERENCES orders(id) ON DELETE SET NULL,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  party_size  integer NOT NULL DEFAULT 1 CHECK (party_size BETWEEN 1 AND 500),
  status      text NOT NULL DEFAULT 'requested'
              CHECK (status IN ('requested','confirmed','cancelled','completed','no_show')),
  notes       text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT booking_window CHECK (ends_at > starts_at),
  CONSTRAINT booking_has_target CHECK (product_id IS NOT NULL OR place_id IS NOT NULL)
);
CREATE INDEX bookings_customer_idx ON bookings (customer_id, starts_at DESC);
CREATE INDEX bookings_product_idx ON bookings (product_id, starts_at);
CREATE TRIGGER bookings_updated BEFORE UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE tickets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_type_id uuid NOT NULL REFERENCES event_ticket_types(id) ON DELETE RESTRICT,
  event_id       uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  order_item_id  uuid NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  owner_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code           text NOT NULL UNIQUE,
  status         text NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','used','refunded','cancelled')),
  checked_in_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tickets_owner_idx ON tickets (owner_id);
CREATE INDEX tickets_event_idx ON tickets (event_id);

-- ---------------------------------------------------------------- foreign keys deferred from earlier migrations
ALTER TABLE posts ADD CONSTRAINT posts_community_fk FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE SET NULL;
ALTER TABLE posts ADD CONSTRAINT posts_event_fk     FOREIGN KEY (event_id)     REFERENCES events(id)      ON DELETE SET NULL;
ALTER TABLE posts ADD CONSTRAINT posts_product_fk   FOREIGN KEY (product_id)   REFERENCES products(id)    ON DELETE SET NULL;
ALTER TABLE posts ADD CONSTRAINT posts_place_fk     FOREIGN KEY (place_id)     REFERENCES places(id)      ON DELETE SET NULL;
ALTER TABLE moments ADD CONSTRAINT moments_place_fk FOREIGN KEY (place_id)     REFERENCES places(id)      ON DELETE SET NULL;
ALTER TABLE shared_experiences ADD CONSTRAINT shared_experiences_event_fk FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE SET NULL;
ALTER TABLE shared_experiences ADD CONSTRAINT shared_experiences_place_fk FOREIGN KEY (place_id) REFERENCES places(id) ON DELETE SET NULL;
