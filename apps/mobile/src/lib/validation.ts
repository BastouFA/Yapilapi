/** Client-side pre-checks that save a round trip. The API remains the authority for every rule. */
export const MIN_AGE_YEARS = 13; // mirrors @yapilapi/shared MIN_AGE_YEARS
export const ADULT_AGE_YEARS = 18;

export function parseBirthDate(input: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d
    ? date
    : null;
}

export function ageInYears(birth: Date, now: Date = new Date()): number {
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const m = now.getUTCMonth() - birth.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < birth.getUTCDate())) age -= 1;
  return age;
}

export type AgeGate =
  | { ok: true; band: 'teen' | 'adult'; age: number }
  | { ok: false; reason: 'invalid' | 'future' | 'too_young'; age?: number };

export function ageGate(input: string, now: Date = new Date()): AgeGate {
  const d = parseBirthDate(input);
  if (!d) return { ok: false, reason: 'invalid' };
  if (d.getTime() > now.getTime()) return { ok: false, reason: 'future' };
  const age = ageInYears(d, now);
  if (age < MIN_AGE_YEARS) return { ok: false, reason: 'too_young', age };
  if (age > 120) return { ok: false, reason: 'invalid' };
  return { ok: true, band: age < ADULT_AGE_YEARS ? 'teen' : 'adult', age };
}

export const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
export const USERNAME_RE = /^[a-z0-9_]{3,30}$/; // the API lower-cases usernames first
export const PASSWORD_MIN = 10;
