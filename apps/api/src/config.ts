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
  PAYMENTS_PROVIDER: z.enum(['dev']).default('dev'),
  PAYMENTS_WEBHOOK_SECRET: z.string().default('dev-webhook-secret-change-me'),
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
  RATE_LIMIT_MAX: z.coerce.number().default(300),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${msg}`);
  }
  const cfg = parsed.data;
  if (cfg.APP_ENV === 'production') {
    if (cfg.PAYMENTS_WEBHOOK_SECRET.startsWith('dev-')) throw new Error('Set PAYMENTS_WEBHOOK_SECRET for production.');
    if (Buffer.from(cfg.MFA_ENCRYPTION_KEY, 'base64').length !== 32) throw new Error('Set MFA_ENCRYPTION_KEY (32 bytes, base64) for production.');
    if (!cfg.COOKIE_SECURE) throw new Error('COOKIE_SECURE must be true in production.');
  }
  return cfg;
}
