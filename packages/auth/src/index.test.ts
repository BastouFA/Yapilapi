import { describe, expect, it } from 'vitest';
import { hashPassword, hashToken, newToken, verifyPassword } from './index.ts';

describe('passwords', () => {
  it('verifies the right password and rejects the wrong one', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('wrong password here', h)).toBe(false);
  });

  it('returns false for a missing hash', async () => {
    expect(await verifyPassword('anything', null)).toBe(false);
  });

  it('salts each hash', async () => {
    expect(await hashPassword('same password')).not.toBe(await hashPassword('same password'));
  });
});

describe('tokens', () => {
  it('stores only the hash', () => {
    const { token, hash } = newToken();
    expect(token.length).toBeGreaterThan(40);
    expect(hash).toBe(hashToken(token));
    expect(hash).not.toContain(token);
  });
});
