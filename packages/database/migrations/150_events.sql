-- 150: Events as a first-class entity: organisers, invitations, topics, ticket grants, waitlist, check-in codes, reminders.
-- Builds on 004 (events, event_ticket_types, event_attendees). Statuses: draft -> published -> cancelled | completed.

-- Account deletion must never be blocked by an event: the host reference is cleared (the deletion hook cancels or hands over first).
ALTER TABLE events ALTER COLUMN host_id DROP NOT NULL;
ALTER TABLE events DROP CONSTRAINT events_host_id_fkey;
ALTER TABLE events ADD CONSTRAINT events_host_id_fkey FOREIGN KEY (host_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE events DROP CONSTRAINT events_visibility_check;
ALTER TABLE events ADD CONSTRAINT events_visibility_check CHECK (visibility IN ('public','followers','friends','community','private'));

ALTER TABLE events DROP CONSTRAINT events_status_check;
UPDATE events SET status = 'completed' WHERE status = 'ended';
ALTER TABLE events ADD CONSTRAINT events_status_check CHECK (status IN ('draft','published','cancelled','completed'));

ALTER TABLE events
  ADD COLUMN published_at   timestamptz,
  ADD COLUMN cancelled_at   timestamptz,
  ADD COLUMN cancel_reason  text,
  ADD COLUMN completed_at   timestamptz,
  ADD COLUMN cover_media_id uuid REFERENCES media(id) ON DELETE SET NULL,
  ADD COLUMN waitlist_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE events ALTER COLUMN status SET DEFAULT 'draft';
CREATE INDEX events_geo_idx ON events (latitude, longitude) WHERE deleted_at IS NULL AND status = 'published' AND latitude IS NOT NULL;
CREATE INDEX events_business_idx ON events (host_business_id, starts_at) WHERE host_business_id IS NOT NULL;
CREATE INDEX events_status_start_idx ON events (status, starts_at) WHERE deleted_at IS NULL;

-- Co-hosts. The host is events.host_id; community managers (manage_events) and business team members are organisers implicitly.
CREATE TABLE event_organizers (
  event_id   uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL DEFAULT 'co_host' CHECK (role IN ('co_host')),
  added_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX event_organizers_user_idx ON event_organizers (user_id);

CREATE TABLE event_invitations (
  event_id   uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_by uuid REFERENCES users(id) ON DELETE SET NULL,
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX event_invitations_user_idx ON event_invitations (user_id, status);

CREATE TABLE event_topics (
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  topic_id uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, topic_id)
);
CREATE INDEX event_topics_topic_idx ON event_topics (topic_id);

ALTER TABLE event_ticket_types
  ADD COLUMN description  text NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  ADD COLUMN max_per_user integer NOT NULL DEFAULT 1 CHECK (max_per_user BETWEEN 1 AND 20),
  ADD COLUMN position     smallint NOT NULL DEFAULT 0,
  ADD COLUMN archived_at  timestamptz,
  ADD COLUMN updated_at   timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT ticket_sales_window CHECK (sales_start IS NULL OR sales_end IS NULL OR sales_end > sales_start);
CREATE TRIGGER event_ticket_types_updated BEFORE UPDATE ON event_ticket_types FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- attendee row per (event, user); `spots` is the head-count the row occupies (ticket quantity), `waitlisted_at` orders promotion (FIFO).
ALTER TABLE event_attendees
  ADD COLUMN spots         integer NOT NULL DEFAULT 1 CHECK (spots BETWEEN 1 AND 100),
  ADD COLUMN waitlisted_at timestamptz,
  ADD COLUMN checkin_code  text,
  ADD COLUMN waitlist_ticket_type_id uuid REFERENCES event_ticket_types(id) ON DELETE SET NULL,
  ADD COLUMN checked_in_by uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX event_attendees_checkin_code_unique ON event_attendees (checkin_code) WHERE checkin_code IS NOT NULL;
CREATE INDEX event_attendees_event_status_idx ON event_attendees (event_id, status, created_at, user_id);
CREATE INDEX event_attendees_waitlist_idx ON event_attendees (event_id, waitlisted_at, user_id) WHERE status = 'waitlist';

-- One row per ticket purchase (order) or free RSVP. `sold` on the ticket type always equals the sum of active grants.
-- Commerce calls attendEventWithTicket(...) after payment; the (order, ticket type, user) key makes that idempotent.
CREATE TABLE event_ticket_grants (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ticket_type_id uuid NOT NULL REFERENCES event_ticket_types(id) ON DELETE RESTRICT,
  order_id       uuid REFERENCES orders(id) ON DELETE RESTRICT,
  quantity       integer NOT NULL CHECK (quantity BETWEEN 1 AND 100),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','released')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  released_at    timestamptz
);
CREATE UNIQUE INDEX event_ticket_grants_order_unique ON event_ticket_grants (order_id, ticket_type_id, user_id) WHERE order_id IS NOT NULL;
CREATE UNIQUE INDEX event_ticket_grants_free_unique ON event_ticket_grants (event_id, user_id) WHERE order_id IS NULL AND status = 'active';
CREATE INDEX event_ticket_grants_user_idx ON event_ticket_grants (event_id, user_id, status);
CREATE INDEX event_ticket_grants_type_idx ON event_ticket_grants (ticket_type_id, status);

-- Reminder ledger: the primary key makes reminder delivery idempotent across job runs and concurrent workers.
CREATE TABLE event_reminders (
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind     text NOT NULL CHECK (kind IN ('24h','1h')),
  sent_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id, kind)
);
