# ADR 002: Fastify + zod + raw SQL (no ORM)

Status: accepted. Scope: `apps/api`, `packages/database`

## Context

The directive requires a TypeScript/Node backend on PostgreSQL. Authorization correctness is the highest-risk area: visibility (blocks, private accounts, teen defaults, moderation state) has to be applied in the query, not after it.

## Decision

- Fastify 5 for HTTP, zod 4 for validation, and the OpenAPI document is derived from the same zod schemas (`npm run openapi` -> `docs/api/openapi.json`), so docs cannot drift from validation.
- Plain SQL through `pg`. Visibility rules live in a handful of reusable SQL predicates (`lib/visibility.ts`) that every content query composes. An ORM would hide the SQL where the security-relevant joins live and make them harder to review.
- Every route goes through one helper (`lib/route.ts`): authentication -> rate limit -> validation -> handler. Resource-level authorization is the handler's responsibility and is covered by per-module authorization-matrix tests.
- Schema is managed by ordered, checksummed SQL migrations (`packages/database/migrations`, immutable once applied, advisory-locked runner).

## Consequences

Hand-written SQL costs more typing and needs the real-database test suite (ADR 011) for confidence. In return, query plans, indexes and authorization joins are explicit. A typed query builder can be introduced per module later without changing the route contract.
