import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  API_PORT: z.coerce.number().default(4000),
  API_HOST: z.string().default('0.0.0.0'),
  WEB_ORIGIN: z.string().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().optional().default(''),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  COOKIE_SECURE: bool,
  EMAIL_TRANSPORT: z.enum(['log', 'smtp']).default('log'),
  EMAIL_FROM: z.string().default('YAPILAPI <no-reply@yapilapi.local>'),
  AI_PROVIDER: z.enum(['dev', 'anthropic']).default('dev'),
  AI_MODEL: z.string().default('claude-opus-5'),
  ANTHROPIC_API_KEY: z.string().optional().default(''),
  PAYMENTS_PROVIDER: z.enum(['dev', 'stripe']).default('dev'),
  /** Stripe (PAYMENTS_PROVIDER=stripe): secret key, webhook signing secret, and the publishable key the browser uses. */
  STRIPE_SECRET_KEY: z.string().default(''),
  STRIPE_WEBHOOK_SECRET: z.string().default(''),
  STRIPE_PUBLISHABLE_KEY: z.string().default(''),
  PAYMENTS_WEBHOOK_SECRET: z.string().default('dev-webhook-secret-change-me'),
  /** Paystack (optional): takes NGN, GHS, KES and ZAR payments (cards and mobile money). Other currencies stay with PAYMENTS_PROVIDER. */
  PAYSTACK_SECRET_KEY: z.string().default(''),
  PAYSTACK_PUBLIC_KEY: z.string().default(''),
  /** Where digital products are stored on disk with the local storage driver. Never served as public media. */
  PRIVATE_UPLOAD_DIR: z.string().default('./uploads-private'),
  /** YAPILAPI Plus: the price of one month (30 days), in hundredths of PLUS_CURRENCY. */
  PLUS_PRICE_CENTS: z.coerce.number().int().min(50).max(100_000).default(499),
  PLUS_CURRENCY: z.string().length(3).toUpperCase().default('USD'),
  // 32 bytes, base64. Encrypts TOTP secrets at rest. Development falls back to a fixed dev key.
  MFA_ENCRYPTION_KEY: z.string().optional().default(''),
  // Passkeys: the site's domain and origin. Default to WEB_ORIGIN.
  WEBAUTHN_RP_ID: z.string().optional().default(''),
  WEBAUTHN_ORIGIN: z.string().optional().default(''),
  // Web push (VAPID). Generate with: npx web-push generate-vapid-keys
  VAPID_PUBLIC_KEY: z.string().optional().default(''),
  VAPID_PRIVATE_KEY: z.string().optional().default(''),
  VAPID_SUBJECT: z.string().default('mailto:support@yapilapi.local'),
  // Live video (MediaMTX): where viewers load HLS, and the secret MediaMTX sends to our auth hook.
  LIVE_HLS_BASE: z.string().default('http://localhost:8888'),
  LIVE_RTMP_URL: z.string().default('rtmp://localhost:1935'),
  LIVE_HOOK_SECRET: z.string().default('dev-live-hook-secret'),
  /** MediaMTX control API (e.g. http://localhost:9997). When set, ending a live disconnects the encoder. */
  LIVE_CONTROL_URL: z.string().default(''),
  /** Header a trusted CDN sets with the visitor's country (e.g. cf-ipcountry). Unset: only the country people choose is used. */
  TRUSTED_COUNTRY_HEADER: z.string().optional(),
  /** Folder MediaMTX records lives into (see infrastructure/media/mediamtx.yml). Unset: no recordings or auto-clips. */
  LIVE_RECORDINGS_DIR: z.string().optional(),
  // TURN (coturn, REST credentials): shared secret and URLs.
  TURN_URLS: z.string().optional().default(''),
  TURN_SECRET: z.string().optional().default(''),
  UPLOAD_DIR: z.string().default('./uploads'),
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  S3_ENDPOINT: z.string().optional().default(''),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('yapilapi-media'),
  S3_ACCESS_KEY_ID: z.string().default('dev'),
  S3_SECRET_ACCESS_KEY: z.string().default('dev'),
  S3_FORCE_PATH_STYLE: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),
  PUBLIC_API_URL: z.string().default('http://localhost:4000'),
  // Automatic captions (speech-to-text). Off unless a provider is configured.
  TRANSCRIBE_PROVIDER: z.enum(['none', 'openai-compatible']).default('none'),
  TRANSCRIBE_API_URL: z.string().optional().default(''),
  TRANSCRIBE_API_KEY: z.string().optional().default(''),
  TRANSCRIBE_MODEL: z.string().default('whisper-1'),
  RATE_LIMIT_MAX: z.coerce.number().default(300),
  /**
   * Posting publicly, messaging people who aren't friends and going live need a confirmed email or phone number.
   * Unset: on in production, off elsewhere (tests and local development sign up without confirming).
   */
  REQUIRE_VERIFICATION: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? undefined : v === 'true' || v === '1')),
  /** Sign-up risk scoring, new-account velocity limits and link-spam checks. Unset: on everywhere except tests. */
  SPAM_CHECKS: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? undefined : v === 'true' || v === '1')),
  /** Phone verification codes: dev logs them (and keeps them for tests); twilio sends them with Twilio Verify. */
  SMS_PROVIDER: z.enum(['dev', 'twilio']).default('dev'),
  TWILIO_ACCOUNT_SID: z.string().default(''),
  TWILIO_AUTH_TOKEN: z.string().default(''),
  TWILIO_VERIFY_SERVICE_SID: z.string().default(''),
  /** Automated image and video checks in the media job. Unset: dev outside production, none in production. */
  MEDIA_MODERATION_PROVIDER: z.enum(['dev', 'rekognition', 'none']).optional(),
  /** AWS Rekognition (MEDIA_MODERATION_PROVIDER=rekognition). */
  REKOGNITION_REGION: z.string().default('us-east-1'),
  REKOGNITION_ACCESS_KEY_ID: z.string().default(''),
  REKOGNITION_SECRET_ACCESS_KEY: z.string().default(''),
  REKOGNITION_SESSION_TOKEN: z.string().default(''),
});

