# Placeholders in the legal pages

Every bracketed placeholder the owner must fill in before launch, as of 2026-09-27. Answer the decisions with the lawyer; the questions behind them are in [review-pack.md](review-pack.md).

## Settings on the web service

The pages read these on each request, so changing them doesn't need a rebuild. `render.yaml` lists them. Until one is set, the pages show its placeholder.

| Placeholder shown | Setting | What to put | Used in |
| --- | --- | --- | --- |
| `[Company legal name]` | `LEGAL_ENTITY_NAME` | The registered name of the company that runs YAPILAPI | Terms, privacy, copyright |
| `[Registered address]` | `LEGAL_ADDRESS` | Its registered postal address | Terms, privacy, copyright |
| `[Governing law]` | `LEGAL_JURISDICTION` | A phrase that fits "These terms are governed by …", for example "the laws of Nigeria" | Terms, section 14 |
| `[support email address]` | `SUPPORT_EMAIL` | An inbox someone reads | Terms, creator terms |
| `[privacy email address]` | `PRIVACY_EMAIL` | The inbox for privacy requests (answered within one month, as the policy promises) | Privacy, cookies |
| `[copyright email address]` | `COPYRIGHT_EMAIL` | The inbox for takedown notices and counter-notices | Copyright |
| `[safety email address]` | `SAFETY_EMAIL` | The inbox for safety reports, under-13 reports and law enforcement | Privacy, safety, guidelines |

## Text in the page source

Replace these in `apps/web/app/legal/*/page.tsx`. They have no settings behind them. When a page changes, update `LEGAL_UPDATED` in `packages/shared/src/legal.ts`, which is the "Last updated" date on every page.

| Placeholder | Page and section | What to decide |
| --- | --- | --- |
| `[Legal bases to be confirmed by counsel for each country.]` | Privacy, section 2 | The legal basis for each purpose (review pack, question 2) |
| `[Confirm Anthropic’s retention and model-training terms for your account.]` | Privacy, "AI features" | What Anthropic keeps and whether it trains on the data, from your agreement with Anthropic |
| `[Speech-to-text provider]` (twice) | Privacy, "AI features" and section 3 | The automatic-captions provider, or remove the sentences if `TRANSCRIBE_PROVIDER` stays `none` |
| `[Hosting providers]` | Privacy, section 3 | Who hosts the servers, database, cache (Redis) and file storage, for example Render and an S3-compatible store |
| `[Email provider]` | Privacy, section 3 | The SMTP relay behind `SMTP_URL` |
| `[CDN provider]` | Privacy, section 3 | The network provider in front of the site, whose country header is `TRUSTED_COUNTRY_HEADER` |
| `[Tracing provider]` | Privacy, section 3 | Where OpenTelemetry traces go (`OTEL_EXPORTER_OTLP_ENDPOINT`), or remove the sentence if tracing stays off |
| `[Server region]` | Privacy, section 4 | The country or region where the servers and data are |
| `[Transfer safeguards to be confirmed by counsel.]` | Privacy, section 4 | The transfer mechanism for each origin country (review pack, question 21) |
| `[Owner to confirm how long.]` | Privacy, section 5 | How long a deleted seller's digital-product files stay available to buyers |
| `[Owner to confirm the period with an accountant for each launch country.]` | Privacy, section 5 | How long payment, refund and payout records must be kept (7 years by default). Set `FINANCIAL_RECORDS_YEARS` in the API settings and change the text to match |
| `[Data protection officer and EU or UK representative, if required.]` | Privacy, section 11 | Their names and contact details, or remove the note if none is required |
| `[Refund rules for Plus.]` | Terms, section 7 | Whether and when Plus is refunded |
| `[Consumer cancellation rights and how to exercise them, by country.]` | Terms, section 7 | Withdrawal or cooling-off rights and how a buyer uses them (review pack, question 15) |
| `[How long buyers keep access after a seller leaves.]` | Creator terms, section 7 | Same decision as "Owner to confirm how long" in the privacy policy |
| `[Minimum refund rules sellers must offer.]` | Creator terms, section 8 | Any refund rules every seller must follow, beyond the law |
| `[Payout method, currencies, minimum amount and timing.]` | Creator terms, section 9 | How payouts are paid, in which currencies, the minimum and how long they take |
| `[U.S. designated copyright agent, if you serve the United States.]` | Copyright, "How to send a takedown notice" | The agent registered at dmca.copyright.gov, or remove it if the U.S. isn't served |
| `[Counter-notice court jurisdiction]` | Copyright, "If your content was removed" | Which courts a counter-notice consents to, for users in and outside the U.S. |
| `[Child safety reporting organisations, for example NCMEC]` | Safety, "Child sexual abuse material" | The organisations you report to for each launch country |
| `[Helplines for each launch country.]` | Safety, "If someone is in danger" | Crisis lines and child helplines for each launch country |

## Values stated in the pages that come from code

These aren't placeholders, but if you change them, change the text too.

| Value | Where it comes from | Pages |
| --- | --- | --- |
| Plus: 4.99 US dollars for 30 days | `PLUS_PRICE_CENTS`, `PLUS_CURRENCY` (API settings) | Terms, section 7 |
| Platform fee 5% | `PLATFORM_FEE_PERCENT` in `packages/shared/src/legal.ts` (and `PLATFORM_FEE_BPS` in `packages/shared/src/constants.ts`) | Creator terms |
| Payment processing on top of the fee (decided 2026-09-28) | `PROCESSING_FEES` in `packages/shared/src/constants.ts` (the providers' standard rates) | Creator terms, section 3 |
| Retention periods | `RETENTION` in `apps/api/src/lib/retention.ts` (payment records: `FINANCIAL_RECORDS_YEARS`) | Privacy, section 5 |
| Drop hold of 15 minutes | `DROP_HOLD_MINUTES` in `packages/shared/src/drops.ts` | Terms, creator terms, privacy |
| Session cookie of 30 days | `SESSION_TTL_DAYS` | Cookie notice |
