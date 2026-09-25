import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM authenticated encryption for secrets at rest (MFA secrets, webhook secrets).
 * Format: `v1.<keyId>.<iv>.<tag>.<ciphertext>` (base64url segments). The key id supports rotation.
 */
export function encrypt(plaintext: string, key: Buffer, keyId = 'k1', aad?: string): string {
  if (key.length !== 32) throw new Error('encryption key must be 32 bytes');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    'v1',
    keyId,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ct.toString('base64url'),
  ].join('.');
}

export function decrypt(
  payload: string,
  keys: Record<string, Buffer> | Buffer,
  aad?: string,
): string {
  const parts = payload.split('.');
  if (parts.length !== 5 || parts[0] !== 'v1') throw new Error('unrecognized ciphertext format');
  const [, keyId, iv, tag, ct] = parts as [string, string, string, string, string];
  const key = Buffer.isBuffer(keys) ? keys : keys[keyId];
  if (!key) throw new Error(`no key for id ${keyId}`);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  if (aad) decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString(
    'utf8',
  );
}