const resolved = schema.transform((c) => ({
  ...c,
  REQUIRE_VERIFICATION: c.REQUIRE_VERIFICATION ?? c.APP_ENV === 'production',
  SPAM_CHECKS: c.SPAM_CHECKS ?? c.APP_ENV !== 'test',
  MEDIA_MODERATION_PROVIDER: c.MEDIA_MODERATION_PROVIDER ?? (c.APP_ENV === 'production' ? ('none' as const) : ('dev' as const)),
}));

export type Config = z.infer<typeof resolved>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = resolved.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${msg}`);
  }
  const cfg = parsed.data;
  if (cfg.PAYMENTS_PROVIDER === 'stripe' && (!cfg.STRIPE_SECRET_KEY || !cfg.STRIPE_WEBHOOK_SECRET || !cfg.STRIPE_PUBLISHABLE_KEY))
    throw new Error('PAYMENTS_PROVIDER=stripe needs STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and STRIPE_PUBLISHABLE_KEY.');
  if (!!cfg.PAYSTACK_SECRET_KEY !== !!cfg.PAYSTACK_PUBLIC_KEY) throw new Error('Paystack needs both PAYSTACK_SECRET_KEY and PAYSTACK_PUBLIC_KEY.');
  if (cfg.SMS_PROVIDER === 'twilio' && (!cfg.TWILIO_ACCOUNT_SID || !cfg.TWILIO_AUTH_TOKEN || !cfg.TWILIO_VERIFY_SERVICE_SID))
    throw new Error('SMS_PROVIDER=twilio needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_VERIFY_SERVICE_SID.');
  if (cfg.MEDIA_MODERATION_PROVIDER === 'rekognition' && (!cfg.REKOGNITION_ACCESS_KEY_ID || !cfg.REKOGNITION_SECRET_ACCESS_KEY))
    throw new Error('MEDIA_MODERATION_PROVIDER=rekognition needs REKOGNITION_ACCESS_KEY_ID and REKOGNITION_SECRET_ACCESS_KEY.');
  if (cfg.APP_ENV === 'production') {
    if (cfg.PAYMENTS_PROVIDER === 'dev') throw new Error('The development payment provider moves no money. Set PAYMENTS_PROVIDER for production.');
    if (Buffer.from(cfg.MFA_ENCRYPTION_KEY, 'base64').length !== 32) throw new Error('Set MFA_ENCRYPTION_KEY (32 bytes, base64) for production.');
    if (!cfg.COOKIE_SECURE) throw new Error('COOKIE_SECURE must be true in production.');
  }
  return cfg;
}
