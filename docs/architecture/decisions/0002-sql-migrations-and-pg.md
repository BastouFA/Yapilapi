# 0002: Plain SQL migrations and `pg`

**Status:** accepted, 2026-09-25

**Decision.** Schema changes are numbered `.sql` files in `packages/database/migrations`, applied in order by a small runner that takes an advisory lock and records each file in `schema_migrations`. Queries use `pg` with parameterized SQL.

**Why.** The visibility rules and feed ranking are expressed best in SQL; an ORM would hide them. Plain SQL keeps constraints, indexes and generated search columns explicit and reviewable.

**Consequences.** Never edit an applied migration; add a new one. Every query uses `$n` parameters; string interpolation is limited to fixed SQL fragments defined in code.
