-- Go out together (docs/product/go-out-together.md), step 2 of "Your city, alive": "I'm free",
-- plans with friends (I'm in / Maybe / Can't), a group chat for each plan, polls in it (ordinary
-- chat polls) and a cost split that only keeps count: no money moves through YAPILAPI.

-- "I'm free": one row each, while it lasts. Seen by friends only (lib/plans.ts, freeFriends); it
-- ends by itself at `until` (reads skip ended ones; the job worker's minute sweep deletes them).
-- Nothing about where: only the words the person types.
CREATE TABLE free_now (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  note       text NOT NULL DEFAULT '' CHECK (char_length(note) <= 80),
  until      timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX free_now_until_idx ON free_now (until);

-- Plans already existed as a chat's structured activity (POST /v1/conversations/:id/plans, the AI's
-- suggestion people confirm). A Go out together plan is the same row with a time (`starts_at`), and
-- `conversation_id` is its own group chat, whose members follow the answers. `status` 'active' is
-- such a plan going ahead. The place is a place page, an event or a stash (by id, shown to each
-- viewer only when they can see it themselves) or words (`place_name`). `squad_id`: made for a squad.
ALTER TABLE plans
  ADD COLUMN starts_at    timestamptz,
  ADD COLUMN note         text NOT NULL DEFAULT '',
  ADD COLUMN place_kind   text CHECK (place_kind IN ('place', 'event', 'stash', 'text')),
  ADD COLUMN place_id     uuid,
  ADD COLUMN place_name   text,
  ADD COLUMN squad_id     uuid REFERENCES squads(id) ON DELETE SET NULL,
  ADD COLUMN updated_at   timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN cancelled_at timestamptz;
ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_status_check;
ALTER TABLE plans ADD CONSTRAINT plans_status_check CHECK (status IN ('draft', 'confirmed', 'active', 'cancelled'));
CREATE UNIQUE INDEX plans_go_conversation_idx ON plans (conversation_id) WHERE starts_at IS NOT NULL;
CREATE INDEX plans_go_created_by_idx ON plans (created_by, created_at DESC) WHERE starts_at IS NOT NULL;
CREATE TRIGGER plans_updated BEFORE UPDATE ON plans FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Who is in a plan and their answer. The maker is 'in'. 'pending' until they answer; 'in' and
-- 'maybe' are in its chat, 'cant' isn't (and can change their mind).
CREATE TABLE plan_people (
  plan_id     uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  answer      text NOT NULL DEFAULT 'pending' CHECK (answer IN ('pending', 'in', 'maybe', 'cant')),
  invited_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  invited_at  timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz,
  PRIMARY KEY (plan_id, user_id)
);
CREATE INDEX plan_people_user_idx ON plan_people (user_id, answer);

-- Cost split: what was paid, by whom, split equally between chosen people (`plan_expense_shares`,
-- the cents that don't divide go one each to the first ones). Amounts in cents, as everywhere.
CREATE TABLE plan_expenses (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id      uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  added_by     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  paid_by      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        text NOT NULL CHECK (char_length(title) <= 60),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  currency     text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX plan_expenses_plan_idx ON plan_expenses (plan_id, created_at);

CREATE TABLE plan_expense_shares (
  expense_id  uuid NOT NULL REFERENCES plan_expenses(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  share_cents bigint NOT NULL CHECK (share_cents >= 0),
  PRIMARY KEY (expense_id, user_id)
);
CREATE INDEX plan_expense_shares_user_idx ON plan_expense_shares (user_id);

-- "Paid back": `from_id` paid `to_id` back this much, marked by one of the two. Only a record.
CREATE TABLE plan_settlements (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id      uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  from_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  currency     text NOT NULL,
  marked_by    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (from_id <> to_id)
);
CREATE INDEX plan_settlements_plan_idx ON plan_settlements (plan_id, created_at);
