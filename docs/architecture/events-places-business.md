# Events, Places and Business modules

Code: `apps/api/src/modules/{events,places,business}/`. Tests: `apps/api/test/{events,places,business}.test.ts` (+ unit tests `events/ics.unit.test.ts`, `business/booking-state.unit.test.ts`, `lib/hours.unit.test.ts`, `lib/geo.unit.test.ts`). Migrations: `150_events.sql`, `155_places.sql`, `160_business.sql` (on top of `004`).

Shared helpers: `lib/geo.ts` (haversine + bounding-box prefilter, antimeridian aware), `lib/hours.ts` (opening-hours schema, `isOpenNow`, `isWithinHours`, IANA timezone validation).

## Contract for COMMERCE (payments) — `attendEventWithTicket`

Commerce owns orders, checkout and refunds. Events owns ticket types, capacity and attendance. Import from `apps/api/src/modules/events/index.js`:

```ts
attendEventWithTicket(ctx, { eventId, userId, ticketTypeId, orderId, quantity? }): Promise<{ status: 'going'; alreadyProcessed: boolean; grantId: string; checkinCode: string }>
releaseEventTicket(ctx, { eventId, userId, orderId }): Promise<{ released: number; promoted: string[] }>
```

- Call `attendEventWithTicket` once payment for an order line is confirmed. `orderId` must be a real `orders.id` (FK).
- **Idempotent** per `(orderId, ticketTypeId, userId)`: a duplicate delivery returns `alreadyProcessed: true` and changes nothing.
- **Concurrency safe**: everything runs in one transaction under a row lock on the event, so `event_ticket_types.sold` never exceeds `quantity`, the event `capacity` is never exceeded and the per-user `max_per_user` limit holds, however many purchases race.
- Commerce must **not** write `sold`, `going_count` or attendance rows itself.
- Failure is `409 conflict` with `details.reason` in `event_closed | ticket_sold_out | event_full | ticket_limit` (`404` for an unknown ticket type). On any of these commerce must not fulfil the line and must refund/void the payment.
- `releaseEventTicket` is the refund/cancellation counterpart (idempotent): it gives the ticket and capacity back, cancels the attendee when no active grant is left and promotes the waitlist.
- When an event is cancelled the paid grants stay `active` with `order_id IS NOT NULL`: commerce finds the orders to refund with `SELECT ... FROM event_ticket_grants WHERE event_id = $1 AND order_id IS NOT NULL AND status = 'active'` (an audit entry `event.cancelled` records `paidGrantsToRefund`).
- Paid ticket types cannot be obtained through `PUT /v1/events/:id/rsvp` (it answers `402 payment_required`); free ticket types can.
- Check-in also accepts purchased ticket codes from `tickets.code` (marks them `used`).

## Other exported services

