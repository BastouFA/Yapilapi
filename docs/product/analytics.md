# Analytics

Scope: `apps/api/src/modules/analytics`, migration `193_admin_analytics.sql`, `scripts/analytics-retention.ts`. Tests: `apps/api/test/analytics.test.ts`,
`apps/api/src/modules/analytics/analytics.unit.test.ts`.

We measure whether people are actually connecting, not how long we can hold their attention. Analytics is designed so that the _default_ is to
collect nothing about a person, and so that the numbers leadership sees cannot be built from surveillance.

## Meaningful Social Actions (MSA)

An **MSA** is an action in which one person deliberately reaches another person or a group of people, and the result is visible to at least one other
human. It is the north-star metric. It is computed from the operational tables (messages, comments, posts, events), **not** from tracking events, so it
does not depend on anyone's analytics consent and never exists as a per-person record: only aggregates leave the database.

**Counts as an MSA (each must be moderation-approved and not deleted):**

| Type      | Definition                                                                                                                                                 |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `message` | A non-system message sent in a conversation that has at least one _other_ current member (talking to yourself is not social).                              |
| `comment` | A comment on **someone else's** post.                                                                                                                      |
| `post`    | A post whose visibility is anything other than `private`.                                                                                                  |
| `plan`    | RSVPing _going_ or _attended_ to **someone else's** event, or hosting an event that has been published (drafts do not count; "interested" does not count). |

**Does not count:** reactions, follows, saves, views/impressions, shares, searches, notification opens, time spent, and anything automated (system messages).
These are cheap to produce, easy to inflate and say little about connection. Optimising them is explicitly _not_ a goal.

**Daily caps** (per person, per UTC day, per type): message 10, comment 10, post 5, plan 5. Actions above the cap are ignored, so a burst of spam or a
bot cannot move the metric.

**Meaningful Weekly Participant (MWP):** a person with at least **3 capped MSAs on at least 2 distinct UTC days** in the trailing 7 UTC days (today
included). One very busy day is not a habit; two quiet days of real interaction are. `mwpShare` = MWP / all people with any MSA in the window.

**Reporting rules:** aggregates only; any cell with 1-4 people/events is suppressed (`null`, counts of 0 are shown); only accounts with status `active` are counted;
windows are UTC. `GET /v1/admin/analytics/msa?weeks=N` returns N consecutive trailing-7-day windows plus this definition, so the dashboard and the doc cannot drift.
The constants and SQL live in `msa.ts` and the rules are unit-tested.

## Product analytics events (opt-in, allowlisted)

Separate from MSA: a small stream of client events used for funnels, web vitals and error rates.

- **Strict allowlist** (`events.ts`): nine client events (`screen_view`, `app_open`, `onboarding_step`, `search_performed`, `share_tapped`, `notification_opened`,
  `composer_opened`, `web_vital`, `client_error`) and three server events (`post_created`, `report_created`, `appeal_created`). The full schema is public:
  `GET /v1/analytics/events/schema`.
- **No free text.** Every property is an enum, a boolean or a bounded number, and unknown keys are _rejected_, not stripped. Search queries, message text, names, urls and ids
  cannot be sent even by mistake.
- **Clients cannot send server events** (no forging `post_created`) and cannot set timestamps.
- **Consent:**
  - signed in: the account's latest `analytics` consent must be granted (default off; **teens never**), checked on every request, so revocation is immediate;
  - signed out: the client sends `x-analytics-consent: 1` from its own consent banner plus a random `anonId`; the id is validated as a random-looking token, never derived from a device or IP;
  - **Do Not Track (`DNT: 1`) and Global Privacy Control (`Sec-GPC: 1`) discard everything**, before consent is even considered.
- Signed-in events never carry an anonymous id; anonymous events carry no user id. IP addresses and user agents are not stored.
- Server events go through `track()`, which applies the same consent check per user, never throws and never blocks the calling request (it isolates itself in a savepoint when
  called inside a transaction). Server-side events rely on account consent only; DNT is a request-level signal and is honoured at ingestion.
- **Retention:** raw events are deleted after `ANALYTICS_RETENTION_DAYS` (default 90) by `scripts/analytics-retention.ts`. Revoking consent detaches existing events from the account; account deletion does the same.
- Ingestion: `POST /v1/analytics/events`, at most 20 events per request, rate limited, answers `202 {accepted, rejected[], discarded?}` so clients can fix mistakes.

## Definitions of the other numbers

| Metric                | Definition                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Active user           | Performed at least one **write action** (post, comment, message, reaction, follow, RSVP) in the window. Opening the app does not count.                            |
| DAU / WAU / MAU       | Distinct active users in the last 1 / 7 / 30 UTC days (today included). Stickiness = DAU / MAU.                                                                    |
| Retention (cohorts)   | Cohort = accounts created in a UTC week. Retained in week _k_ = performed a write action during the _k_-th week after the cohort week (week 0 is the signup week). |
| Onboarding completion | Signups in the period whose profile has `onboarding_completed_at`. Funnel steps come from consented client events, so they undercount by design.                   |
| Creators / commerce   | Status counts, tips and paid orders (paid, fulfilled, completed) by currency; groups under 5 hide their amounts.                                                   |
| Safety                | Reports by reason/status, cases by source/state, median hours to decision, appeals by outcome, enforcements by kind.                                               |
| Web vitals            | p75 per metric and platform from consented client events; groups under 5 samples are hidden.                                                                       |

## Staff API

`GET /v1/admin/analytics/{acquisition,engagement,retention,msa,creators,commerce,safety,technical}`: permission `analytics.read` (admin, superadmin; MFA required).
Sections degrade to `{available: false}` if an underlying table of another module is unavailable, instead of blanking the dashboard.

## Gaps

- MSA queries scan operational tables per request; for production scale they should be materialised nightly (daily per-user-per-type table) and the endpoint should read that.
- No experiment/feature-flag exposure logging and no A/B analysis; no funnel definitions beyond onboarding.
- Server events use account consent only. Requests carrying DNT/GPC that trigger a server event are still recorded if the account consented.
- No export of dashboards; no alerting on metric regressions.
- Small-cell suppression hides 1-4 but does not defend against differencing attacks across overlapping windows. Do not expose finer breakdowns without a review.
