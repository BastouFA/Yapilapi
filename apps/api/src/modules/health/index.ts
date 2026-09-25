import { forbidden } from '@yapilapi/shared';
import { route } from '../../lib/route.js';
import type { ApiModule } from '../types.js';

const startedAt = Date.now();

export const healthModule: ApiModule = {
  name: 'health',
  register(app, ctx) {
    // Liveness: the process is up. No dependencies checked (so orchestrators don't restart on DB blips).
    route(app, ctx, {
      method: 'GET',
      url: '/health/live',
      summary: 'Liveness probe',
      tags: ['ops'],
      auth: 'public',
      handler: () => ({ status: 'ok' }),
    });

    // Readiness: dependencies needed to serve traffic. 503 tells load balancers to stop routing here.
    route(app, ctx, {
      method: 'GET',
      url: '/health/ready',
      summary: 'Readiness probe',
      tags: ['ops'],
      auth: 'public',
      handler: async ({ reply }) => {
        const checks: Record<string, 'ok' | 'fail'> = {};
        try {
          await ctx.db.query('SELECT 1');
          checks.database = 'ok';
        } catch {
          checks.database = 'fail';
        }
        const ok = Object.values(checks).every((v) => v === 'ok');
        void reply.code(ok ? 200 : 503);
        return { status: ok ? 'ready' : 'degraded', checks };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/health',
      summary: 'Service info',
      tags: ['ops'],
      auth: 'public',
      handler: () => ({
        name: ctx.config.APP_NAME,
        env: ctx.config.APP_ENV,
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      }),
    });

    route(app, ctx, {
      method: 'GET',
      url: '/metrics',
      summary: 'Prometheus metrics',
      tags: ['ops'],
      auth: 'public',
      handler: async ({ req, reply }) => {
        if (!ctx.config.METRICS_ENABLED) throw forbidden('Metrics disabled');
        const token = ctx.config.METRICS_TOKEN;
        if (token) {
          if (req.headers.authorization !== `Bearer ${token}`)
            throw forbidden('Invalid metrics token');
        } else if (ctx.config.APP_ENV === 'production' || ctx.config.APP_ENV === 'staging') {
          throw forbidden('Metrics require METRICS_TOKEN in this environment');
        }
        void reply.header('content-type', ctx.metrics.registry.contentType);
        return ctx.metrics.registry.metrics();
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/meta',
      summary: 'Public client configuration and feature flags',
      tags: ['ops'],
      auth: 'optional',
      handler: async ({ auth }) => ({
        app: ctx.config.APP_NAME,
        tagline: 'Your social world. One place.',
        flags: await ctx.flags.all(auth?.userId),
      }),
    });
  },
};
