# Ads

Scope: `apps/api/src/modules/ads`, migration `250_ads.sql`, `scripts/ads-maintenance.ts` (`npm run ads:maintenance`).
Tests: `modules/ads/rules.unit.test.ts` (16, pure targeting/pacing/fraud rules), `apps/api/test/ads.test.ts` (21 on real Postgres).

## Principles

1. **Contextual, interest and coarse-geo targeting only.** The schema is strict: topics (canonical topic slugs), languages, countries/cities. Anything else (`age`, `gender`, `religion`, `health`, custom audiences, lookalikes, coordinates, ...) is refused by name with a useful message; sensitive topics (`politics`, `faith`, `health`, `mental-health`) cannot be targeted.
2. **No minors, ever.** Teens cannot advertise and are never served an ad (`selectAds` returns nothing for a non-adult, and `hasConsent('advertising')` is false for teens).
3. **Consent for personalisation.** The page's own topics (contextual) always work. The viewer's explicit interests are used **only** with `advertising` consent; withdrawing it stops personalisation at once. Every served ad says why (`whyThisAd`).
4. **Every ad is labelled** `sponsored: true` / `label: "Sponsored"`, with the advertiser's name.
5. **Human review first.** Nothing is served until staff approve it; approvals and rejections carry reasons and are audited.
6. **Never bill for what was not delivered.**

## Endpoints (`/v1/ads`)

Advertisers: `POST|GET campaigns`, `GET|PATCH campaigns/:id`, `POST campaigns/:id/submit|pause|resume|end`, `POST campaigns/:id/ads`, `PATCH|DELETE campaigns/:id/ads/:adId`, `GET campaigns/:id/report`.
Viewers: `GET serve`, `POST impressions`, `POST clicks`.
Staff (`moderator`, `admin`, `superadmin`; MFA): `GET staff/ads/campaigns`, `GET staff/ads/campaigns/:id` (with the review history), `POST .../review` (approve/reject with per-ad decisions), `POST staff/ads/ads/:id/review`, `POST .../suspend|reinstate`, `POST staff/ads/maintenance` (admin).
Exported service: `selectAds(ctx, viewerId, placement, n, context?)`, `logImpression`, `logClick`, `settleAdSpend`, `runAdsMaintenance`.

## Design

**Who advertises.** A business (owner/admin of an active business) or an active creator as themselves; adults only. Campaigns: budget (daily <= total), bid model `cpm` (per 1000 impressions) or `cpc`, frequency cap, schedule, targeting. Lifecycle: `draft -> pending_review -> active <-> paused -> ended` (`rejected` returns to draft). Only draft/rejected/paused campaigns are editable; a paused campaign whose targeting/bid/objective changes goes back to draft (a new review), budget/schedule/name edits keep the approval. A new ad on a running campaign is reviewed on its own. Reviewers cannot review their own campaign or one of a business they belong to. Staff can suspend a running campaign (the owner cannot resume it; staff reinstate it) and take down a single ad.

**Selection** (`serve.ts`): adult active viewer; ad approved, campaign active and inside its schedule, advertiser account/business active; never the viewer's own ads or those of anyone blocked in either direction; targeting match (language/geo are hard filters that an absent value cannot satisfy); per-viewer frequency cap over 24 h; total and daily budget with **even pacing** through the UTC day (15% burst allowance); one ad per campaign; ranked by expected revenue (cpc bids compared with cpm on smoothed CTR) lifted by relevance (at most +30%). `GET /v1/ads/serve` requires a signed-in adult: anonymous viewers get nothing because their age is unknown.

**Impressions and clicks.** Serving records nothing. Each served ad carries an **HMAC-signed token** (ad, unique nonce, viewer, placement, issue time; TTL 30 min; bound to the viewer). The client reports `POST impressions` when the ad was actually shown: idempotent per token (unique nonce), so replays and concurrent duplicates record and bill once. A click needs its impression, at most one billable click per impression (unique key), and returns the destination. Invalid traffic is **recorded with cost 0** so reports can show what was filtered: expired token, reported within 250 ms, bot user agents, frequency cap, IP floods (per ad per hour; per campaign per hour for clicks), the advertiser's own views/clicks, campaign no longer serving, `budget_exhausted`.

**Budget safety.** Spend accrues in milli-cents (1/1000 cent) under a row lock on the campaign; a charge that would pass the total or daily budget is recorded as `budget_exhausted` at cost 0, and the campaign ends as soon as it cannot afford one more unit. Tests fire 8 parallel impressions at a budget for 4.

**Ledger.** `settleAdSpend` moves whole cents into the double-entry ledger, one balanced transaction per settlement: debit `ad:receivable:<campaign>` (an asset: what the advertiser owes), credit `platform:ad_revenue`. Idempotent (`(kind, ref_type, ref_id)` unique, row lock, sub-cent remainder stays accrued). `runAdsMaintenance` ends finished campaigns (schedule or budget) and settles; run it with `npm run ads:maintenance` every ~10 minutes.

**Reports** (`GET campaigns/:id/report`): impressions, clicks, CTR, spend, filtered traffic by reason, by day / ad / placement, and the billing position (accrued vs settled). **Aggregates only**: no viewer identifier appears.

**Privacy.** Export section `advertising` (ads I saw/clicked, campaigns I run). The deletion hook unlinks the viewer (`viewer_id`, `ip_hash` set to NULL; the counts stay for billing) and ends campaigns the user ran as themselves. IPs are stored only as salted hashes.

## Honest gaps

- **Advertisers are not charged.** Spend is booked as a receivable; there is no card charge, prepaid balance, invoice or collections flow. That is a separate billing feature.
- **No invalid-traffic credit or dispute flow** after the fact (filtering is real-time only); staff cannot yet credit spend back.
- **Fraud detection is simple rules** (timing, user agent, IP rate, frequency), not a model; NAT/shared IPs can over-filter, botnets on many IPs will not be caught.
- **Geography is supplied by the client** (`country`/`city` query parameters); there is no server-side IP geolocation. Treat geo as best-effort.
- **Viewer interests come from explicit interests only**; no inferred profile is built for ads.
- **Placements are slots the client asks for** (`feed`, `search`, `discover`, `profile`); this module does not insert ads into those responses by itself.
- Creative types are text + one image/video; no carousel, lead forms, conversion pixels, A/B testing or budget forecasting.
- Pacing and frequency use the database directly; at very high volume they need counters in Redis.
