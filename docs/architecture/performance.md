# Performance and load testing

## Running it

```bash
pnpm infra:up      # Postgres + Redis
pnpm load          # ~3 minutes: reset load DB, start API, seed, run every scenario
```

`pnpm load` (`apps/api/load/run.ts`) never touches the development database:

1. It drops and re-migrates a scratch database, `LOAD_DATABASE_URL` (default `postgres://postgres:postgres@localhost:5432/yapilapi_load`). It refuses any database whose name doesn't contain `load`, `perf` or `test`.
2. It starts the API as a separate process on `LOAD_PORT` (default 4100, and it refuses to start if something already answers there), with Redis database 13, so the load generator never shares an event loop with the server. The API runs with `APP_ENV=test`, which lifts per-user rate limits (otherwise the limiter is what gets measured) and turns off background workers.
3. It seeds through the public API (`apps/api/load/seed.ts`): 500 adult users with interests and ad consent, 25 follows and 5 friendships each, 15 posts each (7,500), 30 likes and 5 comments each, feed feedback, 3 direct conversations each with 6 messages, and 50 paid, active ad campaigns. Only the `ADS` feature flag and the payment reference used to sign the dev payment webhook come from the database directly, because no public endpoint exposes them.
4. For each scenario it runs a 3 s warm-up, then 15 s with 16 connections, every request as a different random seeded user, and reports latency percentiles computed from every response.

| Variable           | Default                   | Meaning                                                     |
| ------------------ | ------------------------- | ----------------------------------------------------------- |
| `LOAD_DATABASE_URL`| `.../yapilapi_load`       | Scratch database, reset on every run                        |
| `LOAD_REDIS_URL`   | `redis://localhost:6379/13` | Redis for the API under test (empty: none)                |
| `LOAD_PORT`        | `4100`                    | Port for the API under test                                 |
| `LOAD_CONNECTIONS` | `16`                      | Concurrent connections per scenario                         |
| `LOAD_DURATION`    | `15`                      | Measured seconds per scenario                               |
| `LOAD_USERS`       | `500`                     | Seeded users (everything else scales with it)               |
| `LOAD_ONLY`        | all                       | Comma-separated scenario names, e.g. `home feed,ads next`   |
| `LOAD_OUT`         | none                      | Also write results as JSON                                  |
| `LOAD_TRACING`     | none                      | OTLP endpoint: run the API with tracing on                  |

The command exits non-zero when a scenario misses its target or returns errors, so it can gate a release pipeline on a dedicated machine. It is not part of CI: shared CI runners are too noisy for latency targets.

To find slow queries after a run, `pnpm --filter @yapilapi/api load:explain` builds the API in-process against the seeded database, times every query the hot endpoints run as 20 seeded users, and prints the slowest statements with `EXPLAIN (ANALYZE, BUFFERS)` for the worst call of each.

## Targets (SLOs)

p95 latency at 16 concurrent connections against the seeded dataset, with zero errors. These are the budgets the web and mobile apps are designed around (the home screen makes the feed, notifications and ad calls in parallel).

| Scenario              | Route                                  | p95 target |
| --------------------- | -------------------------------------- | ---------: |
| Home feed (For You)   | `GET /v1/feed`                         | 250 ms     |
| Home feed (Following) | `GET /v1/feed?mode=following`          | 150 ms     |
| Discover search       | `GET /v1/search?q=…`                   | 250 ms     |
| Notifications list    | `GET /v1/notifications`                | 100 ms     |
| Sponsored slot        | `GET /v1/ads/next`                     | 100 ms     |
| Post create           | `POST /v1/posts`                       | 150 ms     |
| Message send          | `POST /v1/conversations/:id/messages`  | 100 ms     |

In production, alert on the same numbers from `/metrics` (per-route latency) or from traces.

## Results

Measured 2026-09-25 on an Apple M4 (10 cores, 16 GB), Node 26.5, Postgres 16 and Redis 7 in Docker Desktop, API and load generator on the same machine. Dataset: 500 users, 7,500 posts, 12,979 follows, 2,984 friendships, 15,000 reactions, 9,000 messages, 36,407 notifications.

### After the fixes below

| Scenario              | Requests | Req/s | p50 ms | p95 ms | p99 ms | max ms | Errors | Target | Meets |
| --------------------- | -------: | ----: | -----: | -----: | -----: | -----: | -----: | -----: | ----- |
| Home feed (For You)   |    5,911 |   394 |   38.7 |   56.2 |   72.2 |  126.6 |      0 |    250 | yes   |
| Home feed (Following) |   25,538 | 1,703 |    8.9 |   12.8 |   18.3 |   50.3 |      0 |    150 | yes   |
| Discover search       |   11,067 |   738 |   18.0 |   49.3 |   71.2 |  150.2 |      0 |    250 | yes   |
| Notifications list    |   52,387 | 3,492 |    4.3 |    6.6 |   10.1 |   90.2 |      0 |    100 | yes   |
| Sponsored slot        |   16,505 | 1,100 |   13.8 |   18.5 |   25.2 |  214.6 |      0 |    100 | yes   |
| Post create           |   25,886 | 1,726 |    8.6 |   13.2 |   21.0 |  122.7 |      0 |    150 | yes   |
| Message send          |   15,581 | 1,039 |   13.5 |   24.3 |   45.0 |  262.1 |      0 |    100 | yes   |

### Before

