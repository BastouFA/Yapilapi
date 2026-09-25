import { kv } from './kv';

const KEY = 'yl.ageblock.v1';
const TTL_MS = 24 * 60 * 60 * 1000;

/** After someone enters an under-age birth date, remember it for a day so they cannot simply retype a different one. */
export async function markAgeBlocked(now: number = Date.now()): Promise<void> {
  await kv.set(KEY, now);
}
export async function isAgeBlocked(now: number = Date.now()): Promise<boolean> {
  const at = await kv.get<number>(KEY);
  return typeof at === 'number' && now - at < TTL_MS;
}