| Export                                                               | Where    | Purpose                                                                                |
| -------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------- |
| `sendEventReminders(ctx, now?)`                                      | events   | 24h/1h `event_reminder` notifications; idempotent via `event_reminders` ledger         |
| `completeEndedEvents(ctx)`                                           | events   | marks ended published events `completed`                                               |
| `cancelEventSystem(ctx, { eventId, actorId, reason })`               | events   | cancel + notify (for moderation/safety)                                                |
| `listAttendedEventsForMemory(ctx, userId, opts)`                     | events   | user's own attended events, newest first                                               |
| `listEventAttendeesForMemory(ctx, { eventId, userId })`              | events   | friends who attended with the user (null when the user has no standing)                |
| `eventVisibleSql`, `organiserSql`                                    | events   | central SQL visibility/organiser predicates                                            |
| `recomputePlaceRating(db, placeId)`                                  | places   | call after the moderation status of a review changes (caller holds the place row lock) |
| `getAuthorizedBusinessKnowledge(ctx, businessId)`                    | business | ONLY owner-approved knowledge for the AI (see below)                                   |
| `requireBusinessPermission`, `getBusinessAccess`, `ROLE_PERMISSIONS` | business | team authorisation for other modules                                                   |
| `createBooking`, `transitionBooking`, `expireStaleBookings`          | business | booking engine (payment for bookings is commerce's job)                                |

`createPost` (content module) accepts `eventId` and `businessId`; `POST /v1/events/:id/posts` and `POST /v1/businesses/:id/posts` use it.

Jobs (schedule with cron / systemd timer): `npm run events:reminders` (`scripts/send-event-reminders.ts`: reminders + completion of ended events, every 5-10 min) and `npm run bookings:expire` (`scripts/expire-bookings.ts`: cancels unanswered booking requests whose start has passed). Visibility and RSVP rules never depend on the jobs.

## Events

Lifecycle: `draft -> published -> cancelled | completed`. Discover (`GET /v1/events`, `/nearby`) -> Save -> RSVP (`going | interested | not_going`; capacity + FIFO waitlist with promotion when a spot opens) -> Attend (host/co-host check-in, opens 3h before start) -> Participate (event discussion) -> Share (link + `.ics`) -> Remember (memory hooks).

- Roles: host (`events.host_id`), co-hosts (`event_organizers`), community managers (`manage_events`) and business team members (owner/admin/editor) are _organisers_. Only managers (host, community managers, business owner/admin) cancel/delete or manage co-hosts.
- Visibility `public | followers | friends | community | private` plus invitations; drafts only for organisers; blocks hide events both ways (against the host); attendee lists show counts plus friends only, everything for organisers; the online link is only shown to organisers and people who are going.
- Concurrency: every attendance/capacity/ticket change locks the event row (`lockEvent`); counters (`going_count`, `interested_count`, `sold`) are recomputed inside that transaction. Two parallel RSVPs for the last spot yield exactly one `going` and one `waitlist` (or 409 when the waitlist is off).
- Teens (`ageBand = 'teen'`): no public/followers events, no paid tickets, no business events.
- `.ics`: RFC 5545 escaping (`\\`, `\;`, `\,`, `\n`), 75-octet UTF-8-safe folding, CRLF, UTC timestamps, `STATUS:CANCELLED` for cancelled events.

Endpoints: `POST /v1/events`, `GET|PATCH|DELETE /v1/events/:id`, `POST /v1/events/:id/{publish,cancel,complete,check-in,invitations,posts}`, `GET /v1/events/:id/{ticket-types,attendees,my-ticket,cohosts,share,calendar.ics,posts}`, `POST|PATCH|DELETE /v1/events/:id/ticket-types[/:tid]`, `PUT|DELETE /v1/events/:id/{rsvp,save}`, `POST|DELETE /v1/events/:id/cohosts[/:userId]`, `GET /v1/events` (upcoming/past; filters `q topic communityId hostId businessId placeId online free from to`), `GET /v1/events/nearby`, `GET /v1/me/events?role=hosting|attending|interested|waitlist|saved|invited|past`, `GET /v1/me/event-invitations`.

## Places

- Kinds: `restaurant | store | venue | attraction | service`. Anyone (adult) can add a place (duplicate guard: same name within 100 m). Direct edits: staff (moderator+ with MFA), the owning business team (`places.manage`), or the creator while the place is unclaimed. Everyone else uses _suggest an edit_.
- Hours: `{ mon: [["09:00","17:00"]], ... }` validated (no overlaps, overnight ranges allowed, `24:00` close); `isOpenNow` is evaluated in the place's IANA timezone and is `null` (unknown) when no hours are published.
- Nearby search: bounding-box prefilter + exact haversine, keyset pagination on `(distance, id)`, filters `kind q minRating openNow`.
- Photos: `place_media` rows reference owned public images; owner-team photos are approved immediately, others wait for owner/staff review.
- Reviews: one per user per place (a deleted review is revived), rating 1-5, text screened by the moderation pipeline (risky reviews are held: not public, not in the aggregate), no self-review (team members of the owning business), owner reply (`reviews.reply`), reports via `reports`. `rating_avg/rating_count` are recomputed under the place row lock in the same transaction.
- Claims: a business owner/admin requests, staff (moderator+, MFA) approve/reject with an audit entry (`place.claim_approved|rejected`, actor type `staff`) and notification. Approvals lock place -> claim (no deadlock between competing claims), auto-reject other pending claims of the place.
- Suggestions: validated against the same schema as direct edits; accepted by the owner team/staff (never by the suggester), applied atomically.

Endpoints: `POST /v1/places`, `GET|PATCH|DELETE /v1/places/:id`, `GET /v1/places`, `GET /v1/places/nearby`, `PUT|DELETE /v1/places/:id/save`, `GET|POST /v1/places/:id/photos`, `PATCH|DELETE /v1/places/:id/photos/:mediaId`, `GET|POST /v1/places/:id/reviews`, `PATCH|DELETE /v1/reviews/:id`, `PUT|DELETE /v1/reviews/:id/reply`, `POST /v1/reviews/:id/report`, `POST /v1/places/:id/claims`, `GET /v1/me/place-claims`, `POST /v1/place-claims/:id/withdraw`, `GET /v1/staff/place-claims`, `POST /v1/staff/place-claims/:id/{approve,reject}`, `POST|GET /v1/places/:id/suggestions`, `GET /v1/me/place-suggestions`, `POST /v1/place-suggestions/:id/{accept,reject,withdraw}`, `GET /v1/places/:id/{events,products}`. `places/:id/products` queries the commerce `products` table defensively (missing table => empty list).

## Business

- Profiles: display + legal name (legal name team-only), category, description, logo/cover (owned public images), contact, links, hours + timezone, address, booking settings (`slotMinutes, leadTimeMinutes, maxAdvanceDays, maxDurationMinutes, maxPartySize, autoConfirm`; patches merge). `verified_at/verified_by` are set **only** by staff (`POST /v1/staff/businesses/:id/{verify,unverify}`, moderator+ with MFA, audited); owner input for it is ignored. Staff can suspend/reinstate (`PUT /v1/staff/businesses/:id/status`); suspended businesses are hidden and read-only.
- Team roles and permissions (`business/access.ts`): `owner` (everything: analytics, AI approval, close/transfer), `admin` (profile, team, offers, posts, events, places, claims, bookings, replies, AI drafts), `editor` (offers, posts, events, places, replies), `support` (bookings, replies). Invitations grant nothing until accepted; you can only invite/change/remove roles below your own rank; the owner changes only through `transfer-ownership`.
- Bookings (`POST /v1/bookings`): target is a place with `booking_enabled` (capacity = party size) or a `service` product (capacity 1). Validation: lead time, horizon, slot grid, duration, opening hours in the resource's timezone, party size. Double-booking is prevented by a per-resource advisory lock inside the transaction that checks free capacity (parallel requests for the last slot: exactly one wins, others `409 slot_unavailable`). State machine (`booking-state.ts`): `requested -> confirmed | declined`, `requested|confirmed -> cancelled` (before start), `confirmed -> completed | no_show` (after start); terminal states never change. Team members with `bookings.manage` (owner, admin, support) act for the business; every transition notifies the other side. **Payment for bookings/services is commerce's job.**
- Services are `products` rows of kind `service` managed through `/v1/businesses/:id/services` (catalogue entry only; checkout belongs to commerce).
- Analytics (`GET /v1/businesses/:id/analytics?days=`): owner only, computed from real rows (views, followers, bookings by status, hosted events/attendance, posts, place reviews, active offers).
- Following: `business_followers` with `follower_count` maintained under a business row lock.
- Posts on behalf of the business: `posts.business_id`, allowed for owner/admin/editor.
- **AI knowledge base**: `businesses.ai_knowledge` (jsonb entries) + `ai_assistant_enabled`. Owners/admins write drafts, only the **owner** approves an entry (recording approver and a sha256 of title+content) and switches the assistant on. Editing text returns an entry to draft. The AI module must call `getAuthorizedBusinessKnowledge(ctx, businessId)`: it returns `null` unless the business is active and the assistant is enabled, and then only `{id, title, content, category}` of entries that are approved, have an approver and whose text still matches the approval hash. Drafts, tampered/forged entries and all other business data are never returned. Treat entries as untrusted data, never as instructions.

Endpoints: `POST /v1/businesses`, `GET /v1/businesses[/:ref]`, `PATCH|DELETE /v1/businesses/:id`, `GET /v1/me/businesses`, `POST /v1/businesses/:id/view`, `PUT|DELETE /v1/businesses/:id/follow`, `GET /v1/me/following-businesses`, `GET /v1/businesses/:id/followers`, team (`GET .../team`, `POST|GET .../invitations`, `DELETE .../invitations/:userId`, `GET /v1/me/business-invitations`, `POST .../invitation/{accept,decline}`, `PATCH|DELETE .../team/:userId`, `POST .../transfer-ownership`), offers (`GET|POST .../offers`, `PATCH|DELETE .../offers/:offerId`), services (`GET|POST .../services`, `PATCH|DELETE .../services/:serviceId`), bookings (`GET .../bookable`, `POST /v1/bookings`, `GET /v1/bookings/:id`, `GET /v1/me/bookings`, `GET .../bookings`, `POST /v1/bookings/:id/{confirm,decline,cancel,complete,no-show}`), `GET .../analytics`, AI (`GET|PUT .../ai`, `POST|PATCH|DELETE .../ai/knowledge[/:entryId]`, `POST .../ai/knowledge/:entryId/{approve,revoke}`), posts (`GET|POST .../posts`, `DELETE .../posts/:postId`), `GET .../events`, staff (`POST /v1/staff/businesses/:id/{verify,unverify}`, `PUT /v1/staff/businesses/:id/status`).

## Account deletion (`registerDeletionHook`)

- Events: the user's attendance is removed (tickets returned, waitlists promoted), hosted events go to a co-host / business owner or are cancelled, invitations/saves/reminders removed.
- Places: reviews deleted with aggregates recomputed, suggestions/saves/photos removed, pending claims withdrawn.
- Business: owned businesses go to the most senior remaining member or are closed (bookings and events cancelled, places released); memberships, invitations and follows removed (counts recomputed); the user's upcoming bookings are cancelled and the business told.

## Known gaps

- Bookings and event tickets are not paid through this module; commerce must wire `attendEventWithTicket`/`releaseEventTicket` and refunds.
- No push/email reminder channel beyond in-app notifications (`notify`).
- Service duration is chosen by the customer per booking; there is no per-service duration or staff-calendar model.
- Photo moderation is owner/staff review only (no automatic image classifier).
