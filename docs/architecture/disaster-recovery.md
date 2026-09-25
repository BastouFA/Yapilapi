# Disaster recovery and graceful degradation

| Failure | What users notice | How the system behaves | Recovery |
| --- | --- | --- | --- |
| Database down | Nothing loads | `/health/ready` returns 503 so the load balancer stops routing; no partial writes (transactions) | Fail over to the managed replica; restore from point-in-time backup if data is lost |
| Redis down | Nothing, on one instance | Rate limiting skips errors (`skipOnError`); realtime falls back to in-process delivery; readiness reports `redis: degraded` | Restart or fail over Redis; no data lives only in Redis |
| Object storage down | New uploads fail with a clear error | Posts without media still work | Restore bucket; uploads are retried by the client |
| CDN down | Slower media | Serve media from origin | Switch CDN or origin shield |
| AI provider down | AI buttons show an error | Only `/v1/ai/*` fails; every other feature is unaffected. Set `AI_PROVIDER=dev` to keep rule-based features working | Retry with backoff (SDK does 2 retries); switch provider |
| Payment provider down | Checkout fails | Orders stay `pending`; no double charges thanks to idempotency keys | Webhooks replay when the provider recovers; reconcile pending orders |
| Region failure | Outage | Stateless API/web redeploy in another region | Promote cross-region database replica; update DNS |
| Network degradation | Slow app | Small pages, cursor pagination, lazy media, realtime reconnects with backoff | — |
| Security incident | Possibly forced sign-out | Revoke all sessions (`UPDATE sessions SET revoked_at = now()`), rotate secrets, review `audit_logs` and `security_events` | Follow the incident runbook; notify affected users as required |

Backups: daily full + continuous WAL on the managed database, 30-day retention, quarterly restore drills. Target RPO 5 minutes, RTO 1 hour.
