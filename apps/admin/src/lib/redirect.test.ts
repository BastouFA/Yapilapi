import { describe, expect, it } from 'vitest';
import { safeNext } from './redirect';

describe('safeNext (post sign-in redirect)', () => {
  it('keeps same-origin paths, including their query string', () => {
    expect(safeNext('/moderation/cases/123')).toBe('/moderation/cases/123');
    expect(safeNext('/users?q=ada')).toBe('/users?q=ada');
  });

  it.each([
    undefined,
    '',
    'https://evil.example',
    '//evil.example',
    '/\\evil.example',
    'javascript:alert(1)',
    'users',
    '/login',
    '/login?next=/',
  ])('refuses %j and falls back to the dashboard', (v) =>
    expect(safeNext(v as string | undefined)).toBe('/'),
  );
});
