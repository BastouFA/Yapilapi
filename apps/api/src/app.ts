import Fastify, { type FastifyInstance, type RouteOptions } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { Redis } from 'ioredis';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPool } from '@yapilapi/database';
import { runInRequest, withRequestContext } from './lib/request-context.ts';
import type { Config } from './config.ts';
import type { AppContext } from './lib/context.ts';
import { AppError } from './lib/errors.ts';
import { RealtimeHub } from './lib/realtime.ts';
import { AiGateway } from './lib/ai/gateway.ts';
import { anthropicProvider, devProvider } from './lib/ai/providers.ts';
import { logEmailSender } from './lib/email.ts';
import { localDiskStorage, s3Storage } from './lib/storage.ts';
import { devPaymentProvider, stripePaymentProvider } from './lib/payments.ts';
import { transcriberFromConfig } from './lib/transcription.ts';
import { registerAuth } from './plugins/auth.ts';
import { MAX_UPLOAD_BYTES } from './modules/media.ts';
import authModule from './modules/auth.ts';
import profilesModule from './modules/profiles.ts';
import postsModule from './modules/posts.ts';
import messagingModule from './modules/messaging.ts';
import communitiesModule from './modules/communities.ts';
import eventsModule from './modules/events.ts';
import commerceModule from './modules/commerce.ts';
import searchModule from './modules/search.ts';
import notificationsModule from './modules/notifications.ts';
import safetyModule from './modules/safety.ts';
import privacyModule from './modules/privacy.ts';
import aiModule from './modules/ai.ts';
import momentsModule from './modules/moments.ts';
import mediaModule from './modules/media.ts';
import creatorModule from './modules/creator.ts';
import developerModule from './modules/developer.ts';
import memoryModule from './modules/memory.ts';
import liveModule from './modules/live.ts';
import uploadsModule from './modules/uploads.ts';
import callsModule from './modules/calls.ts';
import realModule from './modules/real.ts';
import oauthModule from './modules/oauth.ts';
import pushModule from './modules/push.ts';
import miniAppsModule from './modules/miniapps.ts';
import economyModule from './modules/economy.ts';
import adsModule from './modules/ads.ts';
import familyModule from './modules/family.ts';
import studioModule from './modules/studio.ts';
import tagsModule from './modules/tags.ts';
import plusModule from './modules/plus.ts';
import invitesModule from './modules/invites.ts';
import publicModule from './modules/public.ts';
import growthModule from './modules/growth.ts';
import { createPushSender } from './lib/push.ts';
import { setPushSender } from './lib/services.ts';
import { processWebhooks } from './lib/webhooks.ts';
import { processJobs } from './lib/jobs.ts';
import { mediaJobHandlers } from './lib/media-processing.ts';
import { studioJobHandlers } from './lib/studio.ts';
import { liveRecordingJobHandlers } from './lib/live-recording.ts';
import { shareVideoJobHandlers } from './lib/share-video.ts';
import { fastifyTracingPlugin, traceLogMixin } from './lib/tracing.ts';

export interface BuiltApp {
  app: FastifyInstance;
  ctx: AppContext;
  close: () => Promise<void>;
}

