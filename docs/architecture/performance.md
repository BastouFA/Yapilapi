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

### 2026-09-26: trending and tag pages

Two new scenarios. Tag queries match with `p.topics @> ARRAY[$tag]` so `posts_topics_idx` (GIN) serves them. Trending aggregates the last 7 days of public posts; it is the heaviest new read but well inside its budget. p95 at 16 connections, zero errors:

| Scenario | Route | p95 ms | Target |
| --- | --- | ---: | ---: |
| trending tags | `GET /v1/trending` | 36.6 | 150 |
| tag page posts | `GET /v1/tags/:tag/posts` (recent and top) | 16.5 | 200 |
| home feed | `GET /v1/feed` | 59.0 | 250 |
| notifications list | `GET /v1/notifications` | 4.7 | 100 |

If trending ever gets close to its budget, cache it for a minute: it is the same for everyone.

## 2026-09-28: launch pass (database, API, web, phone)

### How it was measured

- **Dataset.** A development database migrated and seeded as usual, plus bulk rows written by a SQL script, every one marked "[Dev data]": 5,006 people, 105,009 posts (a tenth of them reels, one person with 5,000 posts and 30 collabs), 500,045 reactions, 297,761 follows, 50,061 friendships, 100,000 comments, 150,000 uploads, 20,001 chats holding 500,000 messages (one chat of 100,000), 300,000 notifications, 20,000 Market listings, 300 events with 6,149 tickets, 2,902 Together albums (one with 1,620 photos), 20,000 tips, 4,000 chat games with 80,000 moves. 728 MB on disk.
- **Flows.** A script builds the API in-process (as `load:explain` does), signs in as 13 of those people and, three times over, opens For you and Following, a profile and its posts, followers and following, the chat list, a chat and three older pages of it, post and people search, notifications, reels, stories, Market browse, search and saved, the Together list and the big album, the tickets wallet and, once each, the data export. It times every request and every SQL statement (keeping the parameters of the slowest call) and prints `EXPLAIN (ANALYZE, BUFFERS)` for the slowest statements.
- **pg_stat_statements** is not in `shared_preload_libraries` in the Docker Postgres, and the shared container was not restarted to add it, so statement timings came from the in-process wrapper above, which sees the same statements with their parameters. For production, start Postgres with `shared_preload_libraries=pg_stat_statements`, run `CREATE EXTENSION pg_stat_statements`, and read `SELECT calls, mean_exec_time, query FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 20`.
- **Every lookup by one value.** A script listed every `column = $1` lookup in the API's SQL and every foreign key whose column leads no index, and each was checked against the indexes that exist.

Same laptop as above (Apple M4, Postgres 16 in Docker Desktop), with other work running (load average 4 to 6), so compare the before and after columns rather than the absolute numbers.

### Flows, before and after

p50 and p95 in ms per request, 39 requests each (3 for the album and the export).

| Flow | p50 before | p50 after | p95 before | p95 after |
| --- | ---: | ---: | ---: | ---: |
| Feed, For you | 27.2 | 29.8 | 42.1 | 55.0 |
| Feed, Following | 34.0 | 16.1 | 44.9 | 36.5 |
| Profile | 36.3 | 4.1 | 41.1 | 5.8 |
| Profile posts | 77.9 | 12.3 | 84.7 | 15.3 |
| Profile posts, creator with 5,000 posts | about 80 | 15.3 | about 85 | 17.3 |
| Reels | 39.6 | 22.7 | 44.6 | 33.1 |
| Stories | 13.0 | 5.7 | 15.4 | 8.5 |
| Market browse | 18.2 | 2.8 | 21.1 | 5.1 |
| Market search ("bike") | 20.5 | 2.7 | 23.9 | 12.2 |
| Chat list | 3.7 | 3.0 | 17.4 | 16.5 |
| Chat, newest page | 6.0 | 4.7 | 8.0 | 7.2 |
| Notifications | 2.4 | 1.6 | 4.1 | 3.4 |
| Post search | 25.9 | 29.1 | 31.8 | 41.3 |
| People search | 15.9 | 17.3 | 17.2 | 21.8 |
| Together album | 31.7 | 26.5 | 36.5 | 35.1 |
| Tickets | 1.5 | 1.1 | 2.2 | 2.1 |
| Data export | 86.9 | 63.4 | 217.7 | 212.1 |

