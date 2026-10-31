# Go out together

Step 2 of "Your city, alive" (docs/product/your-city-alive.md), approved by the owner: making plans
with your people around what Wander shows. **I'm free**, **plans**, **I'm in / Maybe / Can't**, an
**automatic group chat** for each plan, **polls** in it, and a **cost split** that only keeps count:
no money moves through YAPILAPI.

Behind the `GO_OUT` flag (on by default). Migration `packages/database/migrations/0096_go_out_together.sql`.
Code: `packages/shared/src/plans.ts` (types, rules, the split and debt maths, notification words; no
zod, for the phone), `packages/shared/src/plan-schemas.ts`, `apps/api/src/lib/plans.ts`,
`apps/api/src/modules/plans.ts`. Web: `/plans`, `/plans/new`, `/plans/[id]`
(`apps/web/components/Plans.tsx`, `apps/web/app/plans.css`). Phone: `app/go/index.tsx`,
`app/go/new.tsx`, `app/go/[id].tsx` (`lib/plans.tsx`; the phone's `plans` screen is a creator's paid
plans, so the phone uses `go`). Tests: `apps/api/test/plans.test.ts`, `packages/shared/src/plans.test.ts`,
`apps/web/e2e/plans.spec.ts`.

## What it reuses

| Already there | How Go out together uses it |
| --- | --- |
| `plans` (migration 0001): a chat's structured activity (`POST /v1/conversations/:id/plans`, the AI suggests, people confirm), with a chat, a maker, a title and a status | A Go out together plan is a row of the same table with a time (`starts_at`), place, details and squad; `conversation_id` is its own group chat. Rows without a time are the older chat plans and work as before. |
| Group conversations and their lines (`modules/messaging.ts`, `lib/squads.ts` `chatLine`) | The plan's chat is an ordinary group: in the inbox, in the Yap app, with "Ada added Bola" / "Bola left" lines. `Conversation.planId` puts the plan's card at its top. |
| The squad chat rule (`squad_chat`) | The same for plans (`plan_chat`): while the plan is on, the chat's own add, remove, rename and leave are refused; who is in it follows the answers. |
| Group safety (`lib/squads.ts` `clashWith`, the group-chat minor rule, family settings) | Checked for every invite and again when someone joins the chat. |
| Chat polls (`modules/chat-polls-lists.ts`) | "Vote on a time or place" opens the plan's chat with a new poll (`?poll=1`). Nothing new on the server. |
| Squads | "Or invite a squad": its members are invited. |
| Wander's what's on now (`components/CityNow.tsx`, `lib/city-now.tsx`) and its map targets | "Go with friends" next to a place, event or stash opens a new plan with it as the place. |
| `notify()` | Categories, pauses, mutes, blocks, quiet hours and a supervised teen's quiet hours, as for every notification. |
| The Now status (`profile_statuses`, `NowStatusLine`) | Not reused for I'm free: a Now status is a public or followers line that replaces itself; I'm free is for friends only, ends at a time you choose and shouldn't overwrite your status. Its own small table (`free_now`). |
| Events with RSVP (`events.ts`) | An event can be a plan's place. Going to the event is still its RSVP; the plan is your group going together. |

## Rules

