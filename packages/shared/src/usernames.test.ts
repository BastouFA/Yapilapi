import { describe, expect, it } from 'vitest';
import { changeUsernameSchema } from './schemas.ts';
import { nextUsernameChange, USERNAME_CHANGE_DAYS, usernameProblem } from './usernames.ts';

describe('new usernames', () => {
  it('takes 3 to 30 letters, numbers and underscores', () => {
    expect(usernameProblem('ada')).toBeNull();
    expect(usernameProblem('Ada_Lovelace_1815')).toBeNull();
    expect(usernameProblem('a'.repeat(30))).toBeNull();
    expect(usernameProblem('ab')).toBe('length');
    expect(usernameProblem('a'.repeat(31))).toBe('length');
    expect(usernameProblem('ada.lovelace')).toBe('characters');
    expect(usernameProblem('ada-l')).toBe('characters');
    expect(usernameProblem('adé')).toBe('characters');
    expect(usernameProblem('ada l')).toBe('characters');
  });

  it('keeps reserved names, in any case, and anything with the service name', () => {
    for (const name of ['admin', 'Support', 'YAPILAPI', 'help', 'api', 'settings', 'yapilapi_team', 'real_yapilapi'])
      expect(usernameProblem(name), name).toBe('reserved');
    expect(usernameProblem('helpful_ada')).toBeNull();
  });

  it('explains the rule that was broken', () => {
    const r = changeUsernameSchema.safeParse({ username: 'no.dots' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]!.message).toMatch(/underscores/);
    expect(changeUsernameSchema.parse({ username: '  ada_l ' })).toEqual({ username: 'ada_l' });
  });

  it('allows the next change 14 days after the last', () => {
    expect(nextUsernameChange(null)).toBeNull();
    const at = new Date('2026-09-01T10:00:00Z');
    expect(nextUsernameChange(at)!.toISOString()).toBe(new Date(at.getTime() + USERNAME_CHANGE_DAYS * 86_400_000).toISOString());
  });
});