For you, the searches and the album were not changed; their differences are the machine's load. The heavy creator's row was added to the script after the first fix; before it, every profile's post list scanned the whole posts table, so it cost what any profile did.

### Statements, before and after the new indexes

`EXPLAIN (ANALYZE)` execution time in ms on the same dataset, inside a transaction that was rolled back.

| Statement | Before | After |
| --- | ---: | ---: |
| Someone's uploads, newest first (`media.owner_id`) | 24.4 | 0.7 |
| Their view-once views (`message_views.user_id`) | 7.4 | 0.2 |
| Erase their business page views (`business_views.viewer_id`) | 5.0 | 0.2 |
| Their live chat (`live_chat.user_id`) | 6.7 | 0.2 |
| Their chat game moves (`chat_game_moves.player_id`) | 5.3 | 0.2 |
| Tips received, Me → Tips (`tips.to_id`) | 2.6 | 0.2 |
| Duplicate-comment check, on every comment (`comments.author_id`) | 9.2 | 0.2 |
| Unpin a deleted or hidden comment (`posts.pinned_comment_id`) | 51.7 | 0.01 |
| Erase notifications to and from someone (`notifications.actor_id`) | 25.8 | 0.5 |
| Delete 20 expired messages (foreign key checks: `messages.reply_to_id` and five others) | 410.5 | 2.3 |
| Delete someone's 30 uploads (foreign key checks: `post_media.media_id` and ten others) | 77.7 | 3.8 |
| Market text search (`ILIKE '%bike%'` on title, description, area) | 15.4 | 1.3 |

The message delete matters most: disappearing messages are deleted one at a time as they expire, and every delete scanned the whole messages table for replies to it.

### What changed

**Migration `0062_performance_indexes.sql`** adds 69 indexes, in four groups:

1. The lookups the data export and erasure work had already found: `media (owner_id, created_at DESC)`, `message_views (user_id)`, `business_views (viewer_id)`, `live_chat (user_id)`, `chat_game_moves (player_id)`, and for tips `from_id` and `to_id` (each with `created_at DESC`), `order_id`, and partial ones on `post_id` and `live_id`.
2. Hot paths the flows found: `comments (author_id, created_at DESC)` for the duplicate-comment check; a tiny partial `media (id) WHERE moderation IN ('blocked', 'sensitive')` that the stories, chapters and reels filters use instead of scanning every upload; a trigram GIN index over Market titles, descriptions and areas; `market_listings (created_at DESC, id DESC)` for listed listings; `posts (pinned_comment_id)`; incoming friend requests; events you're going to; plans in a chat; a creator's plans, subscribers, sales and payouts; board notifications.
3. Per-person lookups used by the export and by erasure on tables that grow with activity (notifications by actor, chat reactions, poll votes, story responses, live participants and more).
4. Foreign keys that point at rows really deleted (expired messages, cleaned-up uploads, erased listings and Together photos, sounds, orders). Deleting a row makes Postgres look for rows that point at it, which was a full scan per deleted row without these.

Where the column is often empty the index is partial (`WHERE … IS NOT NULL`), and the Market ones repeat the listed-listing condition, so they stay small.

**Queries rewritten** (each covered by `apps/api/test/performance-queries.test.ts`, which passes against both the old and the new queries):

