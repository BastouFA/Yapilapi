import { describe, expect, it } from 'vitest';
import { ageGate, ageInYears, safeNext } from './age';

const now = new Date('2026-09-20T12:00:00Z');

describe('ageInYears', () => {
  it('counts whole years on the UTC calendar', () => {
    expect(ageInYears('2013-09-20', now)).toBe(13);
    expect(ageInYears('2013-09-21', now)).toBe(12);
    expect(ageInYears('2000-02-29', now)).toBe(26);
  });
  it('rejects malformed, impossible and future dates', () => {
    for (const bad of ['', '2020-13-01', '2023-02-31', '20-01-01', '2027-01-01', 'yesterday'])
      expect(ageInYears(bad, now), bad).toBeNull();
  });
});

describe('ageGate', () => {
  it('blocks under 13, marks 13-17 as teen, 18+ as adult', () => {
    expect(ageGate('2014-09-21', now)).toEqual({ kind: 'blocked', age: 11 });
    expect(ageGate('2013-09-20', now)).toEqual({ kind: 'teen', age: 13 });
    expect(ageGate('2008-09-21', now)).toEqual({ kind: 'teen', age: 17 });
    expect(ageGate('2008-09-20', now)).toEqual({ kind: 'adult', age: 18 });
  });
  it('treats absurd ages as invalid', () => {
    expect(ageGate('1800-01-01', now)).toEqual({ kind: 'invalid' });
  });
});

describe('safeNext', () => {
  it('allows same-site paths only', () => {
    expect(safeNext('/settings/privacy')).toBe('/settings/privacy');
    expect(safeNext('/u/ada?tab=posts')).toBe('/u/ada?tab=posts');
  });
  it.each([
    'https://evil.example',
    '//evil.example',
    '/\\evil.example',
    'javascript:alert(1)',
    '/ok\r\nSet-Cookie: x=1',
    '',
    undefined,
    null,
  ])('rejects %s', (v) => {
    expect(safeNext(v as string | undefined)).toBe('/');
  });
  it('uses the first value of an array and a custom fallback', () => {
    expect(safeNext(['/a', '/b'])).toBe('/a');
    expect(safeNext('nope', '/home')).toBe('/home');
  });
});
