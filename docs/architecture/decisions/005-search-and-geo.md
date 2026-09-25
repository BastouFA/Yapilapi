# ADR 005: PostgreSQL full-text search and haversine now; OpenSearch and PostGIS behind adapters

Status: accepted. Scope: `packages/search`, discovery and local feeds

## Decision

- Search ships on PostgreSQL (generated `tsvector` columns, `pg_trgm` for fuzzy usernames). The `SearchBackend` interface has an OpenSearch implementation selected with `SEARCH_BACKEND=opensearch`; on any OpenSearch error the API logs and falls back to Postgres.
- Local feeds and nearby events/places use haversine in SQL over plain latitude/longitude columns. PostGIS is deferred until scale needs spatial indexes.
- Natural-language search is a deterministic intent parser that maps text to the same structured filters (no LLM needed for correctness).

## Why

Zero extra infrastructure for the first launch, with the mandated OpenSearch-compatible architecture already in place and tested against a stub. The OpenSearch adapter has not been run against a real cluster in this repository's test suite.