**I'm free.** "I'm free" with a few words (80 characters, optional, "Up for food in Yaba") and **Now**
(the next two hours) or **Tonight** (until midnight where you are). It can last 15 minutes to 18 hours
and ends by itself (reads skip ended ones; the job worker's minute sweep deletes them). Only
**friends** see it (the friendship table, so both ways), active accounts, nobody blocked either way.
A supervised teen whose family settings allow messages from nobody isn't shown, and sees nobody,
except their guardians. Nothing about where anyone is: only the words they type. 30 changes an hour.
"Who's free" is on Wander (under what's on now) and at the top of Chats, on the web and the phone.
Each friend in it opens a new plan with them invited.

**Making a plan.** A title (80), a time (from now to 90 days ahead), optionally a place and details
(300). The place is a place page, an event or a stash from Wander (the maker must be able to see it),
or words (80). Invite **friends** (anyone else is refused, `plan_invite_not_allowed`) and/or a
**squad** you're in (its members are invited, leaving out anyone who couldn't be in the chat with the
others). Up to 30 people, the maker included; 20 plans a day each, 20 an hour. Words are checked like a
message (words that put someone at risk are refused). The maker is "I'm in".

**Who can be in a plan together.** Everyone in a plan may end up in one group chat, so the group
rules apply between each pair (the squad check, `clashWith`): no block either way
(`blocked_in_group`); an adult and someone under 18 only when they are friends or family-linked
(`minor_protection`); a supervised teen's family settings for messages, both ways
(`family_controls`). The whole invite is refused with the first reason. Answering I'm in or Maybe is
checked again against who is in the chat then ("You can't join this plan now").

**Answers.** I'm in, Maybe or Can't; you can change your mind until the plan is cancelled. The maker
is always in (they cancel instead). The maker hears, batched per plan while unread ("Ada is in: Suya
and a film", "Ada and 2 others answered: …").

**The chat.** Made with the plan, named after it. **The maker and everyone who said I'm in or Maybe
are in it**; people invited who haven't answered aren't yet (they see the plan and answer first), and
answering Can't takes you out (live locations and games stop as when leaving any group). Lines say who
joined and left, and when the maker changed or cancelled the plan ("Ada changed the plan.", with "See
the plan"). The maker is its admin. Its card (title, time, place, how many are in) is at the top of the
chat. A renamed plan renames the chat. Once a plan is cancelled its chat is an ordinary group again.

**Changing and cancelling.** Only the maker. A new time, place or title tells everyone who hasn't said
Can't (`plan_changed`) and writes a line; cancelling tells them too (`plan_cancelled`), removes the
invites still waiting and writes a line. A cancelled plan can't be answered or added to; its costs can
still be settled.

**Inviting more.** The maker and anyone who said I'm in or Maybe can invite their own friends (or a
squad they're in), with the same checks.

**Cost split.** For everyone who said I'm in or Maybe: add an expense (what, 60 characters; the
amount; the currency, one of USD, EUR, GBP, NGN, GHS, KES, ZAR, XOF; who paid, one of them; split
equally between some of them; the cents that don't divide go one each to the first chosen). Up to 100
expenses a plan. Everyone who has answered sees **who owes whom**, simplified per currency (the person
who owes most pays the person owed most, and so on: as few payments as this finds). Either of the two
can **mark it paid back** (up to what is owed; `plan_not_owed` otherwise), and whoever marked it can
undo it. An expense can be removed by whoever added it or by the maker. The page says it plainly: "Just
for keeping count. No money moves through YAPILAPI: pay each other back your usual way." No payment
provider, wallet or balance is involved.

**Privacy.** Anyone not in a plan gets "not found" for it, its people, its costs and its chat. People
blocked either way are left out of the people list. A linked event or stash shows (with its name and
link) only to people who can see it themselves; others see no place. A stash's spot is never shown,
only its id and title, as everywhere. Notifications are `plan_invite`, `plan_answer` (grouped per
plan), `plan_changed`, `plan_cancelled`, in the `friends` category, entity `plan`; they open the plan.

## Data

- **Export** (`goOut`): your "I'm free" while it lasts; the plans you made or were invited to, with your
  answer (a place from Wander by its kind only); the expenses you added, paid or share in (who paid by
  username) and what you paid back or were paid back (the other person by username).
- **Deleting your account**: your "I'm free" goes; a plan you made goes on with the first person who
  said I'm in (else Maybe), who becomes its maker and the chat's admin, or is deleted when nobody else
  is in it; you're out of every other plan (your answer becomes Can't, so the others' costs still add
  up; the account is no longer listed, so its part shows as "Someone"); the words of expenses you
  added go. Older chat plans you made go.

## The API

| Route | What |
| --- | --- |
| `GET /v1/free` | yours, and friends who are free |
| `PUT`, `DELETE /v1/me/free` | say you're free (until, note), or stop |
| `GET`, `POST /v1/plans` | your plans (coming up, earlier); make one |
| `GET /v1/plans/candidates?planId&q` | friends you could invite |
| `GET`, `PATCH /v1/plans/:id` | the plan; the maker changes it |
| `POST /v1/plans/:id/cancel` | the maker cancels |
| `POST /v1/plans/:id/answer` | `in`, `maybe` or `cant` |
| `POST /v1/plans/:id/invites` | invite friends or a squad |
| `POST /v1/plans/:id/expenses`, `DELETE …/expenses/:expenseId` | add or remove an expense |
| `POST /v1/plans/:id/paid-back`, `DELETE …/paid-back/:settlementId` | mark paid back, or undo |

## Not done yet

- The maker can't take someone out of a plan (blocking them works, and they can be left out of the
  costs); a "remove from plan" is for later.
- No reminder before a plan starts, and no "I'm free" notification to friends (the strip only, on
  purpose: no pressure).
- A plan's chat poll is an ordinary poll: choosing an option doesn't change the plan's time or place;
  the maker edits the plan.
- Phone screens are type-checked but not run on a device (phone builds are on hold). Plan pages aren't
  in the phone's app links (`app-links.json`), like squads and stashes: links open in the browser.
- Amounts are typed in the currency's main unit and kept in hundredths, as everywhere in the app.
