import { ApiError } from '@yapilapi/api-client';
import {
  ADULT_AGE_YEARS,
  MIN_AGE_YEARS,
  ageGate,
  isEmail,
  parseBirthDate,
  USERNAME_RE,
} from '../src/lib/validation';
import {
  compactNumber,
  formatBytes,
  initials,
  relativeTime,
  shortDate,
  timeOfDay,
} from '../src/lib/format';
import { errorMessage, fieldErrors, isOffline } from '../src/lib/errors';
import { isAgeBlocked, markAgeBlocked } from '../src/lib/age-block';
import { makeT } from '../src/i18n';
import { sha256Hex, Sha256 } from '../src/lib/sha256';
import { uuid } from '../src/lib/ids';
import AsyncStorage from '@react-native-async-storage/async-storage';

const NOW = new Date('2026-09-21T12:00:00Z');
const t = makeT('en');

describe('age gate', () => {
  it('matches the API minimum and adult threshold', () => {
    expect([MIN_AGE_YEARS, ADULT_AGE_YEARS]).toEqual([13, 18]);
  });
  it('blocks under 13 (exactly one day short of the 13th birthday)', () => {
    expect(ageGate('2013-09-22', NOW)).toEqual({ ok: false, reason: 'too_young', age: 12 });
    expect(ageGate('2013-09-21', NOW)).toEqual({ ok: true, band: 'teen', age: 13 });
  });
  it('classifies 13-17 as teen and 18+ as adult on the birthday itself', () => {
    expect(ageGate('2008-09-22', NOW)).toMatchObject({ ok: true, band: 'teen', age: 17 });
    expect(ageGate('2008-09-21', NOW)).toMatchObject({ ok: true, band: 'adult', age: 18 });
    expect(ageGate('1990-01-01', NOW)).toMatchObject({ ok: true, band: 'adult' });
  });
  it('rejects impossible, future and absurd dates', () => {
    expect(ageGate('2000-02-30', NOW)).toEqual({ ok: false, reason: 'invalid' });
    expect(ageGate('abcd-ef-gh', NOW)).toEqual({ ok: false, reason: 'invalid' });
    expect(ageGate('2027-01-01', NOW)).toEqual({ ok: false, reason: 'future' });
    expect(ageGate('1800-01-01', NOW)).toEqual({ ok: false, reason: 'invalid' });
    expect(parseBirthDate('2000-13-01')).toBeNull();
  });
  it('remembers an under-age attempt for 24 hours', async () => {
    await AsyncStorage.clear();
    expect(await isAgeBlocked()).toBe(false);
    await markAgeBlocked(1_000);
    expect(await isAgeBlocked(1_000 + 3_600_000)).toBe(true);
    expect(await isAgeBlocked(1_000 + 25 * 3_600_000)).toBe(false);
  });
});

describe('field validation', () => {
  it('emails and usernames', () => {
    expect(isEmail('a@b.co')).toBe(true);
    expect(isEmail('a@b')).toBe(false);
    expect(USERNAME_RE.test('ada_obi')).toBe(true);
    expect(USERNAME_RE.test('ab')).toBe(false);
    expect(USERNAME_RE.test('Ada Obi')).toBe(false);
  });
});

describe('error messages', () => {
  const api = (
    code: string,
    status: number,
    extra: Partial<{ details: unknown; retry: number | null }> = {},
  ) => new ApiError(code, 'English server text', status, 'req', extra.details, extra.retry ?? null);
  it('localises known codes and never leaks raw text for 5xx or unknown errors', () => {
    expect(errorMessage(api('network_error', 0), t)).toBe(t('error.network'));
    expect(errorMessage(api('timeout', 0), t)).toBe(t('error.timeout'));
    expect(errorMessage(api('rate_limited', 429, { retry: 30 }), t)).toContain('30');
    expect(errorMessage(api('internal', 500), t)).toBe(t('error.generic'));
    expect(errorMessage(new Error('boom'), t)).toBe(t('error.generic'));
    expect(errorMessage(api('not_found', 404), makeT('fr'))).toBe(makeT('fr')('error.notFound'));
  });
  it('passes through expected 4xx business messages (e.g. a teen rule) and first field issue for validation errors', () => {
    expect(errorMessage(api('forbidden', 403), t)).toBe('English server text');
    expect(
      errorMessage(
        api('validation_failed', 422, {
          details: { issues: [{ path: 'email', message: 'Invalid email' }] },
        }),
        t,
      ),
    ).toBe('Invalid email');
  });
  it('fieldErrors keys by top-level field and isOffline detects connectivity failures only', () => {
    expect(
      fieldErrors(
        api('validation_failed', 422, {
          details: {
            issues: [
              { path: 'birthDate', message: 'bad' },
              { path: 'profile.name', message: 'x' },
            ],
          },
        }),
      ),
    ).toEqual({ birthDate: 'bad', profile: 'x' });
    expect(isOffline(api('network_error', 0))).toBe(true);
    expect(isOffline(api('forbidden', 403))).toBe(false);
  });
});

describe('formatting', () => {
  it('relative time uses the active locale and the shared units', () => {
    expect(relativeTime('2026-09-21T11:00:00Z', 'en', NOW.getTime())).toMatch(/1\s?h/);
    expect(relativeTime('2026-09-19T12:00:00Z', 'en', NOW.getTime())).toMatch(/2\s?d|2 days/);
    expect(relativeTime('2026-09-21T11:00:00Z', 'fr', NOW.getTime())).toMatch(/1\s?h/);
  });
  it('numbers, bytes, dates, initials', () => {
    expect(compactNumber(1500, 'en')).toBe('1.5K');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(shortDate('2026-01-05T00:00:00Z', 'en')).toMatch(/2026/);
    expect(timeOfDay('2026-01-05T13:05:00Z', 'en')).toMatch(/\d/);
    expect(initials('Ada Obi')).toBe('AO');
    expect(initials('  ')).toBe('?');
  });
});

describe('crypto helpers', () => {
  it('sha256 matches known vectors, incrementally too (used to verify resumable uploads)', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    const h = new Sha256();
    h.update(new TextEncoder().encode('a'));
    h.update(new TextEncoder().encode('bc'));
    expect(h.digestHex()).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await sha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
  it('uuid() returns RFC 4122 v4 ids', () => {
    expect(uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
