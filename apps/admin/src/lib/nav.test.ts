import { describe, expect, it } from 'vitest';
import type { PlatformRoleName } from '@yapilapi/api-client';
import { MATRIX } from '@/test-utils';
import { activeNavId, NAV, visibleNav } from './nav';
import { ROLE_RANK } from './session';

const ids = (role: Exclude<PlatformRoleName, 'user'>) =>
  visibleNav(
    (p) => MATRIX.byRole[role].has(p),
    (r) => ROLE_RANK[role] >= ROLE_RANK[r],
  ).flatMap((g) => g.items.map((i) => i.id));

describe('role-based navigation', () => {
  it('only references permissions the API actually defines (a typo would hide a section from everyone)', () => {
    const used = NAV.flatMap((g) => g.items.map((i) => i.permission)).filter(
      (p): p is string => !!p,
    );
    expect(used.filter((p) => !MATRIX.all.includes(p))).toEqual([]);
  });

  it('gives support read-only sections and no moderation tools, finance or platform pages', () => {
    expect(ids('support')).toEqual([
      'dashboard',
      'users',
      'content',
      'moderation',
      'communities',
      'businesses',
      'creators',
      'payments',
    ]);
  });

  it('adds nothing new to the navigation for moderators', () => {
    expect(ids('moderator')).toEqual(ids('support'));
  });

  it('shows everything to admins, including the audit log and feature flags', () => {
    expect(ids('admin')).toEqual([
      'dashboard',
      'users',
      'content',
      'moderation',
      'communities',
      'businesses',
      'creators',
      'payments',
      'fraud',
      'analytics',
      'ai',
      'audit',
      'flags',
      'developer',
    ]);
    expect(ids('superadmin')).toEqual(ids('admin'));
  });

  it('never shows an empty group', () => {
    for (const role of ['support', 'moderator', 'admin', 'superadmin'] as const) {
      expect(
        visibleNav(
          (p) => MATRIX.byRole[role].has(p),
          () => true,
        ).every((g) => g.items.length > 0),
      ).toBe(true);
    }
  });

  it('keeps hrefs unique', () => {
    const hrefs = NAV.flatMap((g) => g.items.map((i) => i.href));
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('marks the owning section active for nested paths', () => {
    expect(activeNavId('/')).toBe('dashboard');
    expect(activeNavId('/moderation/cases/abc')).toBe('moderation');
    expect(activeNavId('/analytics/retention')).toBe('analytics');
    expect(activeNavId('/payments/refunds')).toBe('payments');
    expect(activeNavId('/nowhere')).toBe('');
  });
});

describe('permission matrix parsed from the API', () => {
  it('matches the documented roles', () => {
    expect(MATRIX.byRole.support.has('users.read')).toBe(true);
    expect(MATRIX.byRole.support.has('users.suspend')).toBe(false);
    expect(MATRIX.byRole.moderator.has('cases.decide')).toBe(true);
    expect(MATRIX.byRole.moderator.has('cases.ban')).toBe(false);
    expect(MATRIX.byRole.admin.has('cases.ban')).toBe(true);
    expect(MATRIX.byRole.admin.has('users.role_change')).toBe(false);
    expect(MATRIX.byRole.superadmin.has('users.role_change')).toBe(true);
  });
});
