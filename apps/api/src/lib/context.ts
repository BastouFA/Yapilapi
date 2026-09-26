import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import type { Config } from '../config.ts';
import type { RealtimeHub } from './realtime.ts';
import type { AiGateway } from './ai/gateway.ts';
import type { EmailSender } from './email.ts';
import type { MediaStorage } from './storage.ts';
import type { PaymentProvider } from './payments.ts';
import type { TranscriptionProvider } from './transcription.ts';
import type { SmsProvider } from './sms.ts';
import type { MediaModerator } from './media-moderation.ts';

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
  /** Speech-to-text for automatic captions; null when not configured. */
  transcription: TranscriptionProvider | null;
  /** Phone verification codes (dev logs them; Twilio Verify in production). */
  sms: SmsProvider;
  /** Automated image and video checks, run in the media job. */
  mediaModerator: MediaModerator;
}
