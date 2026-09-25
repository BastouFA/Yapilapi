import { createHash, createHmac } from 'node:crypto';
import { safeEqual } from '@yapilapi/security';

/**
 * Capture tokens: short-lived, HMAC-signed, bound to one user AND one device, single-use (the session row is consumed on upload).
 *
 * Format: `v1.<base64url(JSON payload)>.<base64url(HMAC-SHA256)>`. The payload is `{ sid, uid, dev, iat, exp, skew }` with times in epoch ms.
 * This is a best-effort in-app integrity signal (the server saw the client ask to capture, and the upload followed within minutes).
 * It is NOT hardware attestation: a modified client can still obtain a token. See AttestationVerifier in authenticity.ts.
 */
export const CAPTURE_TOKEN_TTL_MS = 10 * 60_000;

export interface CaptureTokenPayload {
  /** Capture-session row id (the single-use handle). */
  sid: string;
  uid: string;
  /** sha256(userId + ':' + deviceId), hex. */
  dev: string;
  iat: number;
  exp: number;
  /** Server clock minus client clock in ms at issue time, or null when the client reported no time. */
  skew: number | null;
}

export type TokenFailure =
  'malformed' | 'bad_signature' | 'expired' | 'wrong_user' | 'wrong_device';
export type TokenVerdict =
  { ok: true; payload: CaptureTokenPayload } | { ok: false; reason: TokenFailure };

/** Derive the signing key from the deployment's data-encryption key so tokens survive restarts without a new secret to manage. */
export const captureSigningKey = (dataEncryptionKey: Buffer): Buffer =>
  createHmac('sha256', dataEncryptionKey).update('yapilapi:real:capture-token:v1').digest();

export const hashDeviceId = (userId: string, deviceId: string): string =>
  createHash('sha256').update(`${userId}:${deviceId}`).digest('hex');

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function signCaptureToken(key: Buffer, payload: CaptureTokenPayload): string {
  const body = b64(JSON.stringify(payload));
  const sig = createHmac('sha256', key).update(`v1.${body}`).digest('base64url');
  return `v1.${body}.${sig}`;
}

const isPayload = (p: unknown): p is CaptureTokenPayload => {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  return (
    typeof o.sid === 'string' &&
    typeof o.uid === 'string' &&
    typeof o.dev === 'string' &&
    typeof o.iat === 'number' &&
    typeof o.exp === 'number' &&
    (o.skew === null || typeof o.skew === 'number')
  );
};

/** Pure verification: signature (constant time), expiry, then the binding to the presenting user and device. */
export function verifyCaptureToken(
  key: Buffer,
  token: string,
  expect: { userId: string; deviceHash: string },
  now: number,
): TokenVerdict {
  if (typeof token !== 'string' || token.length > 1024) return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return { ok: false, reason: 'malformed' };
  const [, body, sig] = parts as [string, string, string];
  const good = createHmac('sha256', key).update(`v1.${body}`).digest('base64url');
  if (!safeEqual(sig, good)) return { ok: false, reason: 'bad_signature' };
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!isPayload(payload)) return { ok: false, reason: 'malformed' };
  if (payload.exp <= now) return { ok: false, reason: 'expired' };
  if (payload.uid !== expect.userId) return { ok: false, reason: 'wrong_user' };
  if (!safeEqual(payload.dev, expect.deviceHash)) return { ok: false, reason: 'wrong_device' };
  return { ok: true, payload };
}
