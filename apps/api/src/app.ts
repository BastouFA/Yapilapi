import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { ZodError } from 'zod';
import { AppError } from '@yapilapi/shared';
import type { AppContext } from './lib/context.js';
import './lib/auth-context.js';
import { modules } from './modules/index.js';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export const CSRF_HEADER = 'x-yl-csrf';

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const { config } = ctx;
  const app = Fastify({
    loggerInstance: ctx.log,
    genReqId: (req) =>
      typeof req.headers['x-request-id'] === 'string' && req.headers['x-request-id'].length <= 100
        ? req.headers['x-request-id']
        : randomUUID(),
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 1_048_576,
  });

  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
  });
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || config.corsAllowedOrigins.includes(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'content-type',
      'authorization',
      CSRF_HEADER,
      'idempotency-key',
      'x-request-id',
    ],
    exposedHeaders: ['x-request-id', 'retry-after'],
    maxAge: 600,
  });
  await app.register(cookie);

  app.addHook('onRequest', async (req, reply) => {
    req.clientIp = req.ip;
    void reply.header('x-request-id', req.id);

    // Coarse per-IP abuse ceiling; individual routes add tighter limits.
    if (config.RATE_LIMIT_ENABLED) {
      const r = await ctx.limiter.hit(`global:${req.ip}`, 600, 60);
      if (!r.allowed) {
        void reply.header('retry-after', String(r.retryAfterSec));
        throw new AppError('rate_limited', 'Too many requests. Please slow down.');
      }
    }

    // CSRF defence for cookie sessions: browsers must send an allowed Origin and our custom header.
    if (UNSAFE.has(req.method)) {
      const origin = req.headers.origin;
      const hasCookie = Boolean(req.cookies?.[config.SESSION_COOKIE_NAME]);
      const bearer = req.headers.authorization?.startsWith('Bearer ');
      if (origin && !config.corsAllowedOrigins.includes(origin)) {
        throw new AppError('csrf_failed', 'Cross-site request rejected');
      }
      if (hasCookie && !bearer && (!origin || req.headers[CSRF_HEADER] !== '1')) {
        throw new AppError('csrf_failed', 'Missing CSRF protection header');
      }
    }
  });

  app.addHook('onResponse', async (req, reply) => {
    const route = (req.routeOptions?.url as string | undefined) ?? 'unmatched';
    const labels = { method: req.method, route, status: String(reply.statusCode) };
    ctx.metrics.httpRequests.inc(labels);
    ctx.metrics.httpDuration.observe(labels, reply.elapsedTime / 1000);
  });

  app.setNotFoundHandler((req, reply) => {
    void reply
      .code(404)
      .send({ error: { code: 'not_found', message: 'Route not found', requestId: req.id } });
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    const requestId = req.id;
    if (err instanceof AppError) {
      return reply
        .code(err.status)
        .send({ error: { code: err.code, message: err.message, details: err.details, requestId } });
    }
    if (err instanceof ZodError) {
      return reply
        .code(400)
        .send({ error: { code: 'validation_failed', message: 'Invalid input', requestId } });
    }
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (e.code === '23505') {
      return reply
        .code(409)
        .send({ error: { code: 'conflict', message: 'Already exists', requestId } });
    }
    if (e.code === '23514' || e.code === '23502' || e.code === '22P02') {
      req.log.warn({ err }, 'database constraint violation');
      return reply.code(422).send({
        error: { code: 'unprocessable', message: 'Request violates a data rule', requestId },
      });
    }
    if (typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.code(e.statusCode).send({
        error: {
          code: e.statusCode === 413 ? 'validation_failed' : 'validation_failed',
          message: e.message ?? 'Bad request',
          requestId,
        },
      });
    }
    req.log.error({ err }, 'unhandled error');
    return reply
      .code(500)
      .send({ error: { code: 'internal', message: 'Something went wrong', requestId } });
  });

  for (const mod of modules) {
    await app.register(async (instance) => {
      await mod.register(instance, ctx);
    });
  }
  return app;
}
