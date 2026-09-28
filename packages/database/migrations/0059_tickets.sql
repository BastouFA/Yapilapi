-- Event tickets people carry in the app, and check-in at the door.
--
-- Every "going" RSVP and every ticket in a paid order for an event has a row in event_tickets. Its
-- QR code holds a token the server signs (HMAC with TICKET_TOKEN_SECRET) over the ticket id and
-- token_nonce; changing the nonce (a transfer, a refund, an RSVP taken back) makes every earlier
-- copy stop working. The 6-character backup code is unique within its event and changes on a
-- transfer. Hosts and the co-hosts they choose see the guest list and check people in; every scan,
-- typed code and undo is kept in ticket_scans for 90 days (the door's log, and how failed attempts
-- are limited). Tickets go a year after their event ended.

ALTER TABLE events ADD COLUMN ticket_transfers boolean NOT NULL DEFAULT true;

CREATE TABLE event_cohosts (
  event_id   uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX event_cohosts_user_idx ON event_cohosts (user_id);

CREATE TABLE event_tickets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  holder_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source         text NOT NULL CHECK (source IN ('rsvp', 'order')),
  -- A bought ticket: the order, the ticket product and which of the quantity it is.
  order_id       uuid REFERENCES orders(id) ON DELETE SET NULL,
  product_id     uuid REFERENCES products(id) ON DELETE SET NULL,
  seq            integer NOT NULL DEFAULT 1 CHECK (seq > 0),
  -- The product's name when it was bought (null for an RSVP).
  type_title     text,
  status         text NOT NULL DEFAULT 'valid' CHECK (status IN ('valid', 'cancelled', 'refunded')),
  token_nonce    integer NOT NULL,
  backup_code    text NOT NULL CHECK (backup_code ~ '^[A-HJ-NP-Z2-9]{6}$'),
  checked_in_at  timestamptz,
  checked_in_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  -- The device's own id for a check-in it kept while offline: the same one sent again isn't a conflict.
  check_in_ref   text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX event_tickets_code_idx ON event_tickets (event_id, backup_code);
CREATE UNIQUE INDEX event_tickets_rsvp_idx ON event_tickets (event_id, holder_id) WHERE source = 'rsvp';
CREATE UNIQUE INDEX event_tickets_order_idx ON event_tickets (order_id, product_id, seq) WHERE order_id IS NOT NULL;
CREATE INDEX event_tickets_holder_idx ON event_tickets (holder_id);
CREATE INDEX event_tickets_event_idx ON event_tickets (event_id, status);

-- Tickets given to a friend: who gave it to whom, and when.
CREATE TABLE ticket_transfers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id  uuid NOT NULL REFERENCES event_tickets(id) ON DELETE CASCADE,
  from_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  to_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ticket_transfers_ticket_idx ON ticket_transfers (ticket_id, created_at DESC);
CREATE INDEX ticket_transfers_from_idx ON ticket_transfers (from_id);
CREATE INDEX ticket_transfers_to_idx ON ticket_transfers (to_id);

-- The door's log: each scan, typed code, pick from the guest list and undo, with what it found.
CREATE TABLE ticket_scans (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  scanner_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ticket_id  uuid REFERENCES event_tickets(id) ON DELETE SET NULL,
  method     text NOT NULL CHECK (method IN ('qr', 'code', 'list', 'undo')),
  result     text NOT NULL CHECK (result IN ('valid', 'already', 'wrong_event', 'cancelled', 'refunded', 'invalid', 'undone')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ticket_scans_event_idx ON ticket_scans (event_id, created_at DESC);
-- Failed attempts per person, for the limit on guessing codes.
CREATE INDEX ticket_scans_failed_idx ON ticket_scans (scanner_id, created_at) WHERE result IN ('invalid', 'wrong_event');
CREATE INDEX ticket_scans_created_idx ON ticket_scans (created_at);
