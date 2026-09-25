# Architecture decisions

| ADR | Decision |
| --- | --- |
| [0001](0001-modular-monolith-api.md) | One modular Fastify API instead of microservices |
| [0002](0002-sql-migrations-and-pg.md) | Plain SQL migrations and `pg`, no ORM |
| [0003](0003-sessions-not-jwt.md) | Opaque server-side sessions instead of JWTs |
| [0004](0004-postgres-search-first.md) | Postgres full-text search first, OpenSearch later |
| [0005](0005-provider-agnostic-ai-gateway.md) | Provider-agnostic AI gateway with authorization before context |
| [0006](0006-admin-inside-web.md) | Admin console inside the web app, not a separate app |
| [0007](0007-typescript-source-packages.md) | Workspace packages ship TypeScript source |
