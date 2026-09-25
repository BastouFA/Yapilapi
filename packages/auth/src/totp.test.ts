import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, decrypt, encrypt, hashRecoveryCode, newRecoveryCodes, otpauthUri, totp, verifyTotp } from './totp.ts';

// RFC 6238 appendix B, SHA-1 secret "12345678901234567890" (8-digit values; we use the last 6).
const RFC_SECRET = Buffer.from('12345678901234567890');
const VECTORS: [number, string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
];

describe('totp', () => {
  it('matches the RFC 6238 test vectors', () => {
    for (const [t, code] of VECTORS) expect(totp(RFC_SECRET, t * 1000, 8)).toBe(code);
  });

  it('accepts one step of clock drift but not two', () => {
    const now = 1_700_000_000_000;
    expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, now - 30_000), now)).toBe(true);
    expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, now + 30_000), now)).toBe(true);
    expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, now - 90_000), now)).toBe(false);
    expect(verifyTotp(RFC_SECRET, 'abcdef', now)).toBe(false);
  });

  it('round-trips base32 and builds an otpauth URI', () => {
    const b = randomBytes(20);
    expect(base32Decode(base32Encode(b)).equals(b)).toBe(true);
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(otpauthUri(RFC_SECRET, 'ada@example.test')).toContain('secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });
});

describe('encryption and recovery codes', () => {
  it('encrypts with AES-GCM and detects tampering', () => {
    const key = randomBytes(32);
    const blob = encrypt(key, Buffer.from('secret'));
    expect(decrypt(key, blob).toString()).toBe('secret');
    blob[blob.length - 1] ^= 1;
    expect(() => decrypt(key, blob)).toThrow();
  });

  it('makes unique recovery codes and hashes them case-insensitively', () => {
    const { codes, hashes } = newRecoveryCodes();
    expect(new Set(codes).size).toBe(10);
    expect(hashRecoveryCode(codes[0]!.toUpperCase())).toBe(hashes[0]);
  });
});
