# YAPILAPI engineering guide: building an API module

Read this before adding or changing anything under `apps/api`. It is the contract that keeps 20+ modules consistent and secure.

## Repository map

- `apps/api/src/modules/<name>/index.ts` exports an `ApiModule` (`{ name, register(app, ctx) }`) and is listed in `apps/api/src/modules/index.ts`.
- `apps/api/src/lib/*` shared infrastructure: `route.ts` (the route helper), `session.ts`, `audit.ts`, `notify.ts`, `visibility.ts`, `post-view.ts`, `moderation-hook.ts`, `community-access.ts`, `users.ts`, `flags.ts`, `pubsub.ts`, `rate-limit.ts`, `email.ts`, `hooks.ts`.
- `packages/*`: `shared` (errors, pagination, domain constants), `security` (scrypt, AES-GCM, TOTP, HMAC), `config`, `database` (pool, migrator), `moderation`, `recommendations`. Cross-app logic that has no HTTP or DB dependence lives in packages and has unit tests next to it (`src/*.test.ts`).
- SQL is written by hand (`pg`), parameterised, in the module that owns the table. **Never** build SQL by concatenating user input. Only interpolate identifiers/fragments you control (constants).

## Writing a route

```ts
route(app, ctx, {
  method: 'POST', url: '/v1/things', summary: '...', tags: ['things'],
  auth: 'user',                       // 'public' | 'optional' | 'user' | { staff: ['moderator','admin','superadmin'] }
  body: z.object({...}),              // zod schemas for params/query/body; unknown keys are stripped
  rateLimit: { limit: 30, windowSec: 3600, by: 'user' },
  handler: async ({ auth, req, reply, params, query, body }) => { ... return json; }   // return undefined => 204
});
```

Pipeline order (enforced by the helper): authentication -> staff role + MFA check -> rate limit -> zod validation -> handler.
The handler is responsible for **resource-level authorization** (ownership, membership, visibility, blocks). Never trust anything the client says about who they are or what they may do.

Errors: `throw new AppError(code, message)` or helpers `notFound() / forbidden() / conflict() / invalid()` from `@yapilapi/shared`. For resources the caller may not see, respond **404, not 403** (never reveal existence). Unique-violation DB errors already map to 409 in the global error handler.

## Non-negotiable security rules

1. Never commit secrets or hardcode credentials. Configuration comes from `@yapilapi/config` (`ctx.config`). Add new env vars to `packages/config/src/index.ts` **and** `.env.example`.
2. Never log passwords, tokens, or payment data. Use `redact()` for anything object-shaped. Audit metadata is redacted automatically but must still never include secrets.
3. Never bypass authorization "for convenience" and never disable a check to make a test pass.
4. Every protected endpoint: authenticated, authorized, validated, rate limited (writes/expensive reads), business-rule checked, audited where it changes money, access, safety state or privacy (`audit()` from `lib/audit.ts`).
5. Every query that returns user content to a viewer must use the central predicates in `lib/visibility.ts` (`postVisibleSql`, `momentVisibleSql`, `loadVisiblePost`) and block checks (`isBlockedEitherWay`). Do not re-implement visibility.
6. Do not store raw card data. Payments go through the provider abstraction (`@yapilapi/payments`).
7. AI never publishes, sends, buys or deletes on its own; it produces drafts (`ai_artifacts`) that a human confirms through the normal endpoints. AI context must be built from data the _requesting user_ is authorised to see.
8. No fake features. If something cannot really work in this environment, gate it behind a feature flag (`ctx.flags.require('FLAG', userId)`) and document what is missing. No "Coming soon" UI, no stubs that pretend to succeed.
9. Minors (`auth.ageBand === 'teen'`) get stricter defaults; do not weaken them.

## Data & migrations

- Schema is in `packages/database/migrations/NNN_*.sql` (001-007 exist). **Do not edit existing migration files.** Add new migrations using the number range assigned to your module (e.g. `110_messaging_indexes.sql`); the migrator applies files in filename order and records checksums.
- Use uuid PKs, timestamptz, CHECK constraints (not enums), partial indexes for hot paths, `deleted_at` soft deletes for user content, transactions (`withTransaction`) for multi-statement writes, `ON CONFLICT` for idempotency.
- Denormalised counters are updated in the same transaction as the change.
- Pagination: keyset cursors (`encodeCursor/decodeCursor`, `clampLimit`) — no OFFSET on user-visible lists.
- Modules that own personal data register a deletion hook (`registerDeletionHook`) so account deletion can anonymise/remove it.

## Testing (mandatory, real database)

- Integration tests go in `apps/api/test/<module>.test.ts`, use `createTestApp()` / `signup()` / `Client` from `apps/api/test/helpers.ts`, and hit the real HTTP pipeline through `app.inject` against a real PostgreSQL. **No mocking of the database or of our own modules.**
- Test both allowed and forbidden paths: unauthenticated, wrong user, blocked user, teen account, invalid input, replay/idempotency, rate-limit-relevant paths.
- **Use a private test database** so parallel runs do not clobber each other:
  `TEST_DATABASE_URL=postgres://yapilapi:yapilapi_dev_password@127.0.0.1:5432/yapilapi_test_<yourmodule> npx vitest run --project integration apps/api/test/<yourmodule>.test.ts`
  (the database is created automatically; the name must contain `test`). Never use `yapilapi_dev`.
- Pure logic (scoring, parsing, state machines) belongs in a `packages/*` or `src/*.unit.test.ts` unit test: `npx vitest run --project unit <path>`.
- Typecheck with `npx tsc -p apps/api/tsconfig.json` (other in-progress modules may show unrelated errors: fix only yours).

## Practicalities for parallel work

- Only edit files you own, plus: add your module to `apps/api/src/modules/index.ts` (one import + one array entry), add env vars to config/.env.example, and add migrations in your range.
- Run `npm install` only through `flock /tmp/yl-npm.lock npm install <pkg> -w <workspace>` (concurrent installs corrupt `node_modules`).
- Do not run `git commit`. Do not touch `yapilapi_dev`.
- i18n: user-facing strings from the API are limited to error messages; the web/mobile apps own translations. Return machine-readable codes where clients need to branch.
