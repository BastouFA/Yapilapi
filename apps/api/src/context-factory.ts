import pino from 'pino';
import { loadConfig, type AppConfig } from '@yapilapi/config';
import { createPool } from '@yapilapi/database';
import { redact } from '@yapilapi/security';
import type { AppContext } from './lib/context.js';
import { MemoryPubSub, RedisPubSub, type PubSub } from './lib/pubsub.js';
import { MemoryRateLimiter, RedisRateLimiter, type RateLimiter } from './lib/rate-limit.js';
import { ConsoleEmailSender, SmtpEmailSender, type EmailSender } from './lib/email.js';
import { FeatureFlags } from './lib/flags.js';
import { createMetrics } from './lib/metrics.js';
import { ExpoPushSender, LogPushSender, type PushSender } from './lib/push.js';

export interface ContextOverrides {
  email?: EmailSender;
  pubsub?: PubSub;
  limiter?: RateLimiter;
  push?: PushSender;
}

export function createLogger(config: AppConfig) {
  return pino({
    level: config.LOG_LEVEL,
    base: { service: 'yapilapi-api', env: config.APP_ENV },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        'body.password',
        'body.currentPassword',
        'body.newPassword',
      ],
      censor: '[REDACTED]',
    },
    formatters: { log: (obj) => redact(obj) },
  });
}

/** Wire real adapters from config. Redis is optional in development (falls back to memory). */
export function createContext(
  config: AppConfig = loadConfig(),
  overrides: ContextOverrides = {},
): AppContext {
  const log = createLogger(config);
  const db = createPool(config.DATABASE_URL, { max: config.DATABASE_POOL_MAX });

  const useRedis = Boolean(config.REDIS_URL);
  const pubsub =
    overrides.pubsub ?? (useRedis ? new RedisPubSub(config.REDIS_URL!) : new MemoryPubSub());
  const limiter =
    overrides.limiter ??
    (useRedis ? new RedisRateLimiter(config.REDIS_URL!) : new MemoryRateLimiter());
  const email =
    overrides.email ??
    (config.EMAIL_ADAPTER === 'smtp' && config.SMTP_URL
      ? new SmtpEmailSender(config.SMTP_URL, config.EMAIL_FROM)
      : new ConsoleEmailSender((line) => log.info(line)));

  const push =
    overrides.push ??
    (config.PUSH_ADAPTER === 'expo'
      ? new ExpoPushSender(config.EXPO_ACCESS_TOKEN)
      : new LogPushSender((line) => log.info(line)));

  if (config.dataEncryptionKeyEphemeral) {
    log.warn(
      'DATA_ENCRYPTION_KEY not set: using an ephemeral key. Encrypted data (e.g. MFA secrets) will not survive restarts.',
    );
  }
  return {
    config,
    db,
    log,
    pubsub,
    email,
    limiter,
    flags: new FeatureFlags(db),
    metrics: createMetrics(config.METRICS_ENABLED),
    push,
  };
}
