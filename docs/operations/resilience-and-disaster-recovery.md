# Resilience, graceful degradation and disaster recovery

This states what the code does today when a dependency fails, and what operators must provide. Nothing here is aspirational unless marked **Operator**.

## Dependency failure behaviour

| Dependency down             | What happens                                                                                                                                                                                                    | Notes                                                                                                                                                     |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PostgreSQL**              | `/health/ready` returns 503 (load balancer drains the instance); API requests fail with 5xx. `/health/live` stays 200 so the process is not restarted needlessly.                                               | The system of record. Use managed HA + PITR (**Operator**).                                                                                               |
| **Redis**                   | Realtime fan-out between API instances stops (single-instance delivery still works in-process); rate limiting **fails open** (requests are allowed).                                                            | Login lockout and account protections are stored in PostgreSQL, so brute-force protection does not depend on Redis. Alert on Redis health (**Operator**). |
| **OpenSearch** (if enabled) | Search logs a warning and falls back to PostgreSQL search.                                                                                                                                                      | Results are less rich, never unavailable.                                                                                                                 |
| **AI provider**             | Router falls back along the configured chain; per-provider circuit breaker opens after repeated failures; if all fail the user gets a clear "assistant unavailable" error. Core social features are unaffected. | Per-user and global daily budgets also stop runaway spend.                                                                                                |
| **Payment provider**        | Checkout answers with a retryable error; orders stay reserved until reservation expiry (`commerce:maintenance`). Webhooks are idempotent and can be replayed.                                                   | Reconciliation job compares ledger to provider.                                                                                                           |
| **Object storage / ffmpeg** | Upload/serve failures are per-request; transcoding and slideshow export answer `503 processing_unavailable` (no fake success).                                                                                  | Originals are not deleted until processing succeeds.                                                                                                      |
| **Email / push**            | Sending failures never fail the user's request; notifications remain in the in-app inbox.                                                                                                                       | Retries are via the maintenance jobs.                                                                                                                     |
| **Live video ingest**       | `LIVE` streaming answers 501 when no ingest provider is configured.                                                                                                                                             | Feature-flagged.                                                                                                                                          |

Feature flags can switch off `LIVE`, `COMMERCE`, `AI_TRANSLATION`, `MEMORY`, `NOW`, `MINI_APPS`, `PLAY`, `REAL`, `REAL_TOGETHER` instantly (admin console, audited) to shed load or contain an incident without a deploy.

## Scheduled jobs (**Operator must schedule these**)

The repo provides the commands; a scheduler (cron, Kubernetes CronJob, GitHub Actions schedule) must run them. The simplest option is `npm run scheduler` (`scripts/scheduler.ts`): one long-lived process that runs every job below on its own timer, in-process, for as long as it stays up — this is what `render.yaml` (repo root) deploys as the `scheduler` worker service. It exists to avoid paying a separate cron-service minimum (and a fresh container boot) for each of the ~12 commands below, especially the two due every minute; a crash restarts the whole process, which is safe because every job here is idempotent and tolerant of running more often than its cadence. If you'd rather see each job's own run history/duration in a scheduler dashboard, the same commands work as N separate cron entries instead — suggested cadence:

| Command                                                              | Cadence                         |
| -------------------------------------------------------------------- | ------------------------------- |
| `npm run moments:expire`                                             | every 15 min                    |
| `npm run events:reminders`                                           | every 5 min                     |
| `npm run bookings:expire`, `commerce:maintenance`                    | every 5 min                     |
| `npm run studio:publish`                                             | every minute                    |
| `npm run live:maintenance`, `ads:maintenance`, `creator:maintenance` | every 15 min                    |
| `npm run safety:expire-enforcements`                                 | every 15 min                    |
| `npm run privacy:finalize-deletions`                                 | hourly                          |
| `npm run notifications:digests`                                      | hourly (job decides who is due) |
| `npm run developer:webhooks`                                         | every minute                    |
| `npm run media:cleanup`, `analytics:retention`                       | daily                           |

Each job is idempotent and safe to overlap (row-level locking); running more often than the cadence is harmless.

## Backups and restore (**Operator**, tooling provided)

- Production: managed PostgreSQL with automated backups and point-in-time recovery. Target RPO <= 5 min, RTO <= 1 h are the design goals; they are only real once your provider is configured and drilled.
- Portable fallback: `infrastructure/database/backup.sh` (custom-format dump + checksum) and `infrastructure/database/restore-drill.sh` (restores into a throwaway database and verifies migrations and ledger balance). Both were exercised in this repository against the test database. Run the drill on a schedule.
- Media: object storage versioning + lifecycle; the database stores references, not bytes.
- Secrets: `DATA_ENCRYPTION_KEY` **must be backed up separately**. Without it, encrypted MFA secrets cannot be read. `DATA_ENCRYPTION_KEY_ID` is recorded alongside ciphertext so a rotation procedure can be added; automated re-encryption is not implemented.

## Incident checklist

1. Check `/health/ready`, error rate and latency (`infrastructure/monitoring/alerts.yml`).
2. Contain: disable the affected feature flag; pause a payout/ads job if money movement is suspect.
3. Payments: run reconciliation; the ledger is append-only, so corrections are new balancing entries, never edits.
4. Security incident: revoke the affected accounts' sessions (staff enforcement actions, or delete their rows in `sessions` directly), rotate `METRICS_TOKEN`, `WEBHOOK_SIGNING_SECRET`, provider keys; the audit log is append-only evidence.
5. Restore only into a new database first, verify, then cut over.
