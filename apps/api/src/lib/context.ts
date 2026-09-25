import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import type { Config } from '../config.ts';
import type { RealtimeHub } from './realtime.ts';
import type { AiGateway } from './ai/gateway.ts';
import type { EmailSender } from './email.ts';
import type { MediaStorage } from './storage.ts';
import type { PaymentProvider } from './payments.ts';

/** Everything a module needs, created once in buildApp. */
export interface AppContext {
  config: Config;
  db: Pool;
  redis?: Redis;
  realtime: RealtimeHub;
  ai: AiGateway;
  email: EmailSender;
  storage: MediaStorage;
  payments: PaymentProvider;
}
