import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';

/** Treat empty strings (as found in .env.example) as "unset". */
const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const str = () => z.preprocess(blank, z.string().optional());
const bool = (def: boolean) =>
  z.preprocess(
    blank,
    z
      .enum(['true', 'false'])
      .default(def ? 'true' : 'false')
      .transform((v) => v === 'true'),
  );
const int = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.preprocess(blank, z.coerce.number().int().min(min).max(max).default(def));

const schema = z.object({
  NODE_ENV: z.preprocess(
    blank,
    z.enum(['development', 'test', 'production']).default('development'),
  ),
  APP_ENV: z.preprocess(
    blank,
    z.enum(['development', 'test', 'staging', 'production']).default('development'),
  ),
  APP_NAME: z.preprocess(blank, z.string().default('YAPILAPI')),
  API_HOST: z.preprocess(blank, z.string().default('0.0.0.0')),
  API_PORT: int(4000, 0, 65535),
  API_PUBLIC_URL: z.preprocess(blank, z.string().url().default('http://localhost:4000')),
  WEB_PUBLIC_URL: z.preprocess(blank, z.string().url().default('http://localhost:3000')),
  ADMIN_PUBLIC_URL: z.preprocess(blank, z.string().url().default('http://localhost:3100')),
  CORS_ALLOWED_ORIGINS: z.preprocess(
    blank,
    z.string().default('http://localhost:3000,http://localhost:3100'),
  ),
  TRUST_PROXY: bool(false),
  LOG_LEVEL: z.preprocess(
    blank,
    z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  ),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_POOL_MAX: int(10, 1, 200),
  REDIS_URL: str(),
  SESSION_COOKIE_NAME: z.preprocess(blank, z.string().default('yl_session')),
  SESSION_TTL_DAYS: int(30, 1, 365),
  COOKIE_SECURE: bool(false),
  DATA_ENCRYPTION_KEY: str(),
  DATA_ENCRYPTION_KEY_ID: z.preprocess(blank, z.string().default('k1')),
  WEBHOOK_SIGNING_SECRET: str(),
  EMAIL_ADAPTER: z.preprocess(blank, z.enum(['console', 'smtp']).default('console')),
  SMTP_URL: str(),
  EMAIL_FROM: z.preprocess(blank, z.string().default('YAPILAPI <no-reply@example.invalid>')),
  MEDIA_ADAPTER: z.preprocess(blank, z.enum(['local', 's3']).default('local')),
  MEDIA_LOCAL_DIR: z.preprocess(blank, z.string().default('./storage/media')),
  MEDIA_PUBLIC_BASE_URL: z.preprocess(blank, z.string().default('http://localhost:4000/media')),
  S3_ENDPOINT: str(),
  S3_REGION: str(),
  S3_BUCKET: str(),
  S3_ACCESS_KEY_ID: str(),
  S3_SECRET_ACCESS_KEY: str(),
  S3_FORCE_PATH_STYLE: bool(true),
  MEDIA_FFMPEG_PATH: z.preprocess(blank, z.string().default('ffmpeg')),
  MEDIA_FFPROBE_PATH: z.preprocess(blank, z.string().default('ffprobe')),
  CDN_BASE_URL: str(),
  PAYMENT_PROVIDER: z.preprocess(blank, z.enum(['dev', 'stripe']).default('dev')),
  STRIPE_SECRET_KEY: str(),
  STRIPE_WEBHOOK_SECRET: str(),
  PLATFORM_FEE_BPS: int(500, 0, 5000),
  STRIPE_API_BASE_URL: str(),
  /** Days a captured payment stays "pending" before its net amount counts as available for payout. */
  PAYOUT_HOLD_DAYS: int(7, 0, 90),
  /** How long stock is reserved for an unpaid order. */
  ORDER_RESERVATION_MINUTES: int(30, 1, 1440),
  /** How long stock stays reserved for orders held for fraud review. */
  ORDER_REVIEW_HOLD_HOURS: int(48, 1, 720),
  PAYMENT_WEBHOOK_TOLERANCE_SEC: int(300, 30, 3600),
  DOWNLOAD_URL_TTL_SEC: int(300, 30, 3600),
  /** Fulfilled orders complete automatically after this many days without a dispute. */
  ORDER_AUTO_COMPLETE_DAYS: int(14, 1, 90),
  AI_DEFAULT_PROVIDER: z.preprocess(blank, z.enum(['dev', 'anthropic', 'openai']).default('dev')),
  ANTHROPIC_API_KEY: str(),
  ANTHROPIC_MODEL: str(),
  OPENAI_API_KEY: str(),
  OPENAI_MODEL: str(),
  /** Optional base URL overrides (OpenAI/Anthropic-compatible gateways, test doubles). */
  ANTHROPIC_BASE_URL: str(),
  OPENAI_BASE_URL: str(),
  /** Master switch for the AI platform (on by default: the offline dev provider always works). */
  AI_ENABLED: bool(true),
  AI_REQUEST_TIMEOUT_MS: int(20_000, 500, 120_000),
  /** Per-user and global daily token budgets (input + output, all tasks), persisted in ai_usage. */
  AI_USER_DAILY_TOKENS: int(60_000, 1, 100_000_000),
  AI_GLOBAL_DAILY_TOKENS: int(20_000_000, 1, 10_000_000_000),
  /** Translations one user may request per day (cache hits are free). */
  AI_TRANSLATIONS_PER_DAY: int(100, 1, 100_000),
  SEARCH_BACKEND: z.preprocess(blank, z.enum(['postgres', 'opensearch']).default('postgres')),
  OPENSEARCH_URL: str(),
  PUSH_ADAPTER: z.preprocess(blank, z.enum(['log', 'expo']).default('log')),
  EXPO_ACCESS_TOKEN: str(),
  ANALYTICS_RETENTION_DAYS: int(90, 1, 3650),
  METRICS_ENABLED: bool(true),
  METRICS_TOKEN: str(),
  RATE_LIMIT_ENABLED: bool(true),
  IP_HASH_SALT: str(),
});

