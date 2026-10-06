/**
 * Launch check: which outside services are set up, and whether each one answers.
 *
 *   pnpm --filter @yapilapi/api launch:check                  every service, with a live check where a key is set
 *   pnpm --filter @yapilapi/api launch:check --offline        settings only, nothing is contacted
 *   pnpm --filter @yapilapi/api launch:check --send-email you@example.com   also sends one test email
 *
 * On Render, open the yapilapi-api service's Shell tab and run: cd /app/apps/api && node --import tsx scripts/launch-check.ts
 *
 * It reads the same settings as the server (the .env file and the environment). Secrets are never
 * printed. Live checks are read-only and cheap: the AI check asks for a one-word reply, the payment
 * checks read the account balance, and nothing is created anywhere.
 */
import Anthropic from '@anthropic-ai/sdk';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { Redis } from 'ioredis';
import { createTransport } from 'nodemailer';
import pg from 'pg';
import { loadConfig, readConfig, type Config } from '../src/config.ts';
import { jamendoProvider } from '../src/lib/music/jamendo.ts';

type Status = 'ready' | 'not set' | 'problem' | 'dev only';
interface Row {
  area: string;
  status: Status;
  note: string;
}

const args = process.argv.slice(2);
const offline = args.includes('--offline');
const sendTo = (() => {
  const i = args.indexOf('--send-email');
  return i >= 0 ? args[i + 1] : undefined;
})();

const rows: Row[] = [];
const add = (area: string, status: Status, note: string) => rows.push({ area, status, note });

/** A live check with a time limit; its error message is reported, never the secret. */
async function live(fn: () => Promise<string>): Promise<{ ok: boolean; note: string }> {
  if (offline) return { ok: true, note: 'set (not contacted: --offline)' };
  try {
    const note = await Promise.race([fn(), new Promise<never>((_, no) => setTimeout(() => no(new Error('no answer within 15 seconds')), 15_000))]);
    return { ok: true, note };
  } catch (e) {
    return { ok: false, note: (e as Error).message.slice(0, 160) };
  }
}

/** live or test, from a Stripe or Paystack key's prefix (sk_live_…, pk_test_…). */
function keyMode(key: string, prefix = 'sk_'): 'live' | 'test' | 'unknown' {
  if (key.startsWith(`${prefix}live_`) || (prefix === 'sk_' && key.startsWith('rk_live_'))) return 'live';
  if (key.startsWith(`${prefix}test_`) || (prefix === 'sk_' && key.startsWith('rk_test_'))) return 'test';
  return 'unknown';
}

