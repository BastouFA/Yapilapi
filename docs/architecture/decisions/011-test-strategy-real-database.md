# ADR 011: integration tests hit a real PostgreSQL; every test file starts from a pristine template

Status: accepted. Scope: `tests/`, `apps/*/test`

## Decision

- Integration tests use the real database and the real Fastify app (`app.inject`), never mocks of our own code. Only external providers are faked.
- `tests/setup/global-setup.ts` creates a private database (name must contain `test`), applies all migrations and freezes the result as a template; `tests/setup/per-file-db.ts` recreates the database from that template before every test file. Files therefore cannot leak rows, feature-flag changes or ledger entries into each other, and are order-independent. Parallel runs must use different `TEST_DATABASE_URL`s.
- Layers: unit (`*.test.ts` in packages, `*.unit.test.ts` in apps), integration (API), component (web/admin/mobile), Playwright E2E + axe accessibility, AI evals, and invariant tests (ledger balance, no raw card data, cross-user leakage).

## History

Before the per-file template, a shared database let one file's data break another file's exact-list assertions. That was fixed here rather than by loosening assertions.
