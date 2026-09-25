-- 160: Business profiles: team roles (owner|admin|editor|support), invitations, followers, view counters,
-- bookable places/services, booking state machine, business posts.

ALTER TABLE businesses ALTER COLUMN owner_id DROP NOT NULL;
ALTER TABLE businesses DROP CONSTRAINT businesses_owner_id_fkey;
ALTER TABLE businesses ADD CONSTRAINT businesses_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE businesses
  ADD COLUMN legal_name       text CHECK (legal_name IS NULL OR length(legal_name) BETWEEN 2 AND 200),
  ADD COLUMN links            jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN hours            jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN timezone         text NOT NULL DEFAULT 'UTC',
  ADD COLUMN address          jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN booking_settings jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {slotMinutes, leadTimeMinutes, maxAdvanceDays, autoConfirm}
  ADD COLUMN logo_media_id    uuid REFERENCES media(id) ON DELETE SET NULL,
  ADD COLUMN cover_media_id   uuid REFERENCES media(id) ON DELETE SET NULL,
  ADD COLUMN follower_count   integer NOT NULL DEFAULT 0,
  ADD COLUMN verified_by      uuid REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE business_members DROP CONSTRAINT business_members_role_check;
UPDATE business_members SET role = 'admin' WHERE role = 'manager';
UPDATE business_members SET role = 'editor' WHERE role = 'staff';
ALTER TABLE business_members ADD CONSTRAINT business_members_role_check CHECK (role IN ('owner','admin','editor','support'));
ALTER TABLE business_members ALTER COLUMN role SET DEFAULT 'editor';
CREATE UNIQUE INDEX business_members_one_owner ON business_members (business_id) WHERE role = 'owner';

CREATE TABLE business_invitations (
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('admin','editor','support')),
  invited_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','revoked')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, user_id)
);
CREATE INDEX business_invitations_user_idx ON business_invitations (user_id, status);

CREATE TABLE business_followers (
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, user_id)
);
CREATE INDEX business_followers_user_idx ON business_followers (user_id, created_at DESC);

CREATE TABLE business_daily_views (
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  day         date NOT NULL,
  views       bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (business_id, day)
);

ALTER TABLE offers
  ADD COLUMN created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT offer_window CHECK (ends_at IS NULL OR ends_at > starts_at);
CREATE UNIQUE INDEX offers_code_unique ON offers (business_id, upper(code)) WHERE code IS NOT NULL AND status <> 'cancelled';
CREATE TRIGGER offers_updated BEFORE UPDATE ON offers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Bookings: 'declined' is a business decision on a request; who cancelled and why is recorded.
ALTER TABLE bookings DROP CONSTRAINT bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check CHECK (status IN ('requested','confirmed','declined','cancelled','completed','no_show'));
ALTER TABLE bookings
  ADD COLUMN business_id  uuid REFERENCES businesses(id) ON DELETE SET NULL,
  ADD COLUMN cancelled_by text CHECK (cancelled_by IS NULL OR cancelled_by IN ('customer','business','system')),
  ADD COLUMN reason       text CHECK (reason IS NULL OR length(reason) <= 500),
  ADD COLUMN decided_at   timestamptz;
CREATE INDEX bookings_business_idx ON bookings (business_id, starts_at DESC) WHERE business_id IS NOT NULL;
CREATE INDEX bookings_place_slot_idx ON bookings (place_id, starts_at, ends_at) WHERE status IN ('requested','confirmed');
CREATE INDEX bookings_product_slot_idx ON bookings (product_id, starts_at, ends_at) WHERE status IN ('requested','confirmed');

-- Posts written by a team member on behalf of a business.
ALTER TABLE posts ADD COLUMN business_id uuid REFERENCES businesses(id) ON DELETE SET NULL;
CREATE INDEX posts_business_idx ON posts (business_id, created_at DESC, id DESC) WHERE business_id IS NOT NULL AND deleted_at IS NULL;
