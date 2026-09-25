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
  UPLOAD_DIR: z.string().default('./uploads'),
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
    if (!cfg.COOKIE_SECURE) throw new Error('COOKIE_SECURE must be true in production.');
  }
  return cfg;
}
