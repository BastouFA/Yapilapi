# Deploying YAPILAPI on Render

The repository has a Render Blueprint (`render.yaml`) that creates everything the app needs in one go:

| Service | What it is | Plan | About |
| --- | --- | --- | --- |
| `yapilapi-api` | The API (Docker, `infrastructure/docker/api.Dockerfile`); applies database migrations when it starts | Starter | $7/month |
| `yapilapi-web` | The web app (Docker, `infrastructure/docker/web.Dockerfile`) | Starter | $7/month |
| `yapilapi-db` | Postgres 16 | Basic 256 MB | $6/month |
| `yapilapi-cache` | Key Value (Redis-compatible): realtime fan-out and rate limits | Starter | $10/month |

About $30/month to start, in Frankfurt (the closest Render region to West and East Africa). Prices are Render's at the time of writing; check the Dashboard.

## Before you start: three accounts

1. **Stripe** (payments). In test mode first: Developers > API keys gives `sk_test_…` and `pk_test_…`.
2. **Email** (verification and password reset). Resend is simplest: create an API key, verify your domain, then use `SMTP_URL=smtps://resend:<API key>@smtp.resend.com:465` and `EMAIL_FROM=YAPILAPI <hello@yourdomain.com>`.
3. **Photo and video storage** (S3-compatible). Cloudflare R2 has no download fees:
   - create a bucket, for example `yapilapi-media`;
   - create an R2 API token with read and write access to it;
   - note the S3 endpoint (`https://<account id>.r2.cloudflarestorage.com`), the access key id and the secret.
   The bucket stays private: the app serves media itself.

## Deploy

1. In Render: **New > Blueprint**, connect `github.com/BastouFA/Yapilapi`, branch `main`.
2. Render lists the services and asks for every setting marked `sync: false`:
   - `STRIPE_SECRET_KEY` and `STRIPE_PUBLISHABLE_KEY`, from Stripe;
   - `STRIPE_WEBHOOK_SECRET`: type `pending` for now and set it in step 4;
   - `SMTP_URL` and `EMAIL_FROM`;
   - `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`;
   - optional: `ANTHROPIC_API_KEY` (then set `AI_PROVIDER=anthropic`), `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`.
3. Click **Apply**. The first build takes about 10 minutes. The API is ready when `https://yapilapi-api.onrender.com/health/ready` answers `"status":"ready"`.
4. **Stripe webhook.** In Stripe, go to Developers > Webhooks and add the endpoint `https://yapilapi-api.onrender.com/v1/payments/webhook/stripe` (straight to the API, so the signed body arrives untouched) with the `payment_intent.succeeded`, `payment_intent.payment_failed` and `charge.refunded` events. Copy its signing secret (`whsec_…`) into `STRIPE_WEBHOOK_SECRET` on `yapilapi-api` (it's in the `yapilapi-secrets` group), then save; the API redeploys.
5. Open `https://yapilapi-web.onrender.com`, sign up, and check the verification email arrives.

If a service name is already taken on Render, it gets a different hostname. In that case, update these to match, then redeploy the web app (its three values are built into it):

- on `yapilapi-api`: `WEB_ORIGIN`, `PUBLIC_API_URL`, `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGIN`;
- on `yapilapi-web`: `API_INTERNAL_URL`, `NEXT_PUBLIC_WS_URL` and `SITE_URL`.

## Your own domain

Add `yapilapi.com` (or yours) to `yapilapi-web` and `api.yapilapi.com` to `yapilapi-api` under Settings > Custom Domains. Then:

- replace the `onrender.com` addresses listed above with your domain;
- update the Stripe webhook URL;
- redeploy both services.

## Making an admin

Sign up normally, then open Render's shell for `yapilapi-db` and run:

```sql
UPDATE users SET role = 'admin' WHERE email = 'you@example.com';
```

## Not included yet

- **Live video:** needs a MediaMTX server; it stays behind the `LIVE` feature flag. See docs/architecture for the setup.
- **Calls on strict networks:** need a TURN server (`TURN_URLS`, `TURN_SECRET`).
- **Mobile app:** build with EAS and set `extra.webUrl` and the API address in `apps/mobile/app.json` to the Render addresses.

## Checked locally

Both images were built and run with production settings:

- the API started, applied every migration and passed `/health/live` and `/health/ready`;
- the web app served `/`, `/login`, `/signup`, `/robots.txt` and its share image, and proxied `/api` to the API;
- no `.env` file ends up in either image (`.dockerignore`).
