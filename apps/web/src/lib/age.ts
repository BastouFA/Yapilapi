/** Age helpers. Mirrors the API's rules (UTC calendar arithmetic, minimum 13, teen band under 18). */
export const MIN_AGE = 13;
export const ADULT_AGE = 18;
export const MAX_AGE = 120;

export function ageInYears(isoDate: string, now: Date = new Date()): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return null;
  const y = Number(m[1]),
    mo = Number(m[2]),
    d = Number(m[3]);
  const birth = new Date(Date.UTC(y, mo - 1, d));
  if (birth.getUTCFullYear() !== y || birth.getUTCMonth() !== mo - 1 || birth.getUTCDate() !== d)
    return null; // e.g. 2023-02-31
  if (birth.getTime() > now.getTime()) return null;
  let age = now.getUTCFullYear() - y;
  const dm = now.getUTCMonth() - (mo - 1);
  if (dm < 0 || (dm === 0 && now.getUTCDate() < d)) age--;
  return age;
}

export type AgeGate =
  | { kind: 'invalid' }
  | { kind: 'blocked'; age: number }
  | { kind: 'teen'; age: number }
  | { kind: 'adult'; age: number };

export function ageGate(isoDate: string, now: Date = new Date()): AgeGate {
  const age = ageInYears(isoDate, now);
  if (age === null || age > MAX_AGE) return { kind: 'invalid' };
  if (age < MIN_AGE) return { kind: 'blocked', age };
  return age < ADULT_AGE ? { kind: 'teen', age } : { kind: 'adult', age };
}

/** Where a "next" redirect may go: same-site absolute paths only (no open redirects). */
export function safeNext(next: string | string[] | undefined | null, fallback = '/'): string {
  const v = Array.isArray(next) ? next[0] : next;
  if (!v || !v.startsWith('/') || v.startsWith('//') || v.startsWith('/\\') || /[\r\n]/.test(v))
    return fallback;
  return v;
}
