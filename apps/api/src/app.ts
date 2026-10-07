import Fastify, { type FastifyInstance, type RouteOptions } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { Redis } from 'ioredis';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createPool } from '@yapilapi/database';
// Every message catalog, loaded up front, so anything the API writes can be in any language at once.
import '@yapilapi/shared/i18n';
import { runInRequest, withRequestContext } from './lib/request-context.ts';
import type { Config } from './config.ts';
import type { AppContext } from './lib/context.ts';
import { AppError } from './lib/errors.ts';
import { requestLocale, translateDetails, translateMessage } from './lib/error-language.ts';
import { RealtimeHub } from './lib/realtime.ts';
import { AiGateway } from './lib/ai/gateway.ts';
import { anthropicProvider, devProvider } from './lib/ai/providers.ts';
import { logEmailSender, smtpEmailSender, type MailTransport } from './lib/email.ts';
import { localDiskStorage, s3Storage } from './lib/storage.ts';
import { devPaymentProvider, paymentRegistry, paystackPaymentProvider, stripePaymentProvider } from './lib/payments.ts';
import { transcriberFromConfig } from './lib/transcription.ts';
import { devSmsProvider, twilioSmsProvider } from './lib/sms.ts';
import { mediaModeratorFromConfig } from './lib/media-moderation.ts';
import { registerAuth } from './plugins/auth.ts';
import { MAX_UPLOAD_BYTES } from './modules/media.ts';
import authModule from './modules/auth.ts';
import { registerDataSaver } from './lib/data-saver.ts';
import profilesModule from './modules/profiles.ts';
import postsModule from './modules/posts.ts';
import recommendationsModule from './modules/recommendations.ts';
import commentsModule from './modules/comments.ts';
import askModule from './modules/ask.ts';
import mixesModule from './modules/mixes.ts';
import draftsModule from './modules/drafts.ts';
import messagingModule from './modules/messaging.ts';
import communitiesModule from './modules/communities.ts';
import eventsModule from './modules/events.ts';
import ticketsModule from './modules/tickets.ts';
import commerceModule from './modules/commerce.ts';
import searchModule from './modules/search.ts';
import notificationsModule from './modules/notifications.ts';
import safetyModule from './modules/safety.ts';
import adminModule from './modules/admin.ts';
import privacyModule from './modules/privacy.ts';
import aiModule from './modules/ai.ts';
import momentsModule from './modules/moments.ts';
import chaptersModule, { openDueChapters } from './modules/chapters.ts';
import boardsModule from './modules/boards.ts';
import mediaModule from './modules/media.ts';
import creatorModule from './modules/creator.ts';
import payoutsModule from './modules/payouts.ts';
import developerModule from './modules/developer.ts';
import memoryModule from './modules/memory.ts';
import recapsModule from './modules/recaps.ts';
import wrapsModule from './modules/wraps.ts';
import liveModule from './modules/live.ts';
import uploadsModule from './modules/uploads.ts';
import callsModule from './modules/calls.ts';
import roomsModule from './modules/rooms.ts';
import realModule from './modules/real.ts';
import oauthModule from './modules/oauth.ts';
import pushModule from './modules/push.ts';
import miniAppsModule from './modules/miniapps.ts';
import economyModule from './modules/economy.ts';
import adsModule from './modules/ads.ts';
import familyModule from './modules/family.ts';
import studioModule from './modules/studio.ts';
import editorModule from './modules/editor.ts';
import collagesModule from './modules/collages.ts';
import echoesModule from './modules/echoes.ts';
import tagsModule from './modules/tags.ts';
import collabsModule from './modules/collabs.ts';
import postCoversModule from './modules/post-covers.ts';
import soundsModule from './modules/sounds.ts';
import plusModule from './modules/plus.ts';
import invitesModule from './modules/invites.ts';
import phoneModule from './modules/phone.ts';
import publicModule from './modules/public.ts';
import growthModule from './modules/growth.ts';
import moneyModule from './modules/money.ts';
import dropsModule from './modules/drops.ts';
import marketModule from './modules/market.ts';
import musicModule from './modules/music.ts';
import { musicCatalogFromConfig } from './lib/music/index.ts';
import { createPushSender } from './lib/push.ts';
import { securityMailer, setPushSender, setSecurityMailer, unsetSecurityMailer } from './lib/services.ts';
import { processWebhooks } from './lib/webhooks.ts';
import { processJobs } from './lib/jobs.ts';
import { sweepTogethers } from './lib/together.ts';
import { mediaJobHandlers } from './lib/media-processing.ts';
import { studioJobHandlers } from './lib/studio.ts';
import { editorJobHandlers } from './lib/media-edit.ts';
import { videoCoverJobHandlers } from './lib/video-covers.ts';
import { liveRecordingJobHandlers } from './lib/live-recording.ts';
import { shareVideoJobHandlers } from './lib/share-video.ts';
import { recapJobHandlers } from './lib/recaps.ts';
import { sweepViewOnce, viewOnceJobHandlers } from './lib/view-once.ts';
import { chatJobHandlers, expireMessages } from './lib/chat.ts';
import { expireShares, locationJobHandlers } from './lib/location.ts';
import { scheduledPostJobHandlers } from './lib/publishing.ts';
import { linkIconJobHandlers } from './lib/link-icons.ts';
import { fastifyTracingPlugin, traceLogMixin } from './lib/tracing.ts';
import { endExpiredCampaigns } from './lib/boosts.ts';
import { sendCountdownReminders } from './lib/stories.ts';
import { meshRoomMedia } from './lib/room-media.ts';
import { sweepRooms } from './lib/rooms.ts';
import { sweepLives } from './lib/live.ts';
import { sweepWatch } from './lib/watch.ts';
import { sweepWeeklyWraps } from './lib/wrap.ts';
import { maybeRunRetention } from './lib/retention.ts';
import { sweepMarket } from './lib/market.ts';
import Stripe from 'stripe';
import { adminEmails, promoteListedAdmins } from './lib/admin-bootstrap.ts';
import { ensureStripeWebhook, isStripeWebhookSecret, stripeWebhookUrl } from './lib/stripe-webhook-setup.ts';

