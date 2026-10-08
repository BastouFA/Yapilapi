import { describe, expect, it } from 'vitest';
import { SQUAD_COLORS } from './constants.ts';
import { SUPPORTED_LOCALES, t, tp } from './i18n.ts';
import { contrastRatio } from './profile-style.ts';
import { SQUAD_COLOR_HEX, SQUAD_INK, squadColor, squadNoticeHref, squadNoticeText } from './squads.ts';

describe('squads', () => {
  it('has a colour for every cover choice, each AA with white text', () => {
    for (const c of SQUAD_COLORS) expect(contrastRatio(SQUAD_COLOR_HEX[c], SQUAD_INK), c).toBeGreaterThanOrEqual(4.5);
    expect(squadColor('nope')).toBe(SQUAD_COLOR_HEX.coral);
  });

  it('says each squad notification in every language, and opens the squad', () => {
    const notes = [
      { type: 'squad_invite', actor: { displayName: 'Ada' }, entityId: 's1', data: { name: 'Crew' } },
      { type: 'squad_joined', actor: { displayName: 'Ada' }, entityId: 's1', data: { name: 'Crew' } },
      { type: 'squad_post', actor: { displayName: 'Ada' }, entityId: 's1', data: { name: 'Crew', count: 3 } },
      { type: 'squad_memory', actor: null, entityId: 's1', data: { name: 'Crew' } },
    ];
    for (const locale of SUPPORTED_LOCALES)
      for (const n of notes) {
        const text = squadNoticeText(
          n,
          (k, v) => t(k, locale, v),
          (k, c, v) => tp(k, c, locale, v),
        );
        expect(text, `${locale} ${n.type}`).toContain('Crew');
        expect(text).not.toMatch(/\{/);
      }
    const en = (n: (typeof notes)[number]) =>
      squadNoticeText(
        n,
        (k, v) => t(k, 'en', v),
        (k, c, v) => tp(k, c, 'en', v),
      );
    expect(notes.map(en)).toEqual(['Ada invited you to join Crew', 'Ada joined Crew', 'Ada and 2 others shared in Crew', 'Your week in Crew is ready']);
    expect(squadNoticeHref(notes[0]!)).toBe('s1');
    expect(squadNoticeHref({ type: 'post_comment', entityId: 'p1' })).toBeNull();
    expect(squadNoticeText({ type: 'post_comment', data: {} }, t as never, tp as never)).toBeNull();
  });
});
