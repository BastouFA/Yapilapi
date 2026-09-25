# Search

Package `@yapilapi/search` (engine) and `apps/api/src/modules/search` (HTTP, visibility, history).

## Core rule: the backend only proposes, Postgres decides

A `SearchBackend` returns ranked candidates `(id, score)` and nothing else. The API then re-checks every
id against the authoritative Postgres guards (`modules/search/guards.ts`) twice: inside the candidate
query (Postgres backend) and again while hydrating the rows returned to the client. An index that is
stale, misconfigured or leaking therefore cannot show a viewer something they may not see.

Guards (single source of truth, reused by discover):

| Entity                       | Rule                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| people / creators            | active, not blocked either way, self or (discoverable or friend) and teen rule                                      |
| teens                        | visible only to self, friends, active followers/followees, active guardians, other teens; never to unrelated adults |
| posts / videos               | `postVisibleSql` plus the teen-author rule; nothing else                                                            |
| communities                  | secret only for active/invited members, private = summary only, banned hidden                                       |
| events                       | public / followers / friends / community / private (attendees, invitees, organizers); published only                |
| businesses, products, places | active/published, visible seller, not deleted; products also need the COMMERCE flag                                 |
| topics                       | viewer topic mutes                                                                                                  |

## Backends (`SEARCH_BACKEND=postgres|opensearch`)

- `PostgresSearchBackend` (default): `websearch_to_tsquery('simple')` + `ts_rank_cd`, `pg_trgm`
  `similarity` on names, ILIKE contains/prefix bonus, topic match, viewer-interest boost, log popularity,
  recency half-life (events: time until start), distance and price bonuses. Scores are rounded to 6
  decimals; pagination is keyset on `(score, id)` with a fixed snapshot timestamp per session. Cursors
  work with exactly one type.
- `OpenSearchBackend`: fetch-based adapter (Basic auth from the URL or ApiKey), strict mappings, bulk
  indexing, search and suggest bodies. It is **not verified against a live cluster**; only request
  construction is unit-tested (`opensearch.test.ts`). The index holds only public / community content and no
  audience data. `FallbackSearchBackend` falls back to Postgres when OpenSearch errors.
  Reindex: page `fetchDocuments(db, type, afterId, limit)` into `OpenSearchBackend.bulk`.
- Migration `140_search_discover.sql`: `search_history` and trigram/recency indexes (all prefixed `search_`).

## Intent parser (no LLM)

`parseIntent(query, {now, timeZone, topics})` is pure and deterministic. It extracts entity types,
keywords, topics, time window (tonight, today, this weekend, next week, resolved in the viewer's time
zone; weekend = Fri 18:00 to Mon 00:00), party size, near me, price hint and place kinds
("cheap sushi tonight for 4 near me"). Quotes, `-exclusions`, `@handle` and `#tag` pass through as raw
syntax. Natural-language mode matches ANY keyword; plain keyword mode matches ALL. If natural language
returns nothing it retries as plain keywords (`interpretedAs.fellBack`). An explicit `types=` overrides
the parser. The `IntentParser` type is the seam for a future LLM router.

## API

`GET /v1/search`, `/v1/search/suggest`, `GET|DELETE /v1/search/history`. Response carries
`interpretedAs` so clients can show what was understood. History is recorded only for adults with
`user_preferences.personalization` on, capped at 50 rows and 90 days, and clearing is audited.
