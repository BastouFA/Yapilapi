import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export interface Metrics {
  registry: Registry;
  httpRequests: Counter<'method' | 'route' | 'status'>;
  httpDuration: Histogram<'method' | 'route' | 'status'>;
  events: Counter<'name'>;
}

export function createMetrics(enabled: boolean): Metrics {
  const registry = new Registry();
  if (enabled) collectDefaultMetrics({ register: registry, prefix: 'yapilapi_' });
  return {
    registry,
    httpRequests: new Counter({
      name: 'yapilapi_http_requests_total',
      help: 'HTTP requests',
      labelNames: ['method', 'route', 'status'],
      registers: [registry],
    }),
    httpDuration: new Histogram({
      name: 'yapilapi_http_request_duration_seconds',
      help: 'HTTP request duration',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [registry],
    }),
    events: new Counter({
      name: 'yapilapi_domain_events_total',
      help: 'Domain events (signups, posts, payments...)',
      labelNames: ['name'],
      registers: [registry],
    }),
  };
}