| Scenario              | Requests | Req/s | p50 ms | p95 ms | p99 ms | max ms | Errors | Target | Meets |
| --------------------- | -------: | ----: | -----: | -----: | -----: | -----: | -----: | -----: | ----- |
| Home feed (For You)   |      563 |    38 |  397.4 |  752.8 |  930.5 | 1240.6 |      0 |    250 | **no** |
| Home feed (Following) |   22,465 | 1,498 |    9.3 |   14.9 |   39.5 |  261.2 |      0 |    150 | yes   |
| Discover search       |    9,973 |   665 |   22.5 |   37.8 |   72.3 |  221.2 |      0 |    250 | yes   |
| Notifications list    |   56,663 | 3,778 |    3.8 |    6.5 |   11.3 |   96.3 |      0 |    100 | yes   |
| Sponsored slot        |   16,321 | 1,088 |   13.9 |   21.1 |   27.5 |   46.1 |      0 |    100 | yes   |
| Post create           |   22,417 | 1,494 |    9.5 |   16.6 |   29.9 |  106.5 |      0 |    150 | yes   |
| Message send          |   17,211 | 1,147 |   12.1 |   20.0 |   49.8 |  294.6 |      0 |    100 | yes   |

Differences of 10–20% on the routes that were not changed are run-to-run noise on a laptop.

### With tracing on

Same dataset, `LOAD_TRACING=http://localhost:4318` (every request sampled and exported to a local Jaeger):

| Scenario            | Req/s (off → on) | p95 ms (off → on) |
| ------------------- | ---------------- | ----------------- |
| Home feed (For You) | 394 → 342        | 56.2 → 62.7       |
| Notifications list  | 3,492 → 1,828    | 6.6 → 22.8        |
| Post create         | 1,726 → 1,180    | 13.2 → 20.6       |

Each request produces 15–35 spans, which costs most on the cheapest routes. With tracing off nothing is loaded and the numbers above are unaffected. In production, sample (`OTEL_TRACES_SAMPLER=parentbased_traceidratio`, `OTEL_TRACES_SAMPLER_ARG=0.1`) and export to a collector.

## What was slow and what changed

`load:explain` on the seeded database (35,000 posts in the 14-day window after a post-create run) showed one outlier: the For You query averaged **595 ms** (max 689 ms). Everything else averaged under 10 ms.

1. **JIT compilation.** The planner's cost estimate for the ranked feed (about 2,000,000, driven by per-row subqueries) was far above `jit_above_cost`, so Postgres JIT-compiled it on every call: 430 ms of the 649 ms in `EXPLAIN ANALYZE` was JIT (inlining, optimization, emission), for a query that executes in about 200 ms. JIT pays off for long analytical queries, not for OLTP requests, so `createPool` (`packages/database/src/index.ts`) now opens connections with `-c jit=off`.
2. **Per-row lookups.** Every candidate post ran two `EXISTS` lookups on `friendships` (a `BitmapOr` of two index scans each), two on `follows` and three topic subqueries. The viewer's follows and friends are now small sets built once (hashed lookups), their interest, "more like this" and "less like this" topics are arrays built once, and the three topic counts are one pass over the post's topics.
3. **Scoring the whole platform.** The query scored every visible post of the last 14 days, so its cost grew with total platform activity, not with the viewer's network. It now scores candidates only: all posts in the window from the viewer, people they follow, friends and their communities (found through `posts_author_idx` and `posts_community_idx`), plus the newest 1,000 other posts (`posts_recent_idx`, constant `RECENT_CANDIDATES` in `apps/api/src/modules/posts.ts`). Ranking inside that set is unchanged; a stranger's post older than the newest 1,000 is no longer considered for For You (it is still on their profile and in search).

Result: For You went from 595 ms to 24 ms per query at 35,000 posts, and from 38 to 394 requests per second at the seeded size (p95 753 → 56 ms).

Also changed: post search matched topics with `$2 = ANY(p.topics)`, which a GIN index cannot serve, so the whole `OR` fell back to a sequential scan of posts. It now uses `p.topics @> ARRAY[$2]`, letting Postgres combine `posts_search_idx` and `posts_topics_idx` in a bitmap scan (7.3 → 2.9 ms for a common term).

No new index was needed: every remaining hot query already uses an index (`notifications_user_idx`, `messages_conversation_idx`, `ad_events_user_idx`, `posts_author_idx`, `posts_recent_idx`), so no `0008_performance_indexes.sql` migration was added.

## Known limits

- The candidate set for For You still grows with how much the viewer's network posts in 14 days; a viewer following thousands of very active accounts would need a precomputed (fan-out-on-write) feed.
- `GET /v1/ads/next` returns an ad until each user reaches the frequency cap (3 per campaign per day); later requests in a run measure the "no eligible ad" path, which runs the same candidate query.
- People search orders by follower count with a correlated `count(*)` per matching profile; fine at this size, worth a denormalized `follower_count` once profiles reach the hundreds of thousands.
- Numbers come from one laptop with Postgres in Docker Desktop; re-baseline on production-like hardware before treating them as capacity figures.

### 2026-09-26: reels, stories, people suggestions

The seed now also creates a story per user and reels for a fifth of the users, and approves the ad campaigns (campaigns go to moderator review when started, so earlier runs after ad review landed served no ads). p95 at 16 connections, zero errors:

| Scenario | Route | p95 ms | Target |
| --- | --- | ---: | ---: |
| home feed | `GET /v1/feed` | 61.7 | 250 |
| reels feed | `GET /v1/reels` | 13.4 | 250 |
| stories | `GET /v1/moments` | 11.0 | 150 |
| people suggest | `GET /v1/people/suggest` | 21.3 | 100 |
| ads next (now serving ads) | `GET /v1/ads/next` | 17.0 | 100 |
