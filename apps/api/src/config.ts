import { z } from 'zod';
import { ANDROID_DIGITAL_PURCHASE_MODES, IOS_DIGITAL_PURCHASE_MODES, parseCountryList } from '@yapilapi/shared';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const DEV_LIVE_HOOK_SECRET = 'dev-live-hook-secret';

/** TRUST_PROXY as Fastify takes it: true/false, the addresses and ranges to trust, or (for a number) the nearest that many hops. */
export function trustProxySetting(v: string): boolean | string[] | ((address: string, hop: number) => boolean) {
  const t = v.trim();
  if (t === 'true' || t === 'false') return t === 'true';
  if (/^\d+$/.test(t)) {
    const hops = Number(t);
    return (_address, hop) => hop < hops;
  }
  return t
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  API_PORT: z.coerce.number().default(4000),
  API_HOST: z.string().default('0.0.0.0'),
  WEB_ORIGIN: z.string().default('http://localhost:3000'),
  DATABASE_URL: z.string({ required_error: 'DATABASE_URL is required' }).min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().optional().default(''),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  COOKIE_SECURE: bool,
  /** log: emails are only written to the log (development and tests). smtp: sent through SMTP_URL. Production needs smtp. */
  EMAIL_TRANSPORT: z.enum(['log', 'smtp']).default('log'),
  /** SMTP connection URL (EMAIL_TRANSPORT=smtp), e.g. smtps://user:password@smtp.example.com:465. */
  SMTP_URL: z.string().default(''),
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
  /** How many years payment, refund and payout records are kept (the legal accounting period). See RETENTION in lib/retention.ts. */
  FINANCIAL_RECORDS_YEARS: z.coerce.number().int().min(1).max(30).default(7),
  /** Where digital products are stored on disk with the local storage driver. Never served as public media. */
  PRIVATE_UPLOAD_DIR: z.string().default('./uploads-private'),
  /** YAPILAPI Plus: the price of one month (30 days), in hundredths of PLUS_CURRENCY. */
  PLUS_PRICE_CENTS: z.coerce.number().int().min(50).max(100_000).default(499),
  PLUS_CURRENCY: z.string().length(3).toUpperCase().default('USD'),
  /**
   * How the phone apps offer digital goods (Plus, creator subscriptions, tips, boosts, downloads,
   * tickets to lives); see docs/operations/in-app-purchases.md. Physical goods and real-world
   * services are not affected, and the web checkout always works.
   * iPhone: hidden (no buy buttons or prices), external_link (a link to the web checkout in the
   * countries listed in IOS_EXTERNAL_LINK_COUNTRIES) or iap (Apple In-App Purchase, once the app
   * has a StoreKit module; until then like hidden).
   */
  IOS_DIGITAL_PURCHASES: z.enum(IOS_DIGITAL_PURCHASE_MODES).default('hidden'),
  /** Storefront countries where the iPhone app may link to the web checkout, e.g. "US" or "US,GB". */
  IOS_EXTERNAL_LINK_COUNTRIES: z.string().default('US').transform(parseCountryList),
  /** Android: play_billing_required (like hidden) or user_choice (a link to the web checkout in ANDROID_USER_CHOICE_COUNTRIES). */
  ANDROID_DIGITAL_PURCHASES: z.enum(ANDROID_DIGITAL_PURCHASE_MODES).default('play_billing_required'),
  ANDROID_USER_CHOICE_COUNTRIES: z.string().default('US').transform(parseCountryList),
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
  LIVE_HOOK_SECRET: z.string().default(DEV_LIVE_HOOK_SECRET),
  /** Lets a monitoring service read /metrics with "Authorization: Bearer <token>". Without it, production doesn't serve /metrics. */
  METRICS_TOKEN: z.string().default(''),
  /** Signs the tokens in event tickets' QR codes (at least 32 characters in production). Development uses a fixed dev secret. */
  TICKET_TOKEN_SECRET: z.string().default(''),
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
   * Which proxies may say who the caller is (X-Forwarded-For). The default trusts only proxies on
   * this machine and private networks (Render's, Docker's), so an address a client writes into the
   * header itself is never taken as theirs: rate limits and sign-in alerts see the real one. Set a
   * number of hops, "true", or a comma-separated list of addresses and ranges for other hosts.
   */
  TRUST_PROXY: z
    .string()
    .default('loopback,linklocal,uniquelocal')
    .transform((v) => trustProxySetting(v)),
  /** "See translation": how many translations one person can ask for in an hour (answers from the cache count too). */
  TRANSLATE_PER_HOUR: z.coerce.number().int().positive().default(300),
  /**
   * Run the background workers (media processing, recap videos, scheduled posts, webhooks, room
   * housekeeping) in this process. Unset: on everywhere except tests, which drive them directly.
   * The accessibility audit turns them on with APP_ENV=test so recaps get made.
   */
  JOB_WORKER: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? undefined : v === 'true' || v === '1')),
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
  /**
   * Music catalogue (docs/operations/music.md). Jamendo (Creative Commons songs): a free client id from
   * https://devportal.jamendo.com. Unset: off.
   */
  JAMENDO_CLIENT_ID: z.string().default(''),
  JAMENDO_API_URL: z.string().default('https://api.jamendo.com/v3.0'),
  /** A licensing partner's catalogue, once a deal is signed: its API address and key. Unset: off. */
  MUSIC_LICENSED_API_URL: z.string().default(''),
  MUSIC_LICENSED_API_KEY: z.string().default(''),
  /** The partner's name as the music picker shows it. */
  MUSIC_LICENSED_NAME: z.string().default('Licensed catalogue'),
  /** Generated "[Dev data]" tones for development and tests. Unset: on outside production; never on in production. */
  MUSIC_DEV_PROVIDER: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? undefined : v === 'true' || v === '1')),
});