- **Profile post count and profile posts.** "By this person or co-authored by them" was `author_id = $u OR EXISTS (a collab row)`, which Postgres can only answer by checking every post on the platform. The co-authored posts are now an array computed once, `p.id = ANY(ARRAY(SELECT post_id FROM post_collaborators …))` (`coAuthoredIdsSql` in `lib/collabs.ts`), which next to `author_id = $u` becomes one bitmap scan of `posts_author_idx` and the primary key. The profile's post list reads the person's own posts and their collabs as two ordered queries and merges them. Profile 36 → 4 ms, profile posts 78 → 12 ms.
- **Following feed.** Posts are now joined through "you and the people you follow" (`posts_author_idx`) instead of testing every post for a follow; collabs and reposts the same way. 34 → 16 ms. The Friends feed uses the same pattern.
- **Reels.** The feed ranked every reel on the platform on each request. It now ranks the newest 2,000 reels (`REEL_CANDIDATES` in `modules/posts.ts`) plus the last 30 days of reels from people you follow and friends, the way For you already works, and builds your follows, friends and interests once. Same ranking inside that set. 40 → 23 ms at 10,000 reels, and it no longer grows with the number of reels.
- **Market browse.** "Your country first, then newest" sorted every listing. It now reads your country's listings and everyone else's as two date-ordered index scans that stop after the pages asked for, then merges them. 18 → 3 ms. One visible difference: a listing with no country is now counted with "everywhere else", after your country's listings, where before Postgres put it first (NULL sorts first in a descending order).

**N+1 queries fixed:**

- Market listings seen by someone under 18: whether they may write to each seller was one query per seller on the page; now one query for the page (`trustedAmong` in `lib/market.ts`).
- `GET /v1/orders`: one query per order (up to 50) is now one query.
- `GET /v1/wraps`: each wrap loaded its moment with its own `hydratePosts` call; now one call for all of them.

The other loops that query per row send notifications to each person involved (fan-out on write) or are one-off jobs; they were left as they are.

**Lists capped** that had no limit and grow with use: incoming friend requests (newest 200), blocked, muted and restricted people (1,000), plans in a chat (newest 100). Every other list endpoint already had a `LIMIT` or a page size.

### Adding indexes in production

Migrations run inside a transaction (`packages/database/src/migrate.ts`), where `CREATE INDEX CONCURRENTLY` is not allowed, so a migration's `CREATE INDEX` locks its table against writes while it builds. That is fine on small tables and at launch. Once tables are large, build the indexes by hand first, then deploy; the migration's `IF NOT EXISTS` then skips each one:

```bash
# Every CREATE INDEX in the migration, rewritten as CONCURRENTLY, one statement each.
awk 'BEGIN { RS = ";" } { gsub(/--[^\n]*/, ""); if ($0 ~ /CREATE INDEX IF NOT EXISTS/) {
  sub(/CREATE INDEX IF NOT EXISTS/, "CREATE INDEX CONCURRENTLY IF NOT EXISTS"); print $0 ";" } }' \
  packages/database/migrations/0062_performance_indexes.sql > /tmp/0062-concurrently.sql
# psql runs each statement in its own transaction unless told otherwise, which CONCURRENTLY needs.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f /tmp/0062-concurrently.sql
# A concurrent build that fails leaves an invalid index, which IF NOT EXISTS would then skip.
psql "$DATABASE_URL" -c "SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid"
# Drop any it lists (DROP INDEX CONCURRENTLY name), run the file again, then deploy.
```

This is why index migrations keep semicolons out of their comments. Build at a quiet hour: a concurrent build still reads the whole table twice.

### Web bundles

Next 16 no longer prints route sizes in `next build`, so first-load JS per route was computed from the build manifests: the shared root chunks plus each route's client entry chunks (root layout, group layout, page), gzip level 9, before and after, from the same build command.

| | Before | After |
| --- | ---: | ---: |
| Mean first-load JS per route (100 routes) | 933.9 kB | 924.3 kB |
| Largest route (`/inbox/[id]`) | 1,026.2 kB | 992.7 kB |

