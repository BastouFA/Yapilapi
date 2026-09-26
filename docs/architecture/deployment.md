# Deployment

Environments: **development** (local Docker), **staging** (single host, `infrastructure/deployment/docker-compose.prod.yml`), **production** (container platform, managed services).

## Production checklist

- Managed Postgres 16 with automated backups and point-in-time recovery; managed Redis 7.
- API and web images from `infrastructure/docker/`, at least two API replicas behind a load balancer with WebSocket support.
- HTTPS everywhere; `COOKIE_SECURE=true`; `WEB_ORIGIN` and `PUBLIC_API_URL` set to the real domains.
- Secrets from the platform's secret manager: `DATABASE_URL`, `REDIS_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `MFA_ENCRYPTION_KEY`, `LIVE_HOOK_SECRET`, `ANTHROPIC_API_KEY`, SMTP credentials.
- Media on an S3-compatible bucket (`STORAGE_DRIVER=s3`, `S3_*`) behind a CDN that passes CORS headers through (caption tracks need them).
- Migrations run on start (`MIGRATE_ON_START=true`, advisory-locked) or as a release step.
- Scrape `/metrics` with Prometheus (`infrastructure/monitoring/`), route alerts to on-call; point liveness at `/health/live` and readiness at `/health/ready`.
- Tracing: set `OTEL_EXPORTER_OTLP_ENDPOINT` to an OpenTelemetry Collector and `OTEL_TRACES_SAMPLER=parentbased_traceidratio` with a ratio (see [observability](observability.md)).

## Payments (Stripe)

The API refuses to start in production with the development payment provider. To take real payments:

1. In the Stripe dashboard, create a webhook endpoint for `https://<api-domain>/v1/payments/webhook/stripe` with the events `payment_intent.succeeded`, `payment_intent.payment_failed` and `charge.refunded`.
2. Set `PAYMENTS_PROVIDER=stripe`, `STRIPE_SECRET_KEY` (sk_live_…), `STRIPE_WEBHOOK_SECRET` (whsec_… from step 1) and `STRIPE_PUBLISHABLE_KEY` (pk_live_…). The API checks all three at start.
3. The web checkout loads Stripe.js and shows the Payment Element; card details go straight to Stripe. Orders are only marked paid by the signed webhook, so a payment confirmed in the browser but never reported by Stripe stays pending.

Amounts are stored in hundredths of the currency; for zero-decimal currencies (JPY, XOF, …) the adapter converts to and from Stripe's whole units. Try it end to end in test mode first (sk_test_/pk_test_ keys, `stripe listen --forward-to localhost:4000/v1/payments/webhook/stripe`).

## Payments in local currencies (Paystack)

Paystack takes NGN, GHS, KES and ZAR (cards, bank transfer and mobile money). It runs next to the default provider: orders in those currencies go to Paystack, everything else stays with `PAYMENTS_PROVIDER`. Refunds and webhooks go to whichever provider took the payment (`payments.provider`).

1. Set `PAYSTACK_SECRET_KEY` (sk_live_…) and `PAYSTACK_PUBLIC_KEY` (pk_live_…). The API refuses to start with only one of them.
2. In the Paystack dashboard, set the webhook URL to `https://<api-domain>/v1/payments/webhook/paystack`. Paystack signs each event with an HMAC SHA512 of the raw body using the secret key (`x-paystack-signature`); the API checks it before reading anything, handles `charge.success` and `refund.processed`, and only marks an order paid when the amount and currency match what it charged.
3. The web checkout opens Paystack's hosted page (`authorization_url`) in a new window, then waits for the webhook. Paystack sends people back to `{WEB_ORIGIN}/checkout/done`.

## Digital products

Files sellers upload for digital products are never public media. With `STORAGE_DRIVER=local` they are written to `PRIVATE_UPLOAD_DIR` (outside `UPLOAD_DIR`, which is served at `/media/`); with S3 they go under `private/` in the bucket, which the `/media/` route refuses. Buyers download through `/v1/downloads/<token>`, a link that works for 10 minutes and checks the order is still paid on every use. Back up `PRIVATE_UPLOAD_DIR` (or the bucket) with the rest of the media.

## Live video (MediaMTX)

- `LIVE_RTMP_URL` and `LIVE_HLS_BASE` point at MediaMTX; its `authHTTPAddress` points back at `/v1/live/hooks/auth?secret=<LIVE_HOOK_SECRET>`.
- `LIVE_CONTROL_URL` is MediaMTX's control API (keep it on a private network); ending a live uses it to disconnect the encoder.
- `LIVE_RECORDINGS_DIR` is where MediaMTX writes recordings (a volume shared with the API's job worker); leave it empty to turn off recordings and highlight clips.