async function bearerGet(url: string, key: string): Promise<Response> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${key}` } });
  if (res.status === 401) throw new Error('the key was refused (401)');
  if (!res.ok) throw new Error(`answered ${res.status}`);
  return res;
}

async function main() {
  let cfg: Config;
  try {
    cfg = readConfig();
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  const prod = cfg.APP_ENV === 'production';
  try {
    loadConfig();
    add('Startup checks', 'ready', `the server would start (APP_ENV=${cfg.APP_ENV})`);
  } catch (e) {
    add('Startup checks', 'problem', (e as Error).message);
  }

  // Database and Redis
  {
    const pool = new pg.Pool({ connectionString: cfg.DATABASE_URL, max: 1 });
    const r = await live(async () => {
      const { rows: m } = await pool.query(`SELECT count(*)::int AS n FROM schema_migrations`).catch(() => ({ rows: [{ n: '?' }] }));
      return `connected, ${m[0]!.n} migrations applied`;
    });
    await pool.end().catch(() => {});
    add('Database', r.ok ? 'ready' : 'problem', r.note);
  }
  if (!cfg.REDIS_URL) add('Redis', prod ? 'problem' : 'dev only', 'REDIS_URL not set: live updates only reach people on the same server');
  else {
    const redis = new Redis(cfg.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, family: 0 });
    const r = await live(async () => {
      await redis.connect();
      return `answered ${await redis.ping()}`;
    });
    redis.disconnect();
    add('Redis', r.ok ? 'ready' : 'problem', r.note);
  }

  // Email
  if (cfg.EMAIL_TRANSPORT !== 'smtp' || !cfg.SMTP_URL)
    add('Email (SMTP)', prod ? 'problem' : 'not set', 'set EMAIL_TRANSPORT=smtp, SMTP_URL and EMAIL_FROM (docs/operations/launch-setup.md, section 1)');
  else {
    const transport = createTransport(cfg.SMTP_URL);
    const r = await live(async () => {
      await transport.verify();
      if (sendTo) {
        await transport.sendMail({
          from: cfg.EMAIL_FROM,
          to: sendTo,
          subject: 'YAPILAPI test email',
          text: 'This is a test from the YAPILAPI launch check. If you can read it, email is working.',
        });
        return `server accepted the login; test email sent to ${sendTo}`;
      }
      return 'server accepted the login (add --send-email you@example.com to send one)';
    });
    add('Email (SMTP)', r.ok ? 'ready' : 'problem', r.note);
    if (/yapilapi\.local|example\.com/.test(cfg.EMAIL_FROM)) add('Email sender', 'problem', `EMAIL_FROM is still a placeholder address`);
  }

  // AI
  if (cfg.AI_PROVIDER !== 'anthropic' || !cfg.ANTHROPIC_API_KEY)
    add(
      'AI (Anthropic)',
      'not set',
      `AI helpers use the built-in stand-in; set ${cfg.AI_PROVIDER === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'AI_PROVIDER=anthropic and ANTHROPIC_API_KEY'} (section 2)`,
    );
  else {
    const client = new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY, timeout: 15_000, maxRetries: 0 });
    const r = await live(async () => {
      const res = await client.messages.create({ model: cfg.AI_MODEL, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with the word ready.' }] });
      return `${res.model} answered (${res.usage.input_tokens + res.usage.output_tokens} tokens used)`;
    });
    add('AI (Anthropic)', r.ok ? 'ready' : 'problem', r.note);
  }

  // Music
  if (!cfg.JAMENDO_CLIENT_ID) add('Music (Jamendo)', 'not set', 'only the in-app sounds are offered; set JAMENDO_CLIENT_ID (section 3)');
  else {
    const r = await live(async () => {
      const found = await jamendoProvider({ clientId: cfg.JAMENDO_CLIENT_ID, baseUrl: cfg.JAMENDO_API_URL }).search('lagos', {
        limit: 3,
        commercialOnly: false,
        country: null,
      });
      return `search works (${found.length} songs for "lagos")`;
    });
    add('Music (Jamendo)', r.ok ? 'ready' : 'problem', r.note);
  }
  if (cfg.MUSIC_LICENSED_API_URL) add('Music (licensed catalogue)', 'ready', `${cfg.MUSIC_LICENSED_NAME} is configured (not contacted)`);

  // Payments
  if (cfg.PAYMENTS_PROVIDER !== 'stripe') add('Payments (Stripe)', prod ? 'problem' : 'dev only', 'the development provider moves no money');
  else {
    const mode = keyMode(cfg.STRIPE_SECRET_KEY);
    const r = await live(async () => {
      await bearerGet('https://api.stripe.com/v1/balance', cfg.STRIPE_SECRET_KEY);
      return `the key works (${mode} mode)`;
    });
    add(
      'Payments (Stripe)',
      r.ok ? (prod && mode !== 'live' ? 'problem' : 'ready') : 'problem',
      prod && mode !== 'live' && r.ok ? 'production is using a test key (fine for a trial run, not for real money)' : r.note,
    );
    const pk = keyMode(cfg.STRIPE_PUBLISHABLE_KEY, 'pk_');
    if (pk !== mode) add('Stripe keys', 'problem', `the secret key is ${mode} mode but the publishable key is ${pk}: copy both from the same mode`);
    if (!cfg.STRIPE_WEBHOOK_SECRET.startsWith('whsec_'))
      add(
        'Stripe webhook',
        process.env.RENDER_EXTERNAL_URL || process.env.STRIPE_WEBHOOK_URL ? 'ready' : 'problem',
        process.env.RENDER_EXTERNAL_URL || process.env.STRIPE_WEBHOOK_URL
          ? 'set up automatically by the API (no secret pasted); its log says "Stripe webhook ready"'
          : 'no signing secret pasted and no address to set one up: set STRIPE_WEBHOOK_URL, or paste the whsec_… secret',
      );
    else add('Stripe webhook', 'ready', 'signing secret set (payments are confirmed when Stripe calls /v1/payments/webhook/stripe)');
  }
  if (cfg.PAYSTACK_SECRET_KEY) {
    const mode = keyMode(cfg.PAYSTACK_SECRET_KEY);
    const r = await live(async () => {
      await bearerGet('https://api.paystack.co/balance', cfg.PAYSTACK_SECRET_KEY);
      return `the key works (${mode} mode)`;
    });
    add('Payments (Paystack)', r.ok ? 'ready' : 'problem', r.note);
    const pk = keyMode(cfg.PAYSTACK_PUBLIC_KEY, 'pk_');
    if (pk !== mode) add('Paystack keys', 'problem', `the secret key is ${mode} mode but the public key is ${pk}: copy both from the same mode`);
  } else add('Payments (Paystack)', 'not set', 'optional: for NGN, GHS, KES and ZAR');

  // Storage
  if (cfg.STORAGE_DRIVER !== 's3') add('Media storage', prod ? 'problem' : 'dev only', `files are kept on this machine's disk (${cfg.UPLOAD_DIR})`);
  else {
    const s3 = new S3Client({
      region: cfg.S3_REGION,
      endpoint: cfg.S3_ENDPOINT || undefined,
      forcePathStyle: cfg.S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: cfg.S3_ACCESS_KEY_ID, secretAccessKey: cfg.S3_SECRET_ACCESS_KEY },
    });
    const r = await live(async () => {
      await s3.send(new HeadBucketCommand({ Bucket: cfg.S3_BUCKET }));
      return `bucket ${cfg.S3_BUCKET} is reachable`;
    });
    add('Media storage (S3)', r.ok ? 'ready' : 'problem', r.note);
  }

  // Automatic captions
  if (cfg.TRANSCRIBE_PROVIDER === 'none')
    add('Captions (speech-to-text)', 'not set', 'optional: people can still write captions; set TRANSCRIBE_PROVIDER=openai-compatible and TRANSCRIBE_API_KEY');
  else {
    const base = cfg.TRANSCRIBE_API_URL.replace(/\/+$/, '');
    const r = await live(async () => {
      // OpenAI-compatible services list their models here; a self-hosted server may not, which is fine.
      const res = await fetch(`${base}/models`, { headers: cfg.TRANSCRIBE_API_KEY ? { authorization: `Bearer ${cfg.TRANSCRIBE_API_KEY}` } : {} });
      if (res.status === 401 || res.status === 403) throw new Error(`the key was refused (${res.status})`);
      return `${new URL(base).host} answers (model ${cfg.TRANSCRIBE_MODEL})`;
    });
    add('Captions (speech-to-text)', r.ok ? 'ready' : 'problem', r.note);
  }

  // Phone numbers, moderation, calls, live, web push
  if (cfg.SMS_PROVIDER !== 'twilio') add('Text messages (Twilio)', 'dev only', 'phone codes are only logged; optional for launch');
  else {
    const r = await live(async () => {
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.TWILIO_ACCOUNT_SID}.json`, {
        headers: { authorization: `Basic ${Buffer.from(`${cfg.TWILIO_ACCOUNT_SID}:${cfg.TWILIO_AUTH_TOKEN}`).toString('base64')}` },
      });
      if (!res.ok) throw new Error(`answered ${res.status}`);
      return 'the account answers';
    });
    add('Text messages (Twilio)', r.ok ? 'ready' : 'problem', r.note);
  }
  const mod = cfg.MEDIA_MODERATION_PROVIDER;
  add(
    'Photo and video checks',
    mod === 'rekognition' ? 'ready' : prod ? 'problem' : 'dev only',
    mod === 'rekognition' ? 'Amazon Rekognition is configured (not contacted)' : `MEDIA_MODERATION_PROVIDER=${mod}: uploads aren't checked automatically`,
  );
  // Optional at launch: both need a server of their own (docs/operations/deploy-render.md, "Live video and the calls relay").
  add(
    'Calls relay (TURN)',
    cfg.TURN_URLS && cfg.TURN_SECRET ? 'ready' : prod ? 'not set' : 'dev only',
    cfg.TURN_URLS && cfg.TURN_SECRET ? 'configured' : 'optional: without it, calls may fail between some strict networks',
  );
  const liveLocal = /localhost|127\.0\.0\.1/.test(cfg.LIVE_HLS_BASE);
  add(
    'Live video',
    liveLocal ? (prod ? 'not set' : 'dev only') : cfg.LIVE_HLS_BASE.startsWith('https://') || !prod ? 'ready' : 'problem',
    liveLocal
      ? prod
        ? 'optional: keep the LIVE feature flag off until a live server runs'
        : 'the live server is this machine'
      : cfg.LIVE_HLS_BASE.startsWith('https://') || !prod
        ? cfg.LIVE_HLS_BASE
        : `${cfg.LIVE_HLS_BASE}: browsers only play live video from an https address`,
  );
  add(
    'Web notifications',
    cfg.VAPID_PUBLIC_KEY && cfg.VAPID_PRIVATE_KEY ? 'ready' : 'not set',
    cfg.VAPID_PUBLIC_KEY ? 'VAPID keys set' : 'run: npx web-push generate-vapid-keys',
  );

  // Buying digital goods (Plus, tips, boosts) in the phone apps: docs/operations/in-app-purchases.md
  const ios = cfg.IOS_DIGITAL_PURCHASES === 'external_link' ? `web link in ${cfg.IOS_EXTERNAL_LINK_COUNTRIES.join(', ')}` : cfg.IOS_DIGITAL_PURCHASES;
  const android =
    cfg.ANDROID_DIGITAL_PURCHASES === 'user_choice' ? `web link in ${cfg.ANDROID_USER_CHOICE_COUNTRIES.join(', ')}` : cfg.ANDROID_DIGITAL_PURCHASES;
  add('Phone app purchases', 'ready', `iPhone: ${ios}; Android: ${android} (section 6)`);

  // Addresses the world sees
  const local = (u: string) => /localhost|127\.0\.0\.1|\.local\b/.test(u);
  const web = cfg.WEB_ORIGIN.split(',')[0]!.trim().replace(/\/+$/, '');
  const insecure = prod && !web.startsWith('https://');
  add(
    'Public addresses',
    local(cfg.WEB_ORIGIN) || local(cfg.PUBLIC_API_URL) || insecure ? (prod ? 'problem' : 'dev only') : 'ready',
    insecure ? `WEB_ORIGIN must be an https address (${web})` : `web ${cfg.WEB_ORIGIN}, media ${cfg.PUBLIC_API_URL}`,
  );
  const passkeyOrigin = cfg.WEBAUTHN_ORIGIN || web;
  const passkeyHost = (() => {
    try {
      return new URL(passkeyOrigin).hostname;
    } catch {
      return '';
    }
  })();
  const rpId = cfg.WEBAUTHN_RP_ID || passkeyHost;
  add(
    'Passkeys',
    passkeyHost === rpId || passkeyHost.endsWith(`.${rpId}`) ? 'ready' : 'problem',
    passkeyHost === rpId || passkeyHost.endsWith(`.${rpId}`)
      ? `signing in with a passkey on ${rpId}`
      : `WEBAUTHN_RP_ID (${rpId}) must be the host of WEBAUTHN_ORIGIN (${passkeyOrigin}) or a domain above it`,
  );
  // The whole path a browser takes: the web app, its /api proxy, the API and the database.
  if (!local(web) || prod) {
    const r = await live(async () => {
      const res = await fetch(`${web}/api/health/ready`, { redirect: 'manual' });
      const body = (await res.json().catch(() => ({}))) as { status?: string };
      if (body.status !== 'ready') throw new Error(`${web}/api/health/ready answered ${res.status}: check API_INTERNAL_URL on the web app`);
      return `${web} reaches the API through /api`;
    });
    add('Web app to API', r.ok ? 'ready' : 'problem', r.note);
  }

  // Print
  const icon: Record<Status, string> = { ready: 'ok  ', 'not set': 'todo', problem: 'FIX ', 'dev only': 'dev ' };
  const width = Math.max(...rows.map((r) => r.area.length));
  console.log(`\nYAPILAPI launch check (${cfg.APP_ENV}${offline ? ', offline' : ''})\n`);
  for (const r of rows) console.log(`  ${icon[r.status]}  ${r.area.padEnd(width)}  ${r.note}`);
  const problems = rows.filter((r) => r.status === 'problem').length;
  const todo = rows.filter((r) => r.status === 'not set').length;
  console.log(`\n${problems} to fix, ${todo} not set up yet. Guide: docs/operations/launch-setup.md\n`);
  process.exit(problems ? 1 : 0);
}

void main();
