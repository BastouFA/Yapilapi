# Deployment

Environments: **development** (local Docker), **staging** (single host, `infrastructure/deployment/docker-compose.prod.yml`), **production** (container platform, managed services).

## Production checklist

- Managed Postgres 16 with automated backups and point-in-time recovery; managed Redis 7.
- API and web images from `infrastructure/docker/`, at least two API replicas behind a load balancer with WebSocket support.
- HTTPS everywhere; `COOKIE_SECURE=true`; `WEB_ORIGIN` and `PUBLIC_API_URL` set to the real domains.
- Secrets from the platform's secret manager: `DATABASE_URL`, `REDIS_URL`, `PAYMENTS_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, SMTP credentials.
- Replace local-disk media storage with an S3-compatible bucket and CDN (implement `MediaStorage.put`).
- Migrations run on start (`MIGRATE_ON_START=true`, advisory-locked) or as a release step.
- Scrape `/metrics` with Prometheus (`infrastructure/monitoring/`), route alerts to on-call; point liveness at `/health/live` and readiness at `/health/ready`.
