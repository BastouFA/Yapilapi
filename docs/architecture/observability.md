# Observability

Three signals, each useful on its own and linked to the others by ids:

| Signal  | Where                                                    | Key                                              |
| ------- | -------------------------------------------------------- | ------------------------------------------------ |
| Logs    | API stdout, JSON (pino via Fastify)                      | `reqId` (also the `x-request-id` header), `trace_id`, `span_id` |
| Metrics | `GET /metrics`, Prometheus text (`infrastructure/monitoring/`) | `method`, `route`                                |
| Traces  | OTLP/HTTP to any collector (Jaeger locally)              | W3C `traceparent`                                |

## Logs

Every request logs `incoming request` and `request completed` with its `reqId`. The id comes from an incoming `x-request-id` header when a proxy sets one, otherwise it is generated, and it is returned on every response and inside every error body (`error.requestId`), so a user-reported error leads straight to its log lines. Authorization headers, cookies, passwords and tokens are redacted.

With tracing on, each log line written while a span is active also carries `trace_id`, `span_id` and `trace_flags`, so you can jump from a log line to its trace and back.

## Metrics

`/metrics` exposes per-route request counts, 5xx counts and summed latency, plus Redis and database pool gauges. Alerts live in `infrastructure/monitoring/alerts.yml`.

## Distributed tracing (OpenTelemetry)

Tracing is **off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set**. When it is off, `apps/api/src/lib/tracing.ts` returns before loading the SDK or any instrumentation, installs no hooks and adds no log mixin, so there is no per-request cost. `OTEL_SDK_DISABLED=true` turns it off even with an endpoint.

When it is on, `server.ts` starts tracing before it imports anything else (the instrumentations patch modules as they load) and the API records:

| Span source                                | What you see                                                                      |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| `@opentelemetry/instrumentation-http`      | One `SERVER` span per request (`GET /v1/feed`), outgoing `http`/`https` calls      |
| `@fastify/otel`                            | `request` span with `http.route`, a span per lifecycle hook (cors, cookie, auth, rate limit) and the `handler` |
| `@opentelemetry/instrumentation-pg`        | `pg.query:SELECT <db>`, `pg.connect`, `pg-pool.connect` (only inside a request or job) |
| `@opentelemetry/instrumentation-ioredis`   | Redis commands (rate-limit scripts, realtime publish)                              |
| `@opentelemetry/instrumentation-undici`    | Outgoing `fetch` (AI provider, webhooks, link previews)                            |

`/health/*` and `/metrics` are not traced. Incoming `traceparent` headers are honoured, so a trace started by a proxy or another service continues through the API, and outgoing calls carry the header onwards.

Spans are batched and exported with the OTLP/HTTP exporter, which reads the standard variables:

| Variable                         | Default          | Meaning                                                      |
| -------------------------------- | ---------------- | ------------------------------------------------------------ |
| `OTEL_EXPORTER_OTLP_ENDPOINT`    | (unset: off)     | Collector base URL, e.g. `http://localhost:4318` (`/v1/traces` is appended) |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | (unset)      | Full traces URL, if it differs from the base                 |
| `OTEL_EXPORTER_OTLP_HEADERS`     | (unset)          | `key=value,...` auth headers for a hosted backend            |
| `OTEL_SERVICE_NAME`              | `yapilapi-api`   | `service.name` resource attribute                            |
| `OTEL_TRACES_SAMPLER` / `_ARG`   | parent-based, always on | e.g. `parentbased_traceidratio` and `0.1` to keep 10% in production |

### Run it locally

```bash
docker compose --profile tracing up -d jaeger     # Jaeger v2: OTLP on :4318, UI on :16686
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 pnpm dev:api
```

Make a few requests and open http://localhost:16686, service `yapilapi-api`. A `POST /v1/auth/register` trace looks like this (measured locally):

```text
POST /v1/auth/register                     http          202 ms
  request                                  fastify       194 ms
    onRequest - handleCors / cookie / auth fastify       <1 ms each
    evalsha                                ioredis         1 ms   (rate limit)
    handler                                fastify       184 ms   (password hashing dominates)
      pg.query:BEGIN / SELECT / INSERT ... pg            2-14 ms each
      pg.query:COMMIT                      pg              2 ms
    onSend / onResponse                    fastify       <4 ms
```

and its log line carries the same id:

```json
{"level":30,"reqId":"d41ca644-...","trace_id":"e94f1aefb39b5faa855d6576fbbeb393","span_id":"f9b2e7ee5b39d9b2","trace_flags":"01","req":{"method":"POST","url":"/v1/auth/register"},"msg":"incoming request"}
```

In production, point the endpoint at an OpenTelemetry Collector (or a vendor's OTLP endpoint) rather than straight at a trace store, so sampling, batching and retries live outside the API.

### Tests

`apps/api/test/tracing.test.ts` runs the API on a real socket with an in-memory exporter and checks that tracing stays off without an endpoint, that a `fetch` client span, the HTTP server span, the Fastify route span and the Postgres spans share one trace (the `traceparent` crossed the wire), that Redis commands are traced, that health checks are not, and that log lines get the active trace and span ids.
