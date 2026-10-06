# Deploying YAPILAPI on Render

## Free start

Everything below can start at no cost. Accounts you need, all free: GitHub (already there), Render,
Stripe (test mode), Resend and Cloudflare. Cloudflare asks for a card or PayPal to switch on R2 (photo
and video storage) but doesn't charge within its free allowance (10 GB stored, uploads and downloads
included). Nothing else asks for a card.

The free way differs from the checklist below in five places:

- **Step 4:** in **New > Blueprint**, set **Blueprint Path** to `render.free.yaml`. It creates the same
  services on Render's free plans.
- **Email without a domain:** until you buy a domain, use Resend's test sender: `EMAIL_FROM` =
  `YAPILAPI <onboarding@resend.dev>`. Resend then only delivers to the email address you signed up
  to Resend with, so sign up to YAPILAPI with that address. Add a domain (about 10 US dollars a year,
  for example from Cloudflare Registrar) before inviting anyone.
- **Email port:** free Render services can't use ports 25, 465 or 587, so `SMTP_URL` uses 2465:
  `smtps://resend:<API key>@smtp.resend.com:2465` (this works on paid plans too).
- **No Shell tab:** free services have none, so skip step 7, and do step 8 from your own computer:
  in Render open **yapilapi-db > Connect > External Connection**, copy the **External Database URL**,
  then with Docker Desktop running:

  ```bash
  docker run --rm postgres:16 psql "<External Database URL>" -c "UPDATE users SET role = 'admin' WHERE lower(email) = lower('you@example.com')"
  ```

  It prints `UPDATE 1`.
- **Limits:** the site sleeps after 15 minutes without visits (the next visit takes about a minute),
  and **the free database is deleted 30 days after it is created**. Before real people join, apply
  `render.yaml` instead (paid plans) and move the data, or start again there.

## Go live checklist

Do these in order. Steps 1 to 9 are needed for a working site; the rest are optional or can wait.
Every value you paste goes on Render, never in the code. The addresses below assume Render gives the
services their default names (`yapilapi-api.onrender.com`, `yapilapi-web.onrender.com`); if it shows
different ones, use those.

1. **Stripe keys** (required, test mode is fine to start). In the Stripe Dashboard, turn on
   **Test mode** (top right), then open **Developers > API keys**. Note the **Publishable key**
   (`pk_test_…`) and reveal the **Secret key** (`sk_test_…`). Take both from the same mode.
2. **Email** (required). With Resend: **Domains > Add domain**, enter your domain, and add every DNS
   record it shows at your domain registrar. Wait until the domain says **Verified**. Then
   **API Keys > Create API key** (sending access) and note it. You now have:
   - `SMTP_URL` = `smtps://resend:<the API key>@smtp.resend.com:2465`
   - `EMAIL_FROM` = `YAPILAPI <hello@yourdomain.com>` (any address on the verified domain)

   Another provider works the same way; `docs/operations/launch-setup.md` (section 1) has the details.
3. **Photo and video storage** (required). In Cloudflare: **R2 > Create bucket**, name it
   `yapilapi-media`, leave it private. Then **R2 > Manage R2 API Tokens > Create API token**, choose
   **Object Read & Write**, limit it to that bucket, and create it. Note the **Access Key ID**, the
   **Secret Access Key** and the S3 endpoint shown with them (`https://<account id>.r2.cloudflarestorage.com`).
