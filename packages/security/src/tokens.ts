import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** URL-safe random token with `bytes` of entropy (default 32 = 256 bits). */
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

/** Tokens are only ever stored hashed; a DB leak must not yield usable sessions. */
export const sha256Hex = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export const hmacSha256Hex = (secret: string, payload: string): string =>
  createHmac('sha256', secret).update(payload).digest('hex');

/**
 * Verify a webhook signature of the form `t=<unix>,v1=<hex>` over `${t}.${rawBody}`.
 * Rejects stale timestamps to prevent replay.
 */
export function verifyWebhookSignature(opts: {
  secret: string;
  header: string | undefined;
  rawBody: string;
  toleranceSeconds?: number;
  now?: number;
}): boolean {
  if (!opts.header) return false;
  const fields = Object.fromEntries(
    opts.header.split(',').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  );
  const t = Number(fields.t);
  const v1 = fields.v1;
  if (!Number.isFinite(t) || !v1) return false;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (opts.toleranceSeconds ?? 300)) return false;
  return safeEqual(hmacSha256Hex(opts.secret, `${t}.${opts.rawBody}`), v1);
}

export function signWebhook(
  secret: string,
  rawBody: string,
  now = Math.floor(Date.now() / 1000),
): string {
  return `t=${now},v1=${hmacSha256Hex(secret, `${now}.${rawBody}`)}`;
}
