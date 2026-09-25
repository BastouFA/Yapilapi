import { createRequire } from 'node:module';
import type { FastifyPluginCallback } from 'fastify';
import type { NodeTracerProvider, SpanExporter } from '@opentelemetry/sdk-trace-node';

/**
 * Distributed tracing (OpenTelemetry).
 *
 * Off unless OTEL_EXPORTER_OTLP_ENDPOINT is set. When off, none of the SDK or
 * instrumentation packages are loaded, no hooks are installed and the logger
 * gets no mixin, so there is no per-request cost.
 *
 * When on: HTTP server/client spans (node:http), Fastify route, hook and
 * handler spans (@fastify/otel), Postgres (pg + pg-pool), Redis (ioredis) and
 * outgoing fetch (undici), exported over OTLP/HTTP in batches. W3C
 * traceparent headers are honoured and propagated.
 *
 * Call startTracing() before anything imports fastify, pg or ioredis (see
 * server.ts), because the instrumentations patch those modules as they load.
 */

interface TracingState {
  provider: NodeTracerProvider;
  fastifyPlugin: FastifyPluginCallback;
  logMixin: () => Record<string, string>;
}

let state: TracingState | null = null;

export interface StartTracingOptions {
  /** Export to this exporter instead of OTLP (tests). Spans are exported one by one. */
  exporter?: SpanExporter;
}

/** Paths that are polled constantly and would drown real traffic in traces. */
const QUIET = /^\/(health\/|metrics$)/;

export function tracingEnabled(): boolean {
  return state !== null;
}

export async function startTracing(env: NodeJS.ProcessEnv = process.env, opts: StartTracingOptions = {}): Promise<boolean> {
  if (state) return true;
  if (env.OTEL_SDK_DISABLED === 'true') return false;
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT && !env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT && !opts.exporter) return false;

  const [
    { trace },
    { NodeTracerProvider, BatchSpanProcessor, SimpleSpanProcessor },
    { OTLPTraceExporter },
    { resourceFromAttributes },
    { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION },
    { registerInstrumentations },
    { HttpInstrumentation },
    { UndiciInstrumentation },
    { PgInstrumentation },
    { IORedisInstrumentation },
    { default: FastifyOtelInstrumentation },
  ] = await Promise.all([
    import('@opentelemetry/api'),
    import('@opentelemetry/sdk-trace-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/resources'),
    import('@opentelemetry/semantic-conventions'),
    import('@opentelemetry/instrumentation'),
    import('@opentelemetry/instrumentation-http'),
    import('@opentelemetry/instrumentation-undici'),
    import('@opentelemetry/instrumentation-pg'),
    import('@opentelemetry/instrumentation-ioredis'),
    import('@fastify/otel'),
  ]);

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: env.OTEL_SERVICE_NAME || 'yapilapi-api',
      [ATTR_SERVICE_VERSION]: env.npm_package_version || '0.1.0',
      'deployment.environment.name': env.APP_ENV || 'development',
    }),
    // The OTLP exporter reads OTEL_EXPORTER_OTLP_* (endpoint, headers, timeout) itself.
    spanProcessors: [opts.exporter ? new SimpleSpanProcessor(opts.exporter) : new BatchSpanProcessor(new OTLPTraceExporter())],
  });
  // Global tracer provider, AsyncLocalStorage context manager and W3C trace-context propagator.
  provider.register();

  const fastifyOtel = new FastifyOtelInstrumentation({ ignorePaths: (route: { url: string }) => QUIET.test(route.url) });
  registerInstrumentations({
    tracerProvider: provider,
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => QUIET.test(req.url ?? ''),
        // The OTLP exporter's own requests would otherwise trace themselves.
        ignoreOutgoingRequestHook: (req) => (req.path ?? '').startsWith('/v1/traces'),
      }),
      new UndiciInstrumentation(),
      // Only inside a request or job span: the pool's idle checks and startup queries are noise.
      new PgInstrumentation({ requireParentSpan: true, enhancedDatabaseReporting: false }),
      new IORedisInstrumentation({ requireParentSpan: true }),
      fastifyOtel,
    ],
  });

  // The hooks above patch CommonJS modules as they are require()d. Our code is ESM, and
  // Node's ESM loader reuses the CommonJS cache, so loading them once here makes every
  // later `import` see the patched copy.
  const require = createRequire(import.meta.url);
  for (const id of ['node:http', 'node:https', 'pg', 'ioredis']) require(id);

  // Log correlation: every log line written inside a span carries its ids.
  const logMixin = (): Record<string, string> => {
    const sc = trace.getActiveSpan()?.spanContext();
    return sc ? { trace_id: sc.traceId, span_id: sc.spanId, trace_flags: `0${sc.traceFlags.toString(16)}` } : {};
  };

  state = { provider, fastifyPlugin: fastifyOtel.plugin() as unknown as FastifyPluginCallback, logMixin };
  return true;
}

/** The Fastify plugin that adds route, hook and handler spans, or null when tracing is off. */
export function fastifyTracingPlugin(): FastifyPluginCallback | null {
  return state?.fastifyPlugin ?? null;
}

/** Pino mixin that adds trace_id/span_id to log lines, or undefined when tracing is off. */
export function traceLogMixin(): (() => Record<string, string>) | undefined {
  return state?.logMixin;
}

/** Flush pending spans and stop exporting. */
export async function shutdownTracing(): Promise<void> {
  const s = state;
  state = null;
  await s?.provider.shutdown();
}

/** Force-export spans that are still buffered (tests, graceful shutdown). */
export async function flushTracing(): Promise<void> {
  await state?.provider.forceFlush();
}