4. **Create everything on Render.** In the Render Dashboard: **New > Blueprint**, connect
   `github.com/BastouFA/Yapilapi`, branch `main`. Render reads `render.yaml` and lists four resources
   (`yapilapi-api`, `yapilapi-web`, `yapilapi-db`, `yapilapi-cache`) with the settings it needs from you.
   Paste these on **yapilapi-api**:

   | Setting | What to paste | |
   | --- | --- | --- |
   | `STRIPE_SECRET_KEY` | `sk_test_…` from step 1 | required |
   | `STRIPE_PUBLISHABLE_KEY` | `pk_test_…` from step 1 | required |
   | `STRIPE_WEBHOOK_SECRET` | the word `pending` (step 6 replaces it) | required |
   | `SMTP_URL`, `EMAIL_FROM` | from step 2 | required |
   | `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | from step 3 | required |
   | `S3_BUCKET` | `yapilapi-media` | required |
   | `ANTHROPIC_API_KEY` | an Anthropic key, or empty (step 12) | optional |
   | everything else on the API | leave empty for now (step 12) | optional |

   On **yapilapi-web**, the `LEGAL_*` and `*_EMAIL` settings can stay empty until step 10.
   Secrets Render makes itself (`MFA_ENCRYPTION_KEY`, `TICKET_TOKEN_SECRET`, `LIVE_HOOK_SECRET`,
   `PAYMENTS_WEBHOOK_SECRET`), the database and the cache are filled in for you.
5. **Apply and wait.** Click **Apply**. The first build takes about 10 minutes. The database
   migrations run as the API's pre-deploy step. The API is up when
   `https://yapilapi-api.onrender.com/health/ready` shows `"status":"ready"`, and the site when
   `https://yapilapi-web.onrender.com` shows the YAPILAPI home page. If the API deploy fails, open
   **yapilapi-api > Logs**: the line before the exit says which setting is missing or wrong (see
   [If a deploy fails](#if-a-deploy-fails)).
6. **Stripe webhook** (automatic). With `STRIPE_WEBHOOK_SECRET` left as `pending`, the API sets up
   its own webhook in Stripe when it starts, with its secret key, for the events it handles, and
   keeps the signing secret encrypted in the database. Its log then says `Stripe webhook ready`, and
   **Developers > Webhooks** in Stripe lists "YAPILAPI (set up automatically by the API)". Nothing
   to paste. (To manage it yourself instead, add an endpoint for
   `https://yapilapi-api.onrender.com/v1/payments/webhook/stripe` with `payment_intent.succeeded`,
   `payment_intent.payment_failed`, `charge.refunded`, `charge.dispute.created` and
   `transfer.reversed`, and paste its `whsec_…` secret into `STRIPE_WEBHOOK_SECRET`.)
7. **Run the launch check.** In Render: **yapilapi-api > Shell**, then run

   ```bash
   cd /app/apps/api && node --import tsx scripts/launch-check.ts --send-email you@yourdomain.com
   ```

   It tests every service with the real keys and sends you one email. Fix every `FIX` line except
   these two, which are expected for now: "production is using a test key" (until step 13) and
   "Photo and video checks" (until you add Rekognition in step 12, before opening sign-ups to everyone).
8. **Sign up and make yourself admin.** Open `https://yapilapi-web.onrender.com`, sign up, and check
   the confirmation email arrives and its link works. Then in **yapilapi-api > Shell** run (with your
   email at the end):

   ```bash
   cd /app/apps/api && node -e 'const pg=require("pg");const c=new pg.Client(process.env.DATABASE_URL);c.connect().then(()=>c.query("UPDATE users SET role = $1 WHERE lower(email) = lower($2)",["admin",process.argv[1]])).then(r=>{console.log(r.rowCount+" account made admin");return c.end()})' you@yourdomain.com
   ```

   It prints `1 account made admin`. Sign out and in again.
9. **Check the API sees real addresses.** Sign in from a phone on mobile data, then on the web open
   **Settings > Security**: under "Login alerts and activity", that sign-in should show the phone's
   public address. If every device shows a `10.x` address or the same address, see
   [Real addresses behind Render's proxy](#real-addresses-behind-renders-proxy).
10. **Legal pages** (required before a public launch). In **yapilapi-web > Environment**, fill in
    `LEGAL_ENTITY_NAME`, `LEGAL_ADDRESS`, `LEGAL_JURISDICTION` (a phrase such as "the laws of
    Nigeria"), `SUPPORT_EMAIL`, `PRIVACY_EMAIL`, `COPYRIGHT_EMAIL` and `SAFETY_EMAIL`, then
    **Save and deploy**. Check `/legal/terms` shows them instead of bracketed placeholders.
11. **Your own domain** (optional, best done before inviting people: passkeys made on the
    `onrender.com` address don't move to a new domain). See [Your own domain](#your-own-domain).
12. **Optional services**, each added on **yapilapi-api > Environment** followed by
    **Save and deploy**, then checked with the launch check (step 7):
    - **AI helpers:** paste `ANTHROPIC_API_KEY` (set a monthly limit in the Anthropic console first).
      Nothing else to change.
    - **Photo and video checks** (recommended before opening sign-ups to everyone): an AWS IAM user
      allowed `rekognition:DetectModerationLabels`; paste `REKOGNITION_ACCESS_KEY_ID` and
      `REKOGNITION_SECRET_ACCESS_KEY`, and change `MEDIA_MODERATION_PROVIDER` to `rekognition`.
    - **Paystack** (mobile money and local cards in Nigeria, Ghana, Kenya and South Africa): paste
      `PAYSTACK_SECRET_KEY` and `PAYSTACK_PUBLIC_KEY` from Paystack's **Settings > API Keys &
      Webhooks**, both from the same mode, and on that page set the webhook URL to
      `https://yapilapi-api.onrender.com/v1/payments/webhook/paystack`. Creator payouts in those
      currencies come from your Paystack balance: turn on Transfers and turn off the one-time
      password for transfers (**Settings > Preferences**), or every payout waits for a code.
    - **Automatic captions:** an OpenAI API key in `TRANSCRIBE_API_KEY`, then change
      `TRANSCRIBE_PROVIDER` to `openai-compatible`. Another OpenAI-compatible speech-to-text service
      also works if it returns WebVTT: change `TRANSCRIBE_API_URL` and `TRANSCRIBE_MODEL` to its values.
    - **Phone confirmation by text:** a Twilio Verify service; paste `TWILIO_ACCOUNT_SID`,
      `TWILIO_AUTH_TOKEN` and `TWILIO_VERIFY_SERVICE_SID`, and change `SMS_PROVIDER` to `twilio`.
    - **Browser notifications:** run `npx web-push generate-vapid-keys` on your computer; paste
      `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` as `mailto:support@yourdomain.com`.
    - **Music from Jamendo:** `JAMENDO_CLIENT_ID` (read their terms first; see `docs/operations/music.md`).
    - **Creator payouts in dollars, euros and pounds:** in Stripe, **Settings > Connect**, turn on
      Connect with Express accounts and fill in the platform profile. Creators then set up their
      account from Studio, which checks it is ready each time they open it, so no extra webhook is needed.
13. **Real money** (when you are ready). Repeat steps 1 and 6 with Stripe's test mode off (`sk_live_…`,
    `pk_live_…`, a new live webhook and its `whsec_…`), paste the three values on yapilapi-api, and
    **Save and deploy**. Do the same for Paystack's live keys if you use it. Run the launch check again.
14. **The phone app on your own phones** (optional, once you have an Expo account, and an Apple
    Developer membership for the iPhone). The `preview` builds in `apps/mobile/eas.json` already
    point at `yapilapi-api.onrender.com` and `yapilapi-web.onrender.com`. Build and install them,
    set `APPLE_TEAM_ID` and `ANDROID_CERT_SHA256` on **yapilapi-web** so the site's links open the
    app, then go through the checklist of what only a real phone can prove (push, calls on mobile
    data, the microphone and cameras, links): [real-device-testing.md](real-device-testing.md).

Live video and calls on strict networks need servers Render can't run; they stay off until you set
them up ([Live video and the calls relay](#live-video-and-the-calls-relay)).

## What the Blueprint creates

| Service | What it is | Plan | About |
| --- | --- | --- | --- |
| `yapilapi-api` | The API (Docker, `infrastructure/docker/api.Dockerfile`), with the background jobs | Starter | $7/month |
| `yapilapi-web` | The web app (Docker, `infrastructure/docker/web.Dockerfile`) | Starter | $7/month |
| `yapilapi-db` | Postgres 16 | Basic 256 MB | $6/month |
| `yapilapi-cache` | Key Value (Redis-compatible): realtime fan-out and rate limits | Starter | $10/month |

About $30/month to start, in Frankfurt (the closest Render region to West and East Africa). Prices are
Render's at the time of writing; check the Dashboard.

How the pieces fit:

- **Migrations** run as the API's pre-deploy step, before a new version takes traffic. If one fails,
  the deploy stops and the running version keeps serving. The image also migrates on start, which is
  then a no-op (it matters for other hosts).
- **Health checks.** Render sends traffic to a new API only once `/health/ready` answers 200, which
  needs the database. The web app's check is `/login`.
- **Background jobs** (video processing, scheduled posts, payouts, clean-ups) run inside the API.
  Jobs are claimed with row locks, so more API instances can be added later without doubling work.
- **Cookies and addresses.** The browser only talks to the web address: `/api` and `/media` on the web
  app are passed to the API, so the session cookie is first-party and needs no cookie domain, also on
  your own domain. The realtime socket goes straight to the API with a short ticket. Photos and videos
  are served by the API from the private bucket, through the web app's `/media`.
- **Page security policy.** The web app allows scripts from itself and Stripe, images, video and
  connections from itself and any https address (a CDN or the live server, if you add one), and the
  realtime socket's origin from `NEXT_PUBLIC_WS_URL`. Nothing may frame the site.
- **Settings that are built in.** `API_INTERNAL_URL`, `NEXT_PUBLIC_WS_URL` and `SITE_URL` are read when
  the web app is built. After changing one, use **Save, rebuild, and deploy**.
- **Blank settings** count as unset everywhere, so an optional field left empty falls back to its
  default.

## If a deploy fails

The API checks its settings before it starts and stops with a sentence naming the problem. The common ones:

| Log says | Fix on yapilapi-api > Environment |
| --- | --- |
| `PAYMENTS_PROVIDER=stripe needs STRIPE_SECRET_KEY, …` | paste the three Stripe values (the webhook one can be `pending`) |
| `EMAIL_TRANSPORT=smtp needs SMTP_URL.` | paste `SMTP_URL` |
| `Set EMAIL_FROM for production …` | paste `EMAIL_FROM`, on your verified domain |
| `STORAGE_DRIVER=s3 needs S3_ACCESS_KEY_ID …` or `media bucket not reachable` | paste the R2 values; check the endpoint and bucket name |
| `Paystack needs both …`, `… needs both … or neither` | paste the missing half, or empty both |
| `Migration … failed` (pre-deploy) | nothing to paste: send the log line to a developer; the old version keeps running |

The web app's build only fails on code problems; send its log to a developer.

## Real addresses behind Render's proxy

The API reads the visitor's address from the header Render's proxy adds, and by default trusts only
proxies on private networks, so nobody can choose the address the API sees by writing the header
themselves. If step 9 shows private addresses, Render's proxy isn't on a private network for your
service: set `TRUST_PROXY` on `yapilapi-api` to the number of proxies in front of it (usually `1`) and
redeploy. Never set it to `true`. If you put Cloudflare in front of the site, also set
`TRUSTED_COUNTRY_HEADER=cf-ipcountry` on both services so regional rules know the visitor's country.

## Your own domain

1. **yapilapi-web > Settings > Custom Domains > Add**: `yapilapi.com` (and `www.yapilapi.com` if you
   want it). **yapilapi-api > Settings > Custom Domains > Add**: `api.yapilapi.com`. Add the DNS
   records Render shows at your registrar and wait for the certificates.
2. On **yapilapi-api > Environment**, then **Save and deploy**:
   - `WEB_ORIGIN=https://yapilapi.com` (add `,https://www.yapilapi.com` if you use both)
   - `PUBLIC_API_URL=https://yapilapi.com`
   - `WEBAUTHN_RP_ID=yapilapi.com`
   - `WEBAUTHN_ORIGIN=https://yapilapi.com`
3. On **yapilapi-web > Environment**, then **Save, rebuild, and deploy**:
   - `API_INTERNAL_URL=https://api.yapilapi.com`
   - `NEXT_PUBLIC_WS_URL=wss://api.yapilapi.com/v1/realtime`
   - `SITE_URL=https://yapilapi.com`
4. Change the Stripe webhook URL (and Paystack's, if used) to `https://api.yapilapi.com/…`.
5. Run the launch check: "Public addresses", "Passkeys" and "Web app to API" should say `ok`.
6. Phone apps: change `YAPILAPI_API_URL` and `YAPILAPI_WEB_URL` in `apps/mobile/eas.json` (the
   `preview` and `production` profiles) to `https://api.yapilapi.com` and `https://yapilapi.com`, and
   build again. Phones already installed keep talking to the old addresses until they update, so keep
   the `onrender.com` addresses working until then (Render keeps them alongside a custom domain).

The same applies if a service name was taken and Render gave a different `onrender.com` address.

## Live video and the calls relay

Both stay off on a plain Render deploy; everything else works without them.

- **Live video** needs MediaMTX (`infrastructure/media/mediamtx.yml`), which takes RTMP from
  streaming apps. Render only routes web traffic, so run it on a small server with a public address
  (any VPS, or Fly.io). Serve its HLS port over https (for example `https://live.yapilapi.com`
  through a reverse proxy) and set on yapilapi-api: `LIVE_RTMP_URL=rtmp://live.yapilapi.com:1935`,
  `LIVE_HLS_BASE=https://live.yapilapi.com`. In `mediamtx.yml`, point `authHTTPAddress` at
  `https://api.yapilapi.com/v1/live/hooks/auth?secret=<LIVE_HOOK_SECRET>`, copying the value from
  yapilapi-api's Environment and writing `+` as `%2B`, `/` as `%2F` and `=` as `%3D`. Leave
  `LIVE_RECORDINGS_DIR` empty (recordings need a folder shared with the API). Then turn on the
  `LIVE` feature flag in the admin area.
- **Calls relay (TURN)** helps calls connect on networks that block direct connections. It needs UDP,
  which Render doesn't offer: run coturn with `infrastructure/media/turnserver.conf` on a small server
  (change `static-auth-secret` and `realm`), open UDP 3478 and 51160–51200, and set on yapilapi-api
  `TURN_URLS=turn:turn.yapilapi.com:3478?transport=udp,turn:turn.yapilapi.com:3478?transport=tcp` and
  `TURN_SECRET` to the same secret. Without it, most calls still connect.

## Phone apps

The phone builds take the server addresses from `apps/mobile/eas.json` (`YAPILAPI_API_URL` and
`YAPILAPI_WEB_URL` in the `preview` and `production` profiles), which point at
`https://yapilapi-api.onrender.com` and `https://yapilapi-web.onrender.com`. Building and submitting
is in `docs/operations/app-store.md`; installing on your own phones and what to test there is in
[real-device-testing.md](real-device-testing.md).

## Checked locally

A production dry run on one machine (October 2026), with `APP_ENV=production` and the Blueprint's
settings (stand-in keys, a local SMTP sink, local S3 storage):

- the pre-deploy migration command applied every migration to an empty database, and the API started
  with `node --import tsx src/server.ts`, refusing to start with a clear message whenever a required
  setting was blank;
- `/health/live` and `/health/ready` answered, and the launch check reached the database, Redis, SMTP
  and the bucket, and the API through the web app's `/api`;
- the web app (a production build) served the home page, sign-up, sign-in, legal pages, `robots.txt`
  and the sitemap with no security policy violations or failed requests;
- an account signed up through the form, got its confirmation email and confirmed it; a photo
  uploaded through `/api` loaded back through `/media`; the realtime socket connected with a ticket;
  the session cookie was `Secure`, `HttpOnly` and `SameSite=Lax`.

Not covered locally: the Docker images themselves (an earlier check built and ran both), Render's own
build, and the real Stripe, email and R2 accounts, which the launch check (step 7) tests after deploy.
