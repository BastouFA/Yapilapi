import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import type { Config } from '../config.ts';
import type { RealtimeHub } from './realtime.ts';
import type { AiGateway } from './ai/gateway.ts';
import type { EmailSender } from './email.ts';
import type { MediaStorage } from './storage.ts';
import type { PaymentProvider, PaymentRegistry } from './payments.ts';
import type { TranscriptionProvider } from './transcription.ts';
import type { SmsProvider } from './sms.ts';
import type { MediaModerator } from './media-moderation.ts';
import type { RoomMedia } from './room-media.ts';
import type { MusicCatalog } from './music/index.ts';
import type { JobHandler } from './jobs.ts';

/** Everything a module needs, created once in buildApp. */
export interface AppContext {
  config: Config;
  db: Pool;
  redis?: Redis;
  realtime: RealtimeHub;
  ai: AiGateway;
  email: EmailSender;
  storage: MediaStorage;
  /** The default payment provider (PAYMENTS_PROVIDER). */
  payments: PaymentProvider;
  /** Every configured provider: pick one by currency for new payments, by name for refunds and webhooks. */
  paymentProviders: PaymentRegistry;
  /** Speech-to-text for automatic captions; null when not configured. */
  transcription: TranscriptionProvider | null;
  /** Phone verification codes (dev logs them; Twilio Verify in production). */
  sms: SmsProvider;
  /** Automated image and video checks, run in the media job. */
  mediaModerator: MediaModerator;
  /** How audio rooms move their audio: a WebRTC mesh today; an SFU adapter can replace it (lib/room-media.ts). */
  roomMedia: RoomMedia;
  /** Music from the sounds library and the catalogue providers that are switched on (lib/music). */
  music: MusicCatalog;
  /**
   * Background jobs that modules add while they register (messages scheduled to send later, for
   * example). The worker runs them with the rest; tests run them with processJobs(db, ctx.jobs).
   */
  jobs: Record<string, JobHandler>;
}
