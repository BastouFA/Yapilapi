import { createHmac, randomBytes } from 'node:crypto';
import { safeEqual } from './tokens.js';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str: string): Buffer {
  const clean = str.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const generateTotpSecret = (): string => base32Encode(randomBytes(20));

/** RFC 6238 TOTP (HMAC-SHA1, 30s step, 6 digits) compatible with common authenticator apps. */
export function totpAt(secretB32: string, timeMs: number, digits = 6, stepSeconds = 30): string {
  const counter = Math.floor(timeMs / 1000 / stepSeconds);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', base32Decode(secretB32)).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code =
    ((hmac[offset]! & 0x7f) << 24) |
    (hmac[offset + 1]! << 16) |
    (hmac[offset + 2]! << 8) |
    hmac[offset + 3]!;
  return String(code % 10 ** digits).padStart(digits, '0');
}

/** Accepts codes within ±`window` steps. Returns the matched step counter (for replay prevention) or null. */
export function verifyTotp(
  secretB32: string,
  code: string,
  opts: { now?: number; window?: number } = {},
): number | null {
  const now = opts.now ?? Date.now();
  const window = opts.window ?? 1;
  if (!/^\d{6}$/.test(code)) return null;
  for (let w = -window; w <= window; w++) {
    const t = now + w * 30_000;
    if (safeEqual(totpAt(secretB32, t), code)) return Math.floor(t / 1000 / 30);
  }
  return null;
}

export const otpauthUri = (secretB32: string, account: string, issuer = 'YAPILAPI'): string =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

/** Human-friendly one-time recovery codes, e.g. `k3f9a-x2m8q`. */
export function generateRecoveryCodes(n = 10): string[] {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: n }, () => {
    const pick = () => Array.from(randomBytes(5), (b) => alphabet[b % alphabet.length]).join('');
    return `${pick()}-${pick()}`;
  });
}
