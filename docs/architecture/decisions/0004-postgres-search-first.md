# 0004: Postgres search first

**Status:** accepted, 2026-09-25

**Decision.** Universal search runs on Postgres generated `tsvector` columns, GIN indexes and trigram matching, with a rule-based natural-language intent parser in front.

**Why.** It is transactionally consistent with writes and reuses the exact visibility predicates, so search can't leak private content. At current scale it is fast enough.

**Consequences.** `apps/api/src/modules/search.ts` is the only search backend. Moving to OpenSearch means indexing from change events and replacing those queries, keeping the visibility filter as a post-filter on ids.