| Route | Before (kB) | After (kB) | Change (kB) |
| --- | ---: | ---: | ---: |
| `/together/[id]` | 993.7 | 941.9 | −51.8 |
| `/together` | 972.5 | 932.7 | −39.8 |
| `/u/[username]` | 1,020.6 | 984.1 | −36.5 |
| `/inbox/[id]` | 1,026.2 | 992.7 | −33.5 |
| `/home` | 983.6 | 953.6 | −30.0 |
| `/t/[tag]` | 976.6 | 948.2 | −28.4 |
| `/tickets` | 956.1 | 935.0 | −21.1 |
| `/market/[id]` | 975.3 | 954.7 | −20.6 |
| `/reels` | 980.7 | 963.0 | −17.7 |
| `/create` | 968.8 | 951.5 | −17.3 |
| `/market` | 943.2 | 933.1 | −10.1 |

Every signed-in page is at least 7.4 kB lighter, because the Stripe form and the room screen left the app layout. What changed:

- **Loaded when needed** (`next/dynamic`, client only, with a placeholder the size of what it replaces, announced as "Loading"): the Stripe payment form (opens with a checkout), the room screen, the watch-together screen (the feed only needs its picker), the Market listing form, the drop editor, the Together photo viewer and slideshow, the chat game boards and "start a game" sheet, the profile cover editor, the photo, video and collage editors on Create, and the story viewer on Home and tag pages. The QR code encoder is imported the first time a code is drawn. The chess board stays in the first load because the in-chat card shows it.
- **Images:** list and grid images got `loading="lazy"` and `decoding="async"`; images at the top of a page (the listing gallery, a drop's cover, the wrap card, the profile cover) stay eager.
- **Duplicate requests on load:** the unread counts and the inbox page asked for the chat list at the same time, and the same for notifications; the sidebar and Home both asked for people suggestions; two admin cards both loaded the flags; the sidebar loaded its suggestions twice when Live was on. Callers asking for the same thing at the same moment now share one request (`sharedRequest` in `apps/web/lib/api.ts`, which keeps nothing once the request settles).

The biggest remaining cost is not in the web app: the root layout chunk (782 kB gzip, on every route) is about 616 kB of the seven non-English message catalogs plus 80 kB of English, all imported through `packages/shared/src/i18n.ts`. Putting each locale in its own module and loading the reader's one after sign-in would take about 600 kB, around 65%, off every route. Done since: see "One language per reader on the web" below.

### Phone lists

Every long list already had id-based `keyExtractor`s, the feeds shared tuned `windowSize`, batch sizes and `removeClippedSubviews` on Android, and reels had a fixed-height `getItemLayout`. What changed is re-rendering:

- **Reels:** each reel is a memoised row whose buttons call the screen's latest actions through a ref, so opening a sheet or a status change no longer re-renders every mounted video.
- **Chat:** `renderItem` is stable, so typing no longer re-renders every visible message.
- **Comments, notifications, the chat list, followers and following:** rows are memoised components with stable handlers. The notifications separator was an inline component, remounted on every render.
- **Feed:** `renderItem` is a module-level function, and reaching the end of the list fetches each page once (it could ask for the same cursor twice before a page arrived).
- **Market:** the listing grid and tiles are memoised, so typing in the search box no longer re-renders every photo.

Left as they are: the Market list and search results stay a `ScrollView` (they load a page at a time with a button, with the search box in the same scroll), and no `getItemLayout` was added where row heights vary.

### Known limits (added)

- **Hashtag suggestions in search** count the tags of every public post of the last 90 days on each keystroke (15 ms at 100,000 posts). Sampling the newest posts did not help at this size; once posts reach the millions, count tags in a table kept by a job instead.
- **Post search** ranks every match of a common word before taking the first page (12,500 matches for "sunset" here, 11 to 25 ms). It is inside the 250 ms budget; a search engine is the fix at a much larger size.
- **A Together album** returns up to 1,000 photos in one response (12 ms of SQL here); page it if albums get much bigger.
- **For you** is unchanged at 20 to 30 ms; the "posts on your interests" candidates are most of it.

## 2026-09-28: one language per reader on the web

Every web page shipped all eight message catalogs, because they lived in one module (`packages/shared/src/i18n.ts`) that the root layout imports through `t()`. Each catalog is now its own module in `packages/shared/src/locales/`. `@yapilapi/shared` carries English and the helpers (`i18n-core.ts`); the other seven load with `import()` through `loadLocale()`, so the build makes one chunk per language and a reader downloads theirs only.

### First-load JS, before and after

Measured the same way as "Web bundles" above: `pnpm --filter @yapilapi/web build`, then the root main files plus each route's client entry chunks from the build manifests, gzip level 9.

| Route | Before (kB) | After (kB) | Change (kB) |
| --- | ---: | ---: | ---: |
| `/home` (feed) | 977.2 | 347.6 | −629.6 |
| `/u/[username]` (profile) | 1,008.4 | 378.7 | −629.7 |
| `/settings` | 954.4 | 324.7 | −629.7 |
| `/inbox/[id]` (largest) | 1,017.2 | 387.6 | −629.6 |
| `/` (landing) | 935.6 | 306.0 | −629.6 |
| Mean of 100 routes | 947.2 | 323.9 | −623.3 |

The chunk that held every catalog was 796 kB gzip; the one left in the first load (English with the code it shares a chunk with) is 166 kB. A reader in another language downloads one more chunk, once, then the browser keeps it: French 92.6 kB, Arabic 96.7, Spanish 89.1, Portuguese 88.4, Swahili 86.7, Yorùbá 93.9, Hausa 86.0. So a French reader's first visit to Home is about 440 kB instead of 977, and an English reader's 348.

### No English first

- `Providers` (`apps/web/app/providers.tsx`) waits for the reader's catalog as it waits for the account: `refresh()` loads the language before setting the account, and `loading` stays true while a language is fetched (signing in, switching accounts). Signed-in pages show their skeleton until then, as they already did while the account loaded, so the first text a reader sees is in their language. A catalog that can't be fetched leaves the text in English rather than blocking.
- `<html lang>` and `dir` are set in a layout effect, before the browser paints the app. Before, a plain effect set them after the first paint, so an Arabic reader saw one frame of the app left to right.
- The browser remembers the signed-in reader's language (`ypl_locale` in local storage, cleared once nobody is signed in). A script in `<head>` (`apps/web/lib/locale-script.ts`, like the theme's) puts it on `<html>` before anything paints, and the catalog starts downloading as the page's code runs, alongside the account request instead of after it.
- The skip link waits for the language too, so it is never read out in English to a French reader.
- Switching language in Settings fetches the new catalog while the choice saves; the app switches in place, with no reload, and the "saved" message is in the new language.

Pages stay static: reading a cookie in the root layout to render the language on the server would make all 63 static routes dynamic, for pages whose content comes from the browser anyway. Signed-out pages are English, as before.

The phone and the API keep every catalog loaded up front: they import `packages/shared/src/i18n.ts` (the API as `@yapilapi/shared/i18n`, in `app.ts` and for the weekly wrap card), which registers all eight. `i18n.test.ts` still checks every catalog against English; `i18n-core.test.ts` checks that every file in `locales/` has a loader and loads.

Checked with headless Chromium against a production build (web on 127.0.0.1:3310, API on 4310, own database): a French, an Arabic and an English reader, each in a new browser and again with the language remembered, on Home, Settings and their profile. A recorder in the page logged every change of text and of `<html lang>`/`dir` from the first moment. No frame had English text for the French or Arabic reader, the first frame with the app in it was in their language, Arabic was right to left in every frame, each reader downloaded only their own catalog chunk (none for English), and there were no hydration errors. Switching an English reader to Arabic in Settings changed the language and direction without a reload.
