import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-node';
import { flushTracing, shutdownTracing, startTracing, tracingEnabled, traceLogMixin } from '../src/lib/tracing.ts';
import type { BuiltApp } from '../src/app.ts';

/**
 * Tracing is exercised over a real socket (not app.inject) so the HTTP server,
 * outgoing fetch, Fastify, Postgres and Redis instrumentations all take part.
 */
describe('distributed tracing', () => {
  const exporter = new InMemorySpanExporter();
  let t: BuiltApp;
  let base: string;

  beforeAll(async () => {
    expect(await startTracing({}, {})).toBe(false); // off without an endpoint
    expect(tracingEnabled()).toBe(false);
    expect(await startTracing({ APP_ENV: 'test' }, { exporter })).toBe(true);
    // fastify, pg and ioredis must load after tracing starts, as in server.ts.
    const { buildApp } = await import('../src/app.ts');
    const { loadConfig } = await import('../src/config.ts');
    const config = loadConfig({
      ...process.env,
      APP_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/yapilapi_test',
      // A separate logical database so nothing here touches development keys.
      REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15',
      AI_PROVIDER: 'dev',
      UPLOAD_DIR: '/tmp/ypl-test-uploads',
      RATE_LIMIT_MAX: '10000',
    });
    t = await buildApp(config, { logger: false });
    base = await t.app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await t?.close();
    await shutdownTracing();
  });

  const byName = (spans: ReadableSpan[], re: RegExp) => spans.filter((s) => re.test(s.name));

  it('links client, server, route and database spans in one trace', async () => {
    exporter.reset();
    const suffix = Math.random().toString(36).slice(2, 8);
    const res = await fetch(`${base}/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: `trace_${suffix}@example.test`,
        password: 'correct-horse-battery',
        username: `trace_${suffix}`,
        displayName: 'Tracer',
      }),
    });
    expect(res.status).toBe(201);
    await flushTracing();
    const spans = exporter.getFinishedSpans();

    const client = spans.find((s) => s.kind === 2 /* CLIENT */ && s.attributes['http.request.method'] === 'POST');
    const server = spans.find((s) => s.kind === 1 /* SERVER */);
    expect(client, 'outgoing fetch span (undici)').toBeTruthy();
    expect(server, 'incoming HTTP span').toBeTruthy();
    const traceId = client!.spanContext().traceId;
    // traceparent was propagated from the client to the server.
    expect(server!.spanContext().traceId).toBe(traceId);
    expect(server!.parentSpanContext?.spanId).toBe(client!.spanContext().spanId);

    const route = spans.find((s) => s.attributes['http.route'] === '/v1/auth/register' && s.instrumentationScope.name.includes('fastify'));
    expect(route, 'Fastify request span').toBeTruthy();
    expect(byName(spans, /handler/).length).toBeGreaterThan(0);

    const queries = spans.filter((s) => s.attributes['db.system.name'] === 'postgresql' || s.attributes['db.system'] === 'postgresql');
    expect(queries.length, 'pg spans').toBeGreaterThan(0);
    for (const q of queries) expect(q.spanContext().traceId).toBe(traceId);
  });

  it('traces Redis commands made inside a request', async () => {
    const { trace } = await import('@opentelemetry/api');
    exporter.reset();
    await trace.getTracer('test').startActiveSpan('redis-check', async (span) => {
      await t.ctx.redis!.set('ypl:tracing-test', '1', 'EX', 10);
      await t.ctx.redis!.get('ypl:tracing-test');
      span.end();
    });
    await flushTracing();
    const spans = exporter.getFinishedSpans();
    const redis = spans.filter((s) => s.attributes['db.system'] === 'redis' || s.attributes['db.system.name'] === 'redis');
    expect(redis.map((s) => s.name)).toEqual(expect.arrayContaining(['set', 'get']));
  });

  it('skips health checks and puts trace ids into log lines', async () => {
    exporter.reset();
    expect((await fetch(`${base}/health/live`)).status).toBe(200);
    await flushTracing();
    expect(exporter.getFinishedSpans().filter((s) => s.kind === 1)).toHaveLength(0);

    const { trace } = await import('@opentelemetry/api');
    const mixin = traceLogMixin()!;
    expect(mixin()).toEqual({});
    trace.getTracer('test').startActiveSpan('log-check', (span) => {
      const fields = mixin();
      expect(fields.trace_id).toBe(span.spanContext().traceId);
      expect(fields.span_id).toBe(span.spanContext().spanId);
      span.end();
    });
  });
});
