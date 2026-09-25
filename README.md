# YAPILAPI

**Your social world. One place.** A social operating system that connects people, content, communities, communication, places, events, commerce, AI and memories.

This monorepo holds the API, web app, mobile foundation, shared packages, database migrations, infrastructure and docs. See [docs/product/status.md](docs/product/status.md) for exactly what is built, what is architected, and what is still to do.

## Where to keep the project

Keep it outside iCloud-synced folders (Desktop, Documents). iCloud offloads files and makes installs, builds and tests hang. This repository lives in `~/Developer/yapilapi`.

## Prerequisites

- Node.js 22 or newer
- pnpm 10 or newer (`npm i -g pnpm`)
- Docker (for Postgres 16 and Redis 7)

## Getting started

```bash
cp .env.example .env        # every variable is documented inside
pnpm install
pnpm infra:up               # Postgres + Redis in Docker
pnpm db:migrate             # apply migrations
pnpm db:seed                # clearly-labelled development data
pnpm dev                    # API on :4000, web on :3000
```

Open http://localhost:3000. Seeded development accounts use the domain `dev.yapilapi.local` and the password `dev-password-123` (for example `dev_amara@dev.yapilapi.local`; `dev_admin@dev.yapilapi.local` is an admin). Every seeded profile's bio starts with `[Dev data]`, and the seed refuses to run when `APP_ENV=production`.

In development, verification and password-reset emails are written to the API log and to `GET /dev/outbox`.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Run the API (watch mode) and web app together |
| `pnpm test` | Unit, integration, API, security and AI evaluation tests (needs Postgres running) |
| `pnpm typecheck` | Type-check every package |
| `pnpm build` | Production build of every package |
| `pnpm format` / `pnpm format:check` | Prettier |
| `pnpm db:migrate` / `pnpm db:seed` | Database migrations and development seed |
| `pnpm infra:up` / `pnpm infra:down` | Start or stop Postgres and Redis |

Tests create and reset their own database (`TEST_DATABASE_URL`, default `yapilapi_test`).

## Repository layout

```text
apps/
  api/            Fastify API: every domain module, realtime WebSocket, AI gateway
  web/            Next.js web app (desktop + mobile web), including the admin console at /admin
  mobile/         Expo app foundation (installed separately; see its README)
packages/
  shared/         Validation schemas, types, constants, feature flags, i18n catalogs
  database/       SQL migrations, migration runner, seed
  auth/           Password hashing and session tokens
  api-client/     Typed client used by web and mobile
  design-system/  YAPILAPI tokens, CSS and React components
infrastructure/   Dockerfiles, deployment compose file, Prometheus config and alerts
docs/             Architecture, decisions, API, security, product status
.github/workflows CI: format, types, tests, build, secret scanning, dependency audit, CodeQL
```

## Deployment

Build the images in `infrastructure/docker/`. Staging can run `infrastructure/deployment/docker-compose.prod.yml` against managed Postgres and Redis. Production requirements (HTTPS, `COOKIE_SECURE=true`, a real `PAYMENTS_WEBHOOK_SECRET`, object storage and CDN for media) are in [docs/architecture/deployment.md](docs/architecture/deployment.md). The API refuses to start in production with development secrets.

## External dependencies still needed

These are wired behind adapters with working development implementations; production needs accounts or keys:

| Dependency | Where | Development behaviour |
| --- | --- | --- |
| Email delivery (SMTP or email API) | `apps/api/src/lib/email.ts` | Logs emails, exposes `/dev/outbox` |
| AI provider key (`ANTHROPIC_API_KEY`) | `apps/api/src/lib/ai/providers.ts` | Deterministic rule-based provider, clearly labelled in the UI |
| Payment provider | `apps/api/src/lib/payments.ts` | Sandbox provider with signed webhooks |
| Object storage + CDN | `apps/api/src/lib/storage.ts` | SeaweedFS (S3-compatible) in docker compose, or local disk with `STORAGE_DRIVER=local` |
| Video transcoding | `apps/api/src/lib/media-processing.ts` | Bundled ffmpeg in the API worker; move to dedicated workers at scale |
| TURN server for calls | `turn` service (coturn) + `TURN_URLS`, `TURN_SECRET` | Runs in docker compose |
| Live video | `live` service (MediaMTX) | Runs in docker compose; stream with OBS to `rtmp://localhost:1935/live` |
| Push notifications | `VAPID_*` (browser), EAS project id (mobile) | Browser push works locally once VAPID keys are set |
| MFA encryption key (`MFA_ENCRYPTION_KEY`) | `apps/api/src/modules/mfa.ts` | Fixed development key; production refuses to start without one |
| Live video provider (ingest + playback) | `apps/api/src/modules/live.ts` | Placeholder local URLs; chat, roles and audience work |
| Production domain, app-store accounts | infrastructure, `apps/mobile/app.json` | localhost |
