# ADR 004: domain logic lives in API modules, not in per-domain packages

Status: accepted. Scope: `apps/api/src/modules/*`, `packages/*`

## Decision

Each domain (auth, graph, content, feed, messaging, communities, media, moments, search, discover, events, places, business, commerce, payments, safety, privacy, notifications, admin, analytics, developer, ai, creator, studio, live, ads, real, together, memory) is one API module that owns its routes, SQL and business rules and receives an explicit `AppContext` (no globals). `packages/*` hold only code that is genuinely shared or must stay framework-free and unit-testable: shared types/errors/constants, security primitives, recommendation scoring, moderation classifier, search backends, payment providers, AI providers/router/safety.

## Why

Splitting SQL-heavy domain code into packages that need the same database handle and visibility predicates adds indirection without reuse. The module guide (`docs/architecture/module-guide.md`) is the contract that keeps modules consistent. Cross-module effects go through registries (deletion hooks, export sections, notification policy), never direct imports of another module's tables.

## Consequences

The API is a modular monolith. A module can be extracted into a service later along the registry boundaries. Empty placeholder package directories were removed.
