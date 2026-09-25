import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from '@yapilapi/config';
import type { Db } from '@yapilapi/database';
import type { PubSub } from './pubsub.js';
import type { EmailSender } from './email.js';
import type { RateLimiter } from './rate-limit.js';
import type { FeatureFlags } from './flags.js';
import type { Metrics } from './metrics.js';
import type { PushSender } from './push.js';

/** Everything a module needs; passed explicitly (no globals) so tests can build isolated apps. */
export interface AppContext {
  config: AppConfig;
  db: Db;
  log: FastifyBaseLogger;
  pubsub: PubSub;
  email: EmailSender;
  limiter: RateLimiter;
  flags: FeatureFlags;
  metrics: Metrics;
  /** Push delivery adapter (log in development, Expo in production). Mutable so tests can swap in a MemoryPushSender. */
  push: PushSender;
}