export async function buildApp(
  config: Config,
  opts: { logger?: boolean; onRoute?: (route: RouteOptions) => void; webhookWorker?: boolean } = {},
): Promise<BuiltApp> {
  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : {
            level: config.APP_ENV === 'production' ? 'info' : 'debug',
            // Never log credentials or session tokens.
            redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]', '*.password', '*.token'],
            // With tracing on, log lines carry trace_id/span_id next to reqId.
            mixin: traceLogMixin(),
          },
    genReqId: (req) => (req.headers['x-request-id'] as string) || randomUUID(),
    trustProxy: true,
    bodyLimit: 1_000_000,
  });
  if (opts.onRoute) app.addHook('onRoute', opts.onRoute);
  // The country a trusted CDN reports for this request; regional rules use it, including for people who aren't signed in.
  app.addHook('onRequest', (req, _reply, done) => {
    const header = config.TRUSTED_COUNTRY_HEADER;
    runInRequest(header ? String(req.headers[header.toLowerCase()] ?? '').toUpperCase() : null, done);
  });
  // Route, hook and handler spans. Registered first so it sees every route.
  const tracing = fastifyTracingPlugin();
  if (tracing) await app.register(tracing);

  const db = withRequestContext(createPool(config.DATABASE_URL));
  let redis: Redis | undefined;
  let sub: Redis | undefined;
  if (config.REDIS_URL) {
    redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: false });
    sub = redis.duplicate();
    // Degrade gracefully: Redis outages must not take the API down.
    redis.on('error', (e) => app.log.warn({ err: e.message }, 'redis error'));
    sub.on('error', (e) => app.log.warn({ err: e.message }, 'redis subscriber error'));
  }

  const provider =
    config.AI_PROVIDER === 'anthropic' && config.ANTHROPIC_API_KEY ? anthropicProvider(config.ANTHROPIC_API_KEY, config.AI_MODEL) : devProvider();
  if (config.AI_PROVIDER === 'anthropic' && !config.ANTHROPIC_API_KEY)
    app.log.warn('AI_PROVIDER=anthropic but ANTHROPIC_API_KEY is empty; using the dev provider.');

  const storage =
    config.STORAGE_DRIVER === 's3'
      ? s3Storage({
          endpoint: config.S3_ENDPOINT,
          region: config.S3_REGION,
          bucket: config.S3_BUCKET,
          accessKeyId: config.S3_ACCESS_KEY_ID,
          secretAccessKey: config.S3_SECRET_ACCESS_KEY,
          forcePathStyle: config.S3_FORCE_PATH_STYLE,
          publicBase: config.PUBLIC_API_URL,
        })
      : localDiskStorage(path.resolve(config.UPLOAD_DIR), config.PUBLIC_API_URL);
  if ('ensureBucket' in storage)
    await (storage as { ensureBucket(): Promise<void> }).ensureBucket().catch((e) => app.log.warn({ err: e.message }, 'media bucket not reachable'));

  const ctx: AppContext = {
    config,
    db,
    redis,
    realtime: new RealtimeHub(redis, sub),
    ai: new AiGateway(db, provider),
    email: logEmailSender(app.log),
    storage,
    payments:
      config.PAYMENTS_PROVIDER === 'stripe'
        ? stripePaymentProvider({
            secretKey: config.STRIPE_SECRET_KEY,
            webhookSecret: config.STRIPE_WEBHOOK_SECRET,
            publishableKey: config.STRIPE_PUBLISHABLE_KEY,
          })
        : devPaymentProvider(config.PAYMENTS_WEBHOOK_SECRET),
    transcription: transcriberFromConfig(config),
  };

  // Keep the raw body for webhook signature checks.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as unknown as { rawBody: string }).rawBody = body as string;
    if (!body) return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(new AppError(400, 'invalid_json', 'The request body is not valid JSON.'), undefined);
    }
  });

  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => done(null, body));

  await app.register(cors, { origin: config.WEB_ORIGIN.split(','), credentials: true });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    hook: 'preHandler',
    // Tests create many users from one address; limits stay on everywhere else.
    allowList: () => config.APP_ENV === 'test',
    max: config.RATE_LIMIT_MAX,
    timeWindow: '1 minute',
    redis: redis,
    skipOnError: true,
    keyGenerator: (req) => req.user?.id ?? req.ip,
    errorResponseBuilder: (_req, c) => ({
      statusCode: 429,
      error: { code: 'rate_limited', message: `Too many requests. Try again in ${Math.ceil(c.ttl / 1000)} seconds.` },
    }),
  });
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES } });
  await app.register(websocket);
  if (storage.driver === 'local')
    await app.register(fastifyStatic, { root: path.resolve(config.UPLOAD_DIR), prefix: '/media/', decorateReply: false, maxAge: '365d', immutable: true });
  else
    app.get('/media/*', { config: { rateLimit: false } }, async (req, reply) => {
      const key = (req.params as { '*': string })['*'];
      if (!/^[\w/.-]+$/.test(key) || key.includes('..')) return reply.code(404).send();
      const obj = await storage.get!(key, req.headers.range);
      if (!obj) return reply.code(404).send({ error: { code: 'not_found', message: 'Media not found.' } });
      reply.code(obj.status).header('cache-control', 'public, max-age=31536000, immutable').header('accept-ranges', 'bytes');
      if (obj.contentType) reply.type(obj.contentType);
      if (obj.contentLength !== undefined) reply.header('content-length', obj.contentLength);
      if (obj.contentRange) reply.header('content-range', obj.contentRange);
      return reply.send(obj.body);
    });

  // Security headers for every API response.
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    if (config.COOKIE_SECURE) reply.header('strict-transport-security', 'max-age=63072000; includeSubDomains');
  });

  registerAuth(app, ctx);

  // Metrics: request counts and latency by route, exposed in Prometheus text format.
  const metrics = new Map<string, { count: number; errors: number; totalMs: number }>();
  app.addHook('onResponse', async (req, reply) => {
    const key = `${req.method} ${req.routeOptions.url ?? 'unknown'}`;
    const m = metrics.get(key) ?? { count: 0, errors: 0, totalMs: 0 };
    m.count++;
    if (reply.statusCode >= 500) m.errors++;
    m.totalMs += reply.elapsedTime;
    metrics.set(key, m);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError)
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details, requestId: req.id } });
    const e = err as { statusCode?: number; code?: string; message: string };
    if (e.statusCode === 429) return reply.code(429).send(err);
    if (e.code === 'FST_REQ_FILE_TOO_LARGE')
      return reply.code(413).send({ error: { code: 'too_large', message: 'Files can be up to 50 MB.', requestId: req.id } });
    if (e.statusCode && e.statusCode < 500)
      return reply.code(e.statusCode).send({ error: { code: e.code ?? 'bad_request', message: e.message, requestId: req.id } });
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal', message: 'Something went wrong on our side. Try again.', requestId: req.id } });
  });

  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({ error: { code: 'not_found', message: `No route for ${req.method} ${req.url}.`, requestId: req.id } }),
  );

  // ── Health ────────────────────────────────────────────────────────────
  app.get('/health/live', { config: { rateLimit: false } }, async () => ({ status: 'ok' }));
  app.get('/health/ready', { config: { rateLimit: false } }, async (_req, reply) => {
    const checks: Record<string, string> = {};
    try {
      await db.query('SELECT 1');
      checks.database = 'ok';
    } catch {
      checks.database = 'down';
    }
    if (redis)
      checks.redis = await redis
        .ping()
        .then(() => 'ok')
        .catch(() => 'degraded');
    checks.ai = ctx.ai.providerName;
    const ready = checks.database === 'ok';
    reply.code(ready ? 200 : 503);
    return { status: ready ? 'ready' : 'not_ready', checks };
  });
  app.get('/metrics', { config: { rateLimit: false } }, async (_req, reply) => {
    reply.type('text/plain; version=0.0.4');
    const lines = ['# TYPE ypl_http_requests_total counter', '# TYPE ypl_http_errors_total counter', '# TYPE ypl_http_request_ms_sum counter'];
    for (const [k, m] of metrics) {
      const [method, route] = k.split(' ');
      const labels = `method="${method}",route="${route}"`;
      lines.push(
        `ypl_http_requests_total{${labels}} ${m.count}`,
        `ypl_http_errors_total{${labels}} ${m.errors}`,
        `ypl_http_request_ms_sum{${labels}} ${m.totalMs.toFixed(1)}`,
      );
    }
    lines.push(`ypl_realtime_redis ${redis ? 1 : 0}`, `ypl_db_pool_total ${db.totalCount}`, `ypl_db_pool_idle ${db.idleCount}`);
    return lines.join('\n') + '\n';
  });

  // Dev-only outbox so the web app and tests can read verification/reset emails.
  if (config.APP_ENV === 'development' || config.APP_ENV === 'test') app.get('/dev/outbox', async () => ({ items: ctx.email.outbox ?? [] }));

  for (const mod of [
    authModule,
    profilesModule,
    postsModule,
    messagingModule,
    communitiesModule,
    eventsModule,
    commerceModule,
    searchModule,
    notificationsModule,
    safetyModule,
    privacyModule,
    aiModule,
    momentsModule,
    mediaModule,
    creatorModule,
    developerModule,
    memoryModule,
    tagsModule,
    liveModule,
    uploadsModule,
    callsModule,
    realModule,
    oauthModule,
    pushModule,
    miniAppsModule,
    economyModule,
    adsModule,
    familyModule,
    studioModule,
    plusModule,
    invitesModule,
    growthModule,
    publicModule,
  ])
    await mod(app, ctx);

  setPushSender(config.APP_ENV === 'test' ? null : createPushSender(db, config));

  // Webhook delivery worker. Tests drive processWebhooks directly instead.
  let webhookTimer: NodeJS.Timeout | undefined;
  if (opts.webhookWorker ?? config.APP_ENV !== 'test') {
    const allowLocal = config.APP_ENV === 'development';
    webhookTimer = setInterval(() => void processWebhooks(db, { allowLocal }).catch((e) => app.log.warn({ err: e.message }, 'webhook worker')), 5_000);
    webhookTimer.unref();
  }
  // Background jobs (media processing). Tests drive processJobs directly.
  let jobTimer: NodeJS.Timeout | undefined;
  const jobHandlers = {
    ...mediaJobHandlers({ db, storage }),
    ...studioJobHandlers({ db, storage, transcription: ctx.transcription }),
    ...liveRecordingJobHandlers({ db, storage, recordingsDir: config.LIVE_RECORDINGS_DIR }),
    ...shareVideoJobHandlers({ db, storage }),
  };
  if (opts.webhookWorker ?? config.APP_ENV !== 'test') {
    let busy = false;
    jobTimer = setInterval(async () => {
      if (busy) return;
      busy = true;
      await processJobs(db, jobHandlers).catch((e) => app.log.warn({ err: e.message }, 'job worker'));
      busy = false;
    }, 2_000);
    jobTimer.unref();
  }

  return {
    app,
    ctx,
    close: async () => {
      clearInterval(webhookTimer);
      clearInterval(jobTimer);
      await app.close();
      await db.end();
      sub?.disconnect();
      redis?.disconnect();
    },
  };
}