type Parsed = z.infer<typeof schema>;

export interface AppConfig extends Omit<Parsed, 'CORS_ALLOWED_ORIGINS' | 'DATA_ENCRYPTION_KEY'> {
  corsAllowedOrigins: string[];
  /** 32-byte AES key. In development an ephemeral key is generated if none is configured. */
  dataEncryptionKey: Buffer;
  dataEncryptionKeyEphemeral: boolean;
  webhookSigningSecret: string;
  isProduction: boolean;
  isTest: boolean;
}

/** Load `.env` from the repo root if present (never overrides already-set variables). */
export function loadDotEnv(cwd: string = process.cwd()): void {
  let dir = cwd;
  for (let i = 0; i < 5; i++) {
    const file = path.join(dir, '.env');
    if (existsSync(file)) {
      process.loadEnvFile(file);
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

/**
 * Parse and validate configuration. Throws a readable error listing every problem.
 * In staging/production, secrets are required and insecure defaults are refused.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  const c = parsed.data;
  const strict = c.APP_ENV === 'staging' || c.APP_ENV === 'production';
  const problems: string[] = [];

  let key: Buffer;
  let ephemeral = false;
  if (c.DATA_ENCRYPTION_KEY) {
    key = Buffer.from(c.DATA_ENCRYPTION_KEY, 'base64');
    if (key.length !== 32) problems.push('DATA_ENCRYPTION_KEY must be base64 for exactly 32 bytes');
  } else {
    if (strict) problems.push('DATA_ENCRYPTION_KEY is required in staging/production');
    key = randomBytes(32);
    ephemeral = true;
  }
  if (strict) {
    if (!c.COOKIE_SECURE) problems.push('COOKIE_SECURE must be true in staging/production');
    if (!c.WEBHOOK_SIGNING_SECRET)
      problems.push('WEBHOOK_SIGNING_SECRET is required in staging/production');
    if (c.PAYMENT_PROVIDER === 'dev')
      problems.push('PAYMENT_PROVIDER=dev is not allowed in staging/production');
    if (c.EMAIL_ADAPTER === 'console')
      problems.push('EMAIL_ADAPTER=console is not allowed in staging/production');
    if (!c.IP_HASH_SALT) problems.push('IP_HASH_SALT is required in staging/production');
    if (!c.REDIS_URL) problems.push('REDIS_URL is required in staging/production');
  }
  if (c.PAYMENT_PROVIDER === 'stripe' && (!c.STRIPE_SECRET_KEY || !c.STRIPE_WEBHOOK_SECRET)) {
    problems.push(
      'STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are required when PAYMENT_PROVIDER=stripe',
    );
  }
  if (problems.length)
    throw new Error(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);

  const { CORS_ALLOWED_ORIGINS, DATA_ENCRYPTION_KEY: _k, ...rest } = c;
  void _k;
  return {
    ...rest,
    corsAllowedOrigins: CORS_ALLOWED_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    dataEncryptionKey: key,
    dataEncryptionKeyEphemeral: ephemeral,
    webhookSigningSecret: c.WEBHOOK_SIGNING_SECRET ?? randomBytes(32).toString('hex'),
    isProduction: c.APP_ENV === 'production',
    isTest: c.NODE_ENV === 'test' || c.APP_ENV === 'test',
  };
}