const resolved = schema.transform((c) => ({
  ...c,
  REQUIRE_VERIFICATION: c.REQUIRE_VERIFICATION ?? c.APP_ENV === 'production',
  SPAM_CHECKS: c.SPAM_CHECKS ?? c.APP_ENV !== 'test',
  JOB_WORKER: c.JOB_WORKER ?? c.APP_ENV !== 'test',
  MEDIA_MODERATION_PROVIDER: c.MEDIA_MODERATION_PROVIDER ?? (c.APP_ENV === 'production' ? ('none' as const) : ('dev' as const)),
  MUSIC_DEV_PROVIDER: c.APP_ENV !== 'production' && (c.MUSIC_DEV_PROVIDER ?? true),
}));

export type Config = z.infer<typeof resolved>;

/**
 * Values are trimmed, and an empty one counts as unset: a field left blank in a hosting dashboard (or
 * `KEY=` in .env) falls back to its default, and a key pasted with a stray space or newline still works.
 */
function withoutBlanks(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    const t = v?.trim();
    if (t) out[k] = t;
  }
  return out;
}

/** The settings as given, with defaults, before the checks that stop the server from starting (the launch check reads these). */
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = resolved.safeParse(withoutBlanks(env));
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${msg}`);
  }
  return parsed.data;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cfg = readConfig(env);
  if (cfg.PAYMENTS_PROVIDER === 'stripe' && (!cfg.STRIPE_SECRET_KEY || !cfg.STRIPE_WEBHOOK_SECRET || !cfg.STRIPE_PUBLISHABLE_KEY))
    throw new Error('PAYMENTS_PROVIDER=stripe needs STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and STRIPE_PUBLISHABLE_KEY.');
  if (!!cfg.PAYSTACK_SECRET_KEY !== !!cfg.PAYSTACK_PUBLIC_KEY) throw new Error('Paystack needs both PAYSTACK_SECRET_KEY and PAYSTACK_PUBLIC_KEY.');
  if (cfg.SMS_PROVIDER === 'twilio' && (!cfg.TWILIO_ACCOUNT_SID || !cfg.TWILIO_AUTH_TOKEN || !cfg.TWILIO_VERIFY_SERVICE_SID))
    throw new Error('SMS_PROVIDER=twilio needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_VERIFY_SERVICE_SID.');
  if (cfg.MEDIA_MODERATION_PROVIDER === 'rekognition' && (!cfg.REKOGNITION_ACCESS_KEY_ID || !cfg.REKOGNITION_SECRET_ACCESS_KEY))
    throw new Error('MEDIA_MODERATION_PROVIDER=rekognition needs REKOGNITION_ACCESS_KEY_ID and REKOGNITION_SECRET_ACCESS_KEY.');
  if (!!cfg.MUSIC_LICENSED_API_URL !== !!cfg.MUSIC_LICENSED_API_KEY)
    throw new Error('The licensed music catalogue needs both MUSIC_LICENSED_API_URL and MUSIC_LICENSED_API_KEY.');
  if (cfg.EMAIL_TRANSPORT === 'smtp' && !cfg.SMTP_URL) throw new Error('EMAIL_TRANSPORT=smtp needs SMTP_URL.');
  if (cfg.TRANSCRIBE_PROVIDER === 'openai-compatible' && !cfg.TRANSCRIBE_API_URL)
    throw new Error('TRANSCRIBE_PROVIDER=openai-compatible needs TRANSCRIBE_API_URL (and TRANSCRIBE_API_KEY for a hosted service).');
  if (!!cfg.VAPID_PUBLIC_KEY !== !!cfg.VAPID_PRIVATE_KEY) throw new Error('Browser push needs both VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY, or neither.');
  if (cfg.APP_ENV === 'production') {
    if (cfg.PAYMENTS_PROVIDER === 'dev') throw new Error('The development payment provider moves no money. Set PAYMENTS_PROVIDER for production.');
    if (Buffer.from(cfg.MFA_ENCRYPTION_KEY, 'base64').length !== 32) throw new Error('Set MFA_ENCRYPTION_KEY (32 bytes, base64) for production.');
    if (!cfg.COOKIE_SECURE) throw new Error('COOKIE_SECURE must be true in production.');
    // Verification, password reset and security emails must reach people.
    if (cfg.EMAIL_TRANSPORT !== 'smtp')
      throw new Error('Emails are only logged with EMAIL_TRANSPORT=log. Set EMAIL_TRANSPORT=smtp and SMTP_URL for production.');
    if (cfg.TICKET_TOKEN_SECRET.length < 32) throw new Error('Set TICKET_TOKEN_SECRET (at least 32 characters) for production: it signs event tickets.');
    if (/yapilapi\.local/.test(cfg.EMAIL_FROM))
      throw new Error('Set EMAIL_FROM for production to a sender on your verified email domain, e.g. "YAPILAPI <hello@yourdomain.com>".');
    if (cfg.LIVE_HOOK_SECRET === DEV_LIVE_HOOK_SECRET || cfg.LIVE_HOOK_SECRET.length < 32)
      throw new Error('Set LIVE_HOOK_SECRET (at least 32 random characters) for production: it signs Mini App tokens and authorizes the live server.');
    if (
      cfg.STORAGE_DRIVER === 's3' &&
      (!cfg.S3_ACCESS_KEY_ID || cfg.S3_ACCESS_KEY_ID === 'dev' || !cfg.S3_SECRET_ACCESS_KEY || cfg.S3_SECRET_ACCESS_KEY === 'dev')
    )
      throw new Error('STORAGE_DRIVER=s3 needs S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY from your storage provider (and S3_ENDPOINT and S3_BUCKET).');
    if (cfg.VAPID_PUBLIC_KEY && /yapilapi\.local/.test(cfg.VAPID_SUBJECT))
      throw new Error('Set VAPID_SUBJECT for production to a contact push services can reach, e.g. mailto:support@yourdomain.com.');
  }
  return cfg;
}
