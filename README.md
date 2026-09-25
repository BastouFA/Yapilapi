# YAPILAPI

**Your social world. One place.**

YAPILAPI is a social platform built around visible, controllable recommendations (For You with reasons), Circles and Communities with human-decided rules, Moments, REAL and REAL Together, Memory, Studio, events, places, businesses and commerce, and a permissioned AI assistant that never publishes without you.

> This repository is a working, tested implementation, not a finished product. Read [Status and honest gaps](#status-and-honest-gaps) before deploying anything to real users. Domain names, social handles and the trademark "YAPILAPI" still need to be registered and cleared by an attorney; web/DNS searches are not trademark clearance.

## Repository layout

```
apps/api        Fastify + TypeScript API (all domain modules, OpenAPI, WebSockets)
apps/web        Next.js web app (en full; fr/ar/yo machine-drafted, need native review)
apps/admin      Next.js staff console (MFA + role-based, audit, moderation, payments, flags)
apps/mobile     Expo React Native app (own install; NOT an npm workspace, see ADR 001)
packages/*      shared, config, database (migrations), security, recommendations, moderation,
                search, payments, ai, api-client, design-system, ui
infrastructure  docker (Dockerfiles), deployment (compose + deploy.sh), monitoring, database (backup/restore)
docs            architecture (+ decisions/ADRs), api (openapi.json), product, security, operations
scripts         migrate/seed/reset, OpenAPI generation, and the scheduled maintenance jobs
tests           global test setup, AI evaluation suite, shared unit tests
```

## Prerequisites

- Node.js >= 22 and npm
- PostgreSQL 16 and Redis 7 (Docker Compose provided; Redis is optional in development and falls back to memory)
- Optional: ffmpeg (media transcoding, slideshow export), Docker (compose, images), Expo tooling for mobile

## Quick start

```bash
cp .env.example .env            # dev defaults; never commit real secrets
docker compose up -d            # Postgres + Redis (optional profiles: search, media, mail)
npm install
npm run db:migrate              # applies packages/database/migrations
npm run db:seed                 # optional: clearly labelled fictional dev data (dev_amara, dev_kwame, ...)
npm run dev                     # API on http://localhost:4000  (docs: docs/api/openapi.json)
npm run dev:web                 # web on http://localhost:3000
npm run dev:admin               # admin on http://localhost:3100
npm run mobile:start            # after: npm install --prefix apps/mobile
```

Seeded users log in with `<username>@example.test` and the shared **development-only** password printed by the seed script. The seed refuses to run outside `APP_ENV=development|test`.

To create a staff account (there is intentionally no public API for it): register normally, then in a development database run `UPDATE users SET platform_role = 'admin' WHERE username = '...'`, enable two-factor authentication in the web app's security settings, then sign in to the admin console (staff routes require an MFA-verified session).

## Everyday commands

| Command                                       | Purpose                                                         |
| --------------------------------------------- | --------------------------------------------------------------- |
| `npm run ci`                                  | format check, lint, typecheck, all tests, build (what CI runs)  |
| `npm test` / `test:unit` / `test:integration` | Vitest; integration uses a real PostgreSQL                      |
| `npm run test:load`                           | Latency/error smoke test against a running API                  |
| `npm run test:ai-evals`                       | AI safety/quality evaluation suite (deterministic dev provider) |
| `npm run test:e2e -w @yapilapi/web`           | Playwright end-to-end + axe accessibility                       |
| `npm run mobile:test` / `mobile:typecheck`    | Mobile checks (own toolchain)                                   |
| `npm run db:reset`                            | Drop and rebuild the dev schema (refuses outside dev/test)      |
| `npm run openapi`                             | Regenerate `docs/api/openapi.json` from the zod schemas         |
| `npm run format` / `lint` / `typecheck`       | Prettier, ESLint, TypeScript strict                             |

Integration tests create a private database whose name contains `test` (default `yapilapi_test`; set `TEST_DATABASE_URL` for parallel runs) and recreate it from a migrated template before every test file (ADR 011). They never touch your dev database.

## Configuration

All configuration is environment variables validated at start-up (`packages/config`); see `.env.example` for every option. In `staging` and `production` the API refuses to start without `DATA_ENCRYPTION_KEY`, `WEBHOOK_SIGNING_SECRET`, `IP_HASH_SALT`, `REDIS_URL`, `COOKIE_SECURE=true`, a real payment provider and a real email adapter. Generate secrets with `openssl rand -base64 48`. Feature flags are managed at runtime by staff.

## Security posture (summary)

Server-side authorization on every route; visibility enforced in SQL; CSRF + Origin checks for cookie sessions; scrypt passwords, hashed opaque sessions, TOTP MFA; rate limits; append-only audit log; no raw card data (guarded and scanned); AI acts as the requesting user and drafts need human confirmation; secrets/card numbers are redacted before AI text is stored. Details: `docs/security/` and `docs/architecture/decisions/`.

## Deployment

CI (`.github/workflows/ci.yml`) runs quality, tests against real Postgres/Redis, web/admin builds, mobile checks, Playwright, dependency audit and gitleaks; CodeQL runs separately. `deploy.yml` builds images (`infrastructure/docker`) and deploys through `infrastructure/deployment/deploy.sh` to a Docker host, per GitHub environment (development, staging, production with required reviewers). Schedule the maintenance jobs and set up backups: see `docs/operations/resilience-and-disaster-recovery.md`. The Dockerfiles, deploy workflow and monitoring config were written but not executed in the authoring environment.

## Status and honest gaps

Implemented and tested: accounts, MFA, teen safety defaults, graph, posts/comments/reactions, ranked and chronological feeds, messaging with realtime, communities, media pipeline, Moments, search and discovery, events, places, businesses, commerce and payments (ledger), safety and privacy tooling (reports, appeals, export, deletion), notifications, analytics, developer platform, AI platform with memory, creator economy, Studio, Live (control plane), ads, REAL, REAL Together, admin console, web app, mobile app (core flows).

Web app coverage: every domain listed above has a built UI, not just an API — Discover/search, notifications centre, media/Moments, REAL and REAL Together, Memory, events, places, businesses, commerce (shop, checkout, orders, seller console), creator economy and Studio, Live, the AI assistant, the privacy centre and data/export tools (under Settings), and the developer console are all real screens backed by real component code, covered by the same unit and E2E suites as the rest of the app (see `apps/web/src/app/(app)/` for the full route list). Mobile has a smaller, intentionally-scoped surface: auth, feed, posts, profiles, chat, communities (read/join), notifications and settings — the domains above are API-complete but not yet built into the mobile app.

Known gaps (also listed per area in `docs/`):

- Not run against real third parties: Stripe, Anthropic/OpenAI, S3, OpenSearch, Expo push. Mobile has never run on a physical device.
- Live video needs an ingest provider (501 without one); WebRTC calls are signaling-only (no TURN/SFU); messages are not end-to-end encrypted; no speech provider; no hardware attestation; passkeys and the mini-app sandbox are not implemented (`MINI_APPS` flag off); tax is seller-declared and shipping is a flat placeholder.
- fr/ar/yo translations are machine-drafted and need native review. The Yoruba copy in particular should be reviewed by a fluent speaker.
- Maintenance jobs must be scheduled by the operator. Sentry/OpenTelemetry are reserved, not wired.
- `npm audit`: a high-severity nodemailer advisory (SMTP/header injection on older versions) was fixed by bumping to `nodemailer@^9.1.1` — the API's outbound email surface only ever passes a validated `to` address, a fixed `subject`, and plain text, so the affected raw-option/jsonTransport code paths were never reachable, but the dependency is patched regardless. Two gaps remain open: a moderate advisory in Vitest's mocker (dev-only, doesn't ship) and a high-severity PostCSS advisory (arbitrary source-map file read, unescaped `</style>` XSS) that every Next.js 15.x release bundles transitively — the only fix is Next 16, a breaking major-version migration (App Router/React version changes) that's out of scope for this pass. PostCSS here only ever compiles this repo's own CSS at build time, never attacker-supplied CSS at runtime, which limits the practical exposure, but treat the Next 16 upgrade as a tracked follow-up, not a closed item.
- Performance: only a smoke test exists (`npm run test:load`; on a 2-CPU dev container, 20 connections against public read endpoints gave ~1,200 req/s, p95 about 30 ms, 0 errors). That is not a capacity plan: run realistic authenticated scenarios (k6/Gatling) on a production-like environment before launch.