export interface BuiltApp {
  app: FastifyInstance;
  ctx: AppContext;
  close: () => Promise<void>;
}

export async function buildApp(
  config: Config,
  opts: {
    logger?: boolean;
    onRoute?: (route: RouteOptions) => void;
    webhookWorker?: boolean;
    /** Used for calls to Paystack (tests pass a fake so nothing leaves the machine). */
    paystackFetch?: typeof fetch;
    /** Used for calls to music catalogue providers (tests pass a fake). */
    musicFetch?: typeof fetch;
    /** Replaces the SMTP connection with EMAIL_TRANSPORT=smtp (tests pass a fake). */
    mailTransport?: MailTransport;
  } = {},
): Promise<BuiltApp> {
  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : {
            level: config.APP_ENV === 'production' ? 'info' : 'debug',
            // Never log credentials or session tokens, nor a place someone shared (request bodies aren't logged either).
            redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]', '*.password', '*.token', '*.lat', '*.lng'],
            // With tracing on, log lines carry trace_id/span_id next to reqId.
            mixin: traceLogMixin(),
          },
    genReqId: (req) => (req.headers['x-request-id'] as string) || randomUUID(),
    trustProxy: config.TRUST_PROXY,
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
  // Accounts listed in ADMIN_EMAILS that are confirmed by now become admins.
  const promoted = await promoteListedAdmins(db, adminEmails(config.ADMIN_EMAILS)).catch((e: Error) => {
    console.warn(`ADMIN_EMAILS: ${e.message}`);
    return 0;
  });
  if (promoted) console.info(`ADMIN_EMAILS: ${promoted} account(s) made admin.`);
  let redis: Redis | undefined;
  let sub: Redis | undefined;
  // The last thing Redis said went wrong, as a code only (ECONNREFUSED, ENOTFOUND…), for /health/ready.
  let redisProblem: string | null = null;
  if (config.REDIS_URL) {
    // family 0: IPv4 or IPv6, whichever the name resolves to (private networks such as Render's can be IPv6 only).
    redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: false, family: 0 });
    sub = redis.duplicate();
    // Degrade gracefully: Redis outages must not take the API down.
    redis.on('error', (e: Error & { code?: string }) => {
      redisProblem = e.code ?? e.name;
      app.log.warn({ err: e.message }, 'redis error');
    });
    redis.on('ready', () => (redisProblem = null));
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

  // Without a pasted signing secret, the API sets up its own Stripe webhook and uses the secret Stripe returns.
  let stripeWebhookSecret = config.STRIPE_WEBHOOK_SECRET;
  const defaultPayments =
    config.PAYMENTS_PROVIDER === 'stripe'
      ? stripePaymentProvider({
          secretKey: config.STRIPE_SECRET_KEY,
          webhookSecret: () => stripeWebhookSecret,
          publishableKey: config.STRIPE_PUBLISHABLE_KEY,
        })
      : devPaymentProvider(config.PAYMENTS_WEBHOOK_SECRET);
  const webhookUrl = stripeWebhookUrl(process.env);
  if (config.PAYMENTS_PROVIDER === 'stripe' && !isStripeWebhookSecret(config.STRIPE_WEBHOOK_SECRET) && webhookUrl)
    void ensureStripeWebhook({
      db,
      stripe: new Stripe(config.STRIPE_SECRET_KEY, { timeout: 20_000 }),
      url: webhookUrl,
      mfaKey: config.MFA_ENCRYPTION_KEY,
    }).then(
      (secret) => {
        stripeWebhookSecret = secret;
        app.log.info({ url: webhookUrl }, 'Stripe webhook ready');
      },
      (e: Error) => app.log.warn({ err: e.message }, 'Stripe webhook could not be set up; paste its signing secret into STRIPE_WEBHOOK_SECRET'),
    );
  // Paystack takes its own currencies (NGN, GHS, KES, ZAR) when its keys are set; everything else stays with the default.
  const paystack = config.PAYSTACK_SECRET_KEY
    ? paystackPaymentProvider({
        secretKey: config.PAYSTACK_SECRET_KEY,
        publicKey: config.PAYSTACK_PUBLIC_KEY,
        callbackUrl: `${config.WEB_ORIGIN.split(',')[0]!.replace(/\/+$/, '')}/checkout/done`,
        fetch: opts.paystackFetch,
      })
    : null;

  const realtime = new RealtimeHub(redis, sub);
  const ctx: AppContext = {
    config,
    db,
    redis,
    realtime,
    ai: new AiGateway(db, provider, storage),
    email:
      config.EMAIL_TRANSPORT === 'smtp'
        ? smtpEmailSender({ url: config.SMTP_URL, from: config.EMAIL_FROM, transport: opts.mailTransport })
        : logEmailSender(app.log),
    storage,
    payments: defaultPayments,
    paymentProviders: paymentRegistry(defaultPayments, paystack ? [paystack] : []),
    transcription: transcriberFromConfig(config),
    sms:
      config.SMS_PROVIDER === 'twilio'
        ? twilioSmsProvider({ accountSid: config.TWILIO_ACCOUNT_SID, authToken: config.TWILIO_AUTH_TOKEN, serviceSid: config.TWILIO_VERIFY_SERVICE_SID })
        : devSmsProvider((msg) => app.log.info(msg)),
    mediaModerator: mediaModeratorFromConfig(config),
    roomMedia: meshRoomMedia(config, realtime),
    music: musicCatalogFromConfig(config, db, { fetch: opts.musicFetch, log: (msg, err) => app.log.warn({ err: (err as Error)?.message }, msg) }),
    jobs: {},
  };
  if (config.APP_ENV === 'production' && config.SMS_PROVIDER === 'dev')
    app.log.warn('SMS_PROVIDER=dev in production: phone codes are only written to the log. Configure Twilio Verify.');
  if (config.APP_ENV === 'production' && ctx.mediaModerator.name === 'none')
    app.log.warn('MEDIA_MODERATION_PROVIDER is none: photos and videos are not checked automatically.');

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
    await app.register(fastifyStatic, {
      root: path.resolve(config.UPLOAD_DIR),
      prefix: '/media/',
      decorateReply: false,
      maxAge: '365d',
      immutable: true,
      // Lets the web app count the bytes of media it loads (Settings, "Data used this session").
      setHeaders: (res) => void res.header('timing-allow-origin', '*'),
    });
  else
    app.get('/media/*', { config: { rateLimit: false } }, async (req, reply) => {
      const key = (req.params as { '*': string })['*'];
      // private/ holds digital products: only buyers get them, through /v1/downloads.
      if (!/^[\w/.-]+$/.test(key) || key.includes('..') || key.startsWith('private/')) return reply.code(404).send();
      const obj = await storage.get!(key, req.headers.range);
      if (!obj) return reply.code(404).send({ error: { code: 'not_found', message: 'Media not found.' } });
      reply.code(obj.status).header('cache-control', 'public, max-age=31536000, immutable').header('accept-ranges', 'bytes').header('timing-allow-origin', '*');
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
  // Lite responses for Data saver (?lite=1 or Save-Data: on).
  registerDataSaver(app);

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

  // Messages go out in the reader's language (lib/error-language.ts); code, status and the rest of
  // details stay as they are.
  app.setErrorHandler((err, req, reply) => {
    const locale = requestLocale(req);
    const say = (message: string) => translateMessage(message, locale);
    if (err instanceof AppError)
      return reply
        .code(err.status)
        .send({ error: { code: err.code, message: say(err.message), details: translateDetails(err.details, locale), requestId: req.id } });
    const e = err as { statusCode?: number; code?: string; message: string };
    if (e.statusCode === 429) {
      // The rate limiter's own response (errorResponseBuilder above).
      const limited = err as { error?: { message?: string } };
      if (typeof limited.error?.message === 'string') limited.error.message = say(limited.error.message);
      return reply.code(429).send(err);
    }
    if (e.code === 'FST_REQ_FILE_TOO_LARGE')
      return reply.code(413).send({ error: { code: 'too_large', message: say('Files can be up to 50 MB.'), requestId: req.id } });
    if (e.statusCode && e.statusCode < 500)
      return reply.code(e.statusCode).send({ error: { code: e.code ?? 'bad_request', message: e.message, requestId: req.id } });
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal', message: say('Something went wrong on our side. Try again.'), requestId: req.id } });
  });

  app.setNotFoundHandler((req, reply) =>
    reply
      .code(404)
      .send({ error: { code: 'not_found', message: translateMessage(`No route for ${req.method} ${req.url}.`, requestLocale(req)), requestId: req.id } }),
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
    // At most a second for Redis: the API serves without it, and the host's health check gives up after 5 seconds.
    if (redis) {
      const ping = redis.ping().then(
        () => 'ok',
        () => 'degraded',
      );
      const late = new Promise<string>((resolve) => setTimeout(() => resolve('degraded'), 1000).unref());
      checks.redis = await Promise.race([ping, late]);
      if (checks.redis !== 'ok' && redisProblem) checks.redisProblem = redisProblem;
    }
    checks.ai = ctx.ai.providerName;
    const ready = checks.database === 'ok';
    reply.code(ready ? 200 : 503);
    return { status: ready ? 'ready' : 'not_ready', checks };
  });
  app.get('/metrics', { config: { rateLimit: false } }, async (req, reply) => {
    // Route names and error counts are for the people running the service: in production only with the token.
    const token = config.METRICS_TOKEN;
    const given = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const allowed = token ? given.length === token.length && timingSafeEqual(Buffer.from(given), Buffer.from(token)) : config.APP_ENV !== 'production';
    // Otherwise it answers like any route that isn't there.
    if (!allowed) return reply.callNotFound();
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
  if (config.APP_ENV === 'development' || config.APP_ENV === 'test') {
    app.get('/dev/outbox', async () => ({ items: ctx.email.outbox ?? [] }));
    // Phone codes from the dev SMS provider, for the web app and tests.
    app.get('/dev/sms-outbox', async () => ({ items: 'outbox' in ctx.sms ? ctx.sms.outbox : [] }));
  }

  for (const mod of [
    authModule,
    profilesModule,
    postsModule,
    recommendationsModule,
    commentsModule,
    askModule,
    draftsModule,
    messagingModule,
    communitiesModule,
    eventsModule,
    ticketsModule,
    commerceModule,
    searchModule,
    notificationsModule,
    safetyModule,
    adminModule,
    privacyModule,
    aiModule,
    momentsModule,
    chaptersModule,
    boardsModule,
    mediaModule,
    creatorModule,
    payoutsModule,
    developerModule,
    memoryModule,
    recapsModule,
    wrapsModule,
    tagsModule,
    collabsModule,
    postCoversModule,
    soundsModule,
    musicModule,
    mixesModule,
    liveModule,
    uploadsModule,
    callsModule,
    roomsModule,
    realModule,
    oauthModule,
    pushModule,
    miniAppsModule,
    economyModule,
    adsModule,
    familyModule,
    studioModule,
    editorModule,
    collagesModule,
    echoesModule,
    plusModule,
    invitesModule,
    growthModule,
    publicModule,
    moneyModule,
    dropsModule,
    marketModule,
    phoneModule,
  ])
    await mod(app, ctx);

  setPushSender(config.APP_ENV === 'test' ? null : createPushSender(db, config));
  // Security notices (password changed, two-step verification off, ...) go to the account's email address.
  const mailer = securityMailer(ctx, app.log);
  setSecurityMailer(mailer);

  // Webhook delivery worker. Tests drive processWebhooks directly instead.
  let webhookTimer: NodeJS.Timeout | undefined;
  if (opts.webhookWorker ?? config.JOB_WORKER) {
    const allowLocal = config.APP_ENV === 'development';
    webhookTimer = setInterval(() => void processWebhooks(db, { allowLocal }).catch((e) => app.log.warn({ err: e.message }, 'webhook worker')), 5_000);
    webhookTimer.unref();
  }
  // Background jobs (media processing). Tests drive processJobs directly.
  let jobTimer: NodeJS.Timeout | undefined;
  const viewOnceDeps = { db, config, storage, realtime: ctx.realtime, moderator: ctx.mediaModerator };
  let lastViewOnceSweep = 0;
  let lastRoomSweep = 0;
  let lastWrapSweep = 0;
  let lastMusicRefresh = 0;
  let lastRetentionCheck = 0;
  const jobHandlers = {
    ...mediaJobHandlers({ db, storage, moderator: ctx.mediaModerator, realtime: ctx.realtime }),
    ...studioJobHandlers({ db, storage, transcription: ctx.transcription, log: app.log }),
    ...editorJobHandlers({ db, storage, log: app.log }),
    ...videoCoverJobHandlers({ storage }),
    ...liveRecordingJobHandlers({ db, storage, recordingsDir: config.LIVE_RECORDINGS_DIR }),
    ...shareVideoJobHandlers({ db, storage }),
    // Recap videos from Memories and Chapters.
    ...recapJobHandlers({ db, storage, realtime: ctx.realtime, moderator: ctx.mediaModerator, log: app.log }),
    ...viewOnceJobHandlers(viewOnceDeps),
    ...chatJobHandlers(viewOnceDeps),
    // Live location shares stop at their time, and their point is deleted.
    ...locationJobHandlers({ db, realtime: ctx.realtime }),
    // Scheduled posts go out at their time.
    ...scheduledPostJobHandlers(ctx),
    // Site icons for profile links, fetched through safeFetch (lib/safe-fetch.ts).
    ...linkIconJobHandlers(db),
    // Jobs the modules added (messages sent later).
    ...ctx.jobs,
  };
  if (opts.webhookWorker ?? config.JOB_WORKER) {
    let busy = false;
    jobTimer = setInterval(async () => {
      if (busy) return;
      busy = true;
      await processJobs(db, jobHandlers).catch((e) => app.log.warn({ err: e.message }, 'job worker'));
      // Campaigns and boosts past their end date stop, and their unspent budget is refunded.
      await endExpiredCampaigns(db, ctx.paymentProviders).catch((e) => app.log.warn({ err: e.message }, 'ad expiry'));
      // Time capsules whose date has come: tell the owner and contributors.
      await openDueChapters(db, ctx.realtime).catch((e) => app.log.warn({ err: e.message }, 'chapter capsules'));
      // Together albums: close those whose time has come, and tell members an hour before and when they close.
      await sweepTogethers({ db, realtime: ctx.realtime }).catch((e) => app.log.warn({ err: e.message }, 'together sweep'));
      // Once a minute: delete view-once files everyone has seen, 14-day-old ones and those of deleted messages.
      if (Date.now() - lastViewOnceSweep > 60_000) {
        lastViewOnceSweep = Date.now();
        await sweepViewOnce(viewOnceDeps).catch((e) => app.log.warn({ err: e.message }, 'view-once sweep'));
        // Disappearing messages past their time (each also has its own job; this catches any that were missed).
        await expireMessages(viewOnceDeps).catch((e) => app.log.warn({ err: e.message }, 'disappearing messages'));
      }
      // Audio rooms: people whose app went quiet leave, and rooms without a host for five minutes end.
      if (Date.now() - lastRoomSweep > 10_000) {
        lastRoomSweep = Date.now();
        await sweepRooms({ db, realtime: ctx.realtime, media: ctx.roomMedia }).catch((e) => app.log.warn({ err: e.message }, 'room sweep'));
        // Watch together: people whose player went quiet leave, the host passes on, and sessions nobody watches end.
        await sweepWatch({ db, realtime: ctx.realtime }).catch((e) => app.log.warn({ err: e.message }, 'watch sweep'));
        // Live location shares past their time (each has its own job; this catches any that were missed).
        await expireShares({ db, realtime: ctx.realtime }).catch((e) => app.log.warn({ err: e.message }, 'location sweep'));
        // Lives left on without video, or for too long, end (lib/live.ts).
        await sweepLives({ db, realtime: ctx.realtime, config }).catch((e) => app.log.warn({ err: e.message }, 'live sweep'));
      }
      // Once a minute: weekly wraps (up to 200 at a time) for people whose Sunday evening has come (lib/wrap.ts).
      if (Date.now() - lastWrapSweep > 60_000) {
        lastWrapSweep = Date.now();
        await sweepWeeklyWraps({ db, realtime: ctx.realtime }).catch((e) => app.log.warn({ err: e.message }, 'weekly wraps'));
        // Market listings: a reminder before one ends, and a note when it has (lib/market.ts).
        await sweepMarket({ db, realtime: ctx.realtime }).catch((e) => app.log.warn({ err: e.message }, 'market sweep'));
      }
      // Every 10 minutes: songs in use are read again from their providers (withdrawn ones play silently with a note).
      if (Date.now() - lastMusicRefresh > 10 * 60_000) {
        lastMusicRefresh = Date.now();
        await ctx.music.refresh().catch((e) => app.log.warn({ err: e.message }, 'music refresh'));
      }
      // Once a day (checked hourly, claimed in the database so one instance does it): delete what we no longer keep (lib/retention.ts).
      if (Date.now() - lastRetentionCheck > 60 * 60_000) {
        lastRetentionCheck = Date.now();
        // Not awaited: a long clean-up must not hold up media processing.
        void maybeRunRetention({ db, storage, config }).then(
          (r) => r && app.log.info({ counts: r.counts, errors: r.errors }, 'retention'),
          (e: Error) => app.log.warn({ err: e.message }, 'retention'),
        );
      }
      // Story countdowns that ended: remind the people who asked.
      await sendCountdownReminders(db, ctx.realtime).catch((e) => app.log.warn({ err: e.message }, 'countdown reminders'));
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
      unsetSecurityMailer(mailer);
      await app.close();
      await db.end();
      sub?.disconnect();
      redis?.disconnect();
    },
  };
}
