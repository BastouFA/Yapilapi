import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// scrypt parameters (OWASP-recommended minimum: N=2^17, r=8, p=1). Encoded in the hash so they can be raised later.
const DEFAULT = { N: 2 ** 15, r: 8, p: 1, keyLen: 64 } as const;
const MAXMEM = 256 * 1024 * 1024;

function scrypt(
  password: string,
  salt: Buffer,
  keyLen: number,
  opts: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password.normalize('NFKC'), salt, keyLen, { ...opts, maxmem: MAXMEM }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(
  password: string,
  params: Partial<typeof DEFAULT> = {},
): Promise<string> {
  const { N, r, p, keyLen } = { ...DEFAULT, ...params };
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, keyLen, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, keyB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** True when the stored hash uses weaker params than the current default and should be re-hashed on login. */
export function needsRehash(stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true;
  return Number(parts[1]) < DEFAULT.N || Number(parts[2]) < DEFAULT.r;
}
