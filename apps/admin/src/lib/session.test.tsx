import { describe, expect, it } from 'vitest';
import { adminMe, fakeUser } from '@/test-utils';
import { makeAdminContext } from './session';

describe('admin session context', () => {
  it('answers can() from the permissions the server returned, nothing more', () => {
    const ctx = makeAdminContext(fakeUser('moderator'), {
      ...adminMe('moderator'),
      permissions: ['cases.read'],
    });
    expect(ctx.can('cases.read')).toBe(true);
    expect(ctx.can('cases.decide')).toBe(false);
  });

  it('ranks roles for role-gated routes', () => {
    const ctx = makeAdminContext(fakeUser('moderator'), adminMe('moderator'));
    expect(ctx.atLeast('support')).toBe(true);
    expect(ctx.atLeast('moderator')).toBe(true);
    expect(ctx.atLeast('admin')).toBe(false);
  });
});
