# YAPILAPI API

Base URL: `http://localhost:4000` in development. The web app proxies it at `/api`. Every endpoint is listed, with its access level and rate limit, in [routes.md](routes.md) (generated from the code: `pnpm --filter @yapilapi/api docs:routes`). Request schemas are the zod schemas in `packages/shared/src/schemas.ts`; response types are in `packages/shared/src/types.ts`.

## Authentication

- **Web:** `POST /v1/auth/login` or `/v1/auth/register` sets an httpOnly, SameSite=Lax cookie `ypl_session`.
- **Mobile and servers:** the same calls return `token`; send it as `Authorization: Bearer <token>`. Send `x-client-platform: mobile` so the device is labelled correctly.
- Sessions last `SESSION_TTL_DAYS` (default 30) and can be listed and revoked at `/v1/auth/sessions`.

```bash
curl -s localhost:4000/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"dev_amara@dev.yapilapi.local","password":"dev-password-123"}'
```

## Errors

Every error has the same shape and a request id you can quote in support:

```json
{ "error": { "code": "validation_failed", "message": "Check the highlighted fields.", "details": { "fields": { "password": "Use at least 10 characters." } }, "requestId": "…" } }
```

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `validation_failed`, `bad_request`, `invalid_json` | Fix the request; `details.fields` names each field |
| 401 | `unauthorized` | No valid session |
| 403 | `forbidden`, `minor_protection`, `account_suspended`, `consent_required` | Authenticated but not allowed |
| 404 | `not_found`, `feature_disabled` | Doesn't exist **or isn't visible to you** (private content never returns 403, so its existence isn't revealed) |
| 409 | `conflict`, `out_of_stock` | Duplicate or state conflict |
| 413 / 415 | `too_large`, `unsupported_media` | Upload rejected |
| 422 | `content_blocked` | Safety filters refused the content |
| 429 | `rate_limited` | Slow down; the message says when to retry |

## Pagination

List endpoints return `{ items, nextCursor }`. Pass `?cursor=<nextCursor>` for the next page; `nextCursor: null` means the end. Cursors are opaque. The For You feed pins its candidate window at the first page so pages don't shift while you scroll.

## Idempotency

- `POST /v1/orders` requires `idempotencyKey`; repeating it returns the original order with `replayed: true`.
- `POST /v1/conversations/:id/messages` accepts `clientId`; retries with the same value don't create duplicates.
- Payment webhooks are processed once per provider event id.

## Realtime

Connect to `ws://<api>/v1/realtime` with the session cookie or `?token=`. The server sends `{ "type": "ready" }`, then events: `message.created`, `message.deleted`, `message.reaction`, `typing`, `conversation.created`, `plan.created`, `notification.created`. Send `{ "type": "typing", "conversationId": "…" }` or `{ "type": "ping" }`.

## Webhooks (payments)

`POST /v1/payments/webhook/:provider` with header `x-signature: <HMAC-SHA256 of the raw body using PAYMENTS_WEBHOOK_SECRET>`. Events: `payment.succeeded`, `payment.failed`, `refund.succeeded`. The captured amount must match the order, or the event is logged to the audit trail and ignored.

## AI

`POST /v1/ai/assist` with `task` one of `caption`, `summarize_conversation`, `summarize_community`, `search_intent`, `plan_from_message`, `translate`. Responses include `provider`, `model`, `contextScopes` (the data the model was allowed to read) and a `notice` when the offline dev provider answered.
