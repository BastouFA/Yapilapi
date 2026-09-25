import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  decrypt,
  encrypt,
  hashPassword,
  needsRehash,
  redact,
  signWebhook,
  totpAt,
  verifyPassword,
  verifyTotp,
  verifyWebhookSignature,
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
} from './index.js';

describe('password hashing', () => {
  it('verifies the right password and rejects the wrong one', async () => {
    const h = await hashPassword('correct horse battery staple');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery staple', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
  });
  it('salts every hash', async () => {
    expect(await hashPassword('same-password-1')).not.toBe(await hashPassword('same-password-1'));
  });
  it('rejects malformed hashes and flags weak params for rehash', async () => {
    expect(await verifyPassword('x', 'garbage')).toBe(false);
    const weak = await hashPassword('pw-pw-pw-pw-pw', { N: 1024 });
    expect(needsRehash(weak)).toBe(true);
    expect(needsRehash(await hashPassword('pw-pw-pw-pw-pw'))).toBe(false);
  });
});

describe('AES-256-GCM', () => {
  const key = randomBytes(32);
  it('round-trips and binds AAD', () => {
    const c = encrypt('top secret', key, 'k1', 'user:1');
    expect(decrypt(c, { k1: key }, 'user:1')).toBe('top secret');
    expect(() => decrypt(c, { k1: key }, 'user:2')).toThrow();
  });
  it('detects tampering and wrong keys', () => {
    const c = encrypt('top secret', key);
    const parts = c.split('.');
    parts[4] = Buffer.from('tampered').toString('base64url');
    expect(() => decrypt(parts.join('.'), key)).toThrow();
    expect(() => decrypt(c, randomBytes(32))).toThrow();
  });
});

describe('TOTP (RFC 6238 vectors)', () => {
  // RFC 6238 Appendix B, SHA1, secret "12345678901234567890", 8 digits -> we compare last 6.
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  it('matches the reference vectors', () => {
    expect(totpAt(secret, 59_000, 8)).toBe('94287082');
    expect(totpAt(secret, 1111111109_000, 8)).toBe('07081804');
    expect(totpAt(secret, 2000000000_000, 8)).toBe('69279037');
  });
  it('verifies within the window only', () => {
    const now = 1_700_000_000_000;
    const code = totpAt(secret, now);
    expect(verifyTotp(secret, code, { now })).not.toBeNull();
    expect(verifyTotp(secret, code, { now: now + 30_000 })).not.toBeNull();
    expect(verifyTotp(secret, code, { now: now + 120_000 })).toBeNull();
    expect(verifyTotp(secret, '12345', { now })).toBeNull();
  });
  it('base32 round-trips', () => {
    const b = randomBytes(20);
    expect(base32Decode(base32Encode(b)).equals(b)).toBe(true);
  });
  it('generates unique recovery codes', () => {
    const codes = generateRecoveryCodes(10);
    expect(new Set(codes).size).toBe(10);
  });
});

describe('webhook signatures', () => {
  const body = '{"id":"evt_1"}';
  it('accepts a fresh valid signature', () => {
    const h = signWebhook('s3cret', body, 1000);
    expect(verifyWebhookSignature({ secret: 's3cret', header: h, rawBody: body, now: 1100 })).toBe(
      true,
    );
  });
  it('rejects wrong secret, tampered body, stale timestamps, and missing headers', () => {
    const h = signWebhook('s3cret', body, 1000);
    expect(verifyWebhookSignature({ secret: 'nope', header: h, rawBody: body, now: 1000 })).toBe(
      false,
    );
    expect(
      verifyWebhookSignature({ secret: 's3cret', header: h, rawBody: body + ' ', now: 1000 }),
    ).toBe(false);
    expect(verifyWebhookSignature({ secret: 's3cret', header: h, rawBody: body, now: 5000 })).toBe(
      false,
    );
    expect(verifyWebhookSignature({ secret: 's3cret', header: undefined, rawBody: body })).toBe(
      false,
    );
  });
});

describe('log redaction', () => {
  it('redacts sensitive keys deeply', () => {
    const out = redact({
      user: 'a',
      password: 'x',
      nested: { authorization: 'Bearer y', cardNumber: '4242', ok: 1 },
    });
    expect(out).toEqual({
      user: 'a',
      password: '[REDACTED]',
      nested: { authorization: '[REDACTED]', cardNumber: '[REDACTED]', ok: 1 },
    });
  });
});
