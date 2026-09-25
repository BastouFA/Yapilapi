# 0001: One modular API

**Status:** accepted, 2026-09-25

**Context.** YAPILAPI has 35 domains that share users, visibility rules and moderation. Early on, most requests touch several domains (a post links a community, an event and a product).

**Decision.** Build one Fastify service with a module per domain (`apps/api/src/modules/*`). Modules share the database and a small set of services (audit, notify, track, flags) but not each other's internals.

**Consequences.** One deploy, one transaction boundary, simple local development. When a domain needs to scale on its own (media processing, live, search indexing) it moves to a worker that consumes the same database or a queue, without changing the public API.
