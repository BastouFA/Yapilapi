import { describe, expect, it } from 'vitest';
import { t, tp, type MessageKey, type PluralKey } from './i18n.ts';
import { dayPartOf, momentGroups, peopleGroups, pickBestOf, togetherClosesAt, togetherClosesAtOk, togetherFileName, togetherNoticeText } from './together.ts';

const user = (id: string, displayName = id) => ({ id, username: id, displayName, avatarUrl: null, mode: 'personal' as const });

describe('Together helpers', () => {
  it('puts the small hours in the night before', () => {
    const sat = new Date(2026, 9, 10);
    expect(dayPartOf(new Date(2026, 9, 10, 9))).toEqual({ part: 'morning', day: sat });
    expect(dayPartOf(new Date(2026, 9, 10, 14)).part).toBe('afternoon');
    expect(dayPartOf(new Date(2026, 9, 10, 19)).part).toBe('evening');
    expect(dayPartOf(new Date(2026, 9, 11, 1, 30))).toEqual({ part: 'night', day: sat });
  });

  it('groups moments by day and time of day, in order', () => {
    const at = (d: number, h: number) => new Date(2026, 9, d, h).toISOString();
    const groups = momentGroups([{ takenAt: at(10, 18) }, { takenAt: at(10, 19) }, { takenAt: at(10, 23) }, { takenAt: at(11, 2) }, { takenAt: at(11, 10) }]);
    expect(groups.map((g) => [g.part, g.items.length])).toEqual([
      ['evening', 2],
      ['night', 2],
      ['morning', 1],
    ]);
  });

  it('groups by who added most', () => {
    const ada = user('ada', 'Ada');
    const bo = user('bo', 'Bo');
    const g = peopleGroups([{ author: bo }, { author: ada }, { author: ada }]);
    expect(g.map((x) => [x.user.id, x.items.length])).toEqual([
      ['ada', 2],
      ['bo', 1],
    ]);
  });

  it('leaves out items nobody starred or reacted to, and keeps the order they were taken', () => {
    const best = pickBestOf([
      { id: 'late', authorId: 'a', stars: 3, reactions: 0, takenAt: '2026-01-02T00:00:00Z' },
      { id: 'early', authorId: 'b', stars: 0, reactions: 1, takenAt: '2026-01-01T00:00:00Z' },
      { id: 'none', authorId: 'c', stars: 0, reactions: 0, takenAt: '2026-01-01T12:00:00Z' },
    ]);
    expect(best).toEqual(['early', 'late']);
  });

  it('checks closing times and works out the windows', () => {
    const now = new Date(2026, 9, 7, 12); // a Wednesday
    expect(togetherClosesAt('weekend', now)!.getDay()).toBe(1);
    expect(togetherClosesAt('week', now)!.getTime() - now.getTime()).toBe(7 * 86_400_000);
    expect(togetherClosesAtOk(new Date(now.getTime() + 5 * 60_000), now)).toBe(false);
    expect(togetherClosesAtOk(new Date(now.getTime() + 2 * 3_600_000), now)).toBe(true);
    expect(togetherClosesAtOk(new Date(now.getTime() + 90 * 86_400_000), now)).toBe(false);
  });

  it('names saved files after the album', () => {
    expect(togetherFileName('Lagos weekend!', '1234567890', 'image', 'https://x/y.webp')).toBe('lagos-weekend-12345678.webp');
    expect(togetherFileName('', 'abcdefgh', 'video')).toBe('together-abcdefgh.mp4');
  });

  it('says what happened in whole sentences', () => {
    const tt = (k: MessageKey, v?: Record<string, string | number>) => t(k, 'en', v);
    const ttp = (k: PluralKey, n: number, v?: Record<string, string | number>) => tp(k, n, 'en', v);
    const actor = { displayName: 'Ada' };
    expect(togetherNoticeText({ type: 'together_added', actor, data: { title: 'Lagos weekend', count: 12, videos: 0 } }, tt, ttp)).toBe(
      'Ada added 12 photos to Lagos weekend',
    );
    expect(togetherNoticeText({ type: 'together_added', actor, data: { title: 'Lagos weekend', count: 3, videos: 1 } }, tt, ttp)).toBe(
      'Ada added 3 photos and videos to Lagos weekend',
    );
    expect(togetherNoticeText({ type: 'together_starred', actor, data: { title: 'Trip', count: 3 } }, tt, ttp)).toBe(
      'Ada and 2 others starred your photos in Trip',
    );
    expect(togetherNoticeText({ type: 'together_closing', data: { title: 'Trip' } }, tt, ttp)).toBe('Trip closes in an hour. Add your last photos.');
    expect(togetherNoticeText({ type: 'post_reaction', data: {} }, tt, ttp)).toBeNull();
  });
});
