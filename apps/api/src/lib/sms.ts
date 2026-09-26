import { randomInt, timingSafeEqual } from 'node:crypto';

/** How a code check went. `expired` covers codes that timed out or were never sent to this number. */
export type CodeCheck = 'approved' | 'invalid' | 'expired';

export class SmsError extends Error {
  constructor(
    public kind: 'invalid_number' | 'rate_limited' | 'unavailable',
    message: string,
  ) {
    super(message);
  }
}

/**
 * Sends and checks phone verification codes. The provider owns the code: the
 * API never stores it, only who asked and how many guesses were made.
 */
export interface SmsProvider {
  readonly name: 'dev' | 'twilio';
  sendCode(phoneE164: string): Promise<void>;
  checkCode(phoneE164: string, code: string): Promise<CodeCheck>;
}

export const CODE_TTL_MS = 10 * 60_000;

export interface DevSms {
  to: string;
  code: string;
  body: string;
  at: string;
}

/**
 * Development and tests: writes the code to the log and keeps the last 50
 * messages in memory (tests and the dev-only outbox route read them).
 */
export function devSmsProvider(log?: (msg: string) => void): SmsProvider & { outbox: DevSms[] } {
  const outbox: DevSms[] = [];
  const codes = new Map<string, { code: string; expiresAt: number }>();
  return {
    name: 'dev',
    outbox,
    async sendCode(to) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      codes.set(to, { code, expiresAt: Date.now() + CODE_TTL_MS });
      const body = `Your YAPILAPI code is ${code}. It expires in 10 minutes. Don't share it with anyone.`;
      outbox.push({ to, code, body, at: new Date().toISOString() });
      if (outbox.length > 50) outbox.shift();
      log?.(`sms (dev provider) to ${to}: ${body}`);
    },
    async checkCode(to, code) {
      const entry = codes.get(to);
      if (!entry || entry.expiresAt < Date.now()) return 'expired';
      const a = Buffer.from(entry.code);
      const b = Buffer.from(code);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return 'invalid';
      codes.delete(to);
      return 'approved';
    },
  };
}

export interface TwilioOptions {
  accountSid: string;
  authToken: string;
  serviceSid: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  baseUrl?: string;
}

/**
 * Twilio Verify (https://www.twilio.com/docs/verify/api). Twilio generates,
 * sends and checks the code; we call its REST API with the account's
 * credentials over HTTP basic auth.
 */
export function twilioSmsProvider(opts: TwilioOptions): SmsProvider {
  const f = opts.fetch ?? fetch;
  const base = `${opts.baseUrl ?? 'https://verify.twilio.com'}/v2/Services/${encodeURIComponent(opts.serviceSid)}`;
  const auth = `Basic ${Buffer.from(`${opts.accountSid}:${opts.authToken}`).toString('base64')}`;

  async function call(path: string, form: Record<string, string>): Promise<{ status: number; json: Record<string, any> }> {
    let res: Response;
    try {
      res = await f(`${base}${path}`, {
        method: 'POST',
        headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new SmsError('unavailable', "We couldn't reach the text message service. Try again in a minute.");
    }
    const text = await res.text();
    let json: Record<string, any> = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      /* non-JSON error page */
    }
    return { status: res.status, json };
  }

  return {
    name: 'twilio',
    async sendCode(to) {
      const { status, json } = await call('/Verifications', { To: to, Channel: 'sms' });
      if (status >= 200 && status < 300) return;
      // 60200: invalid parameter (the number); 60203/60212/429: too many attempts.
      if (status === 429 || json.code === 60203 || json.code === 60212)
        throw new SmsError('rate_limited', 'Too many codes were sent to this number. Wait a while and try again.');
      if (status === 400 && (json.code === 60200 || json.code === 21211 || json.code === 60205))
        throw new SmsError('invalid_number', "That number can't receive text messages. Check it and try again.");
      throw new SmsError('unavailable', "We couldn't send a code right now. Try again in a minute.");
    },
    async checkCode(to, code) {
      const { status, json } = await call('/VerificationCheck', { To: to, Code: code });
      // Twilio answers 404 once a verification has expired, been approved or was never started.
      if (status === 404) return 'expired';
      if (status === 429 || json.code === 60202) return 'expired';
      if (status < 200 || status >= 300) throw new SmsError('unavailable', "We couldn't check the code right now. Try again in a minute.");
      if (json.status === 'approved' || json.valid === true) return 'approved';
      if (json.status === 'canceled' || json.status === 'expired' || json.status === 'max_attempts_reached') return 'expired';
      return 'invalid';
    },
  };
}

/**
 * E.164: a plus sign, a country code and up to 15 digits in all. Spaces, dots,
 * dashes and brackets people type are removed; a leading 00 becomes +.
 * Returns null when the result can't be a phone number.
 */
export function normalizePhone(input: string): string | null {
  let s = input.trim().replace(/[\s.\-()/]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (!/^\+[1-9]\d{7,14}$/.test(s)) return null;
  return s;
}
