import { describe, expect, it } from 'vitest';
import { t, tp } from './i18n.ts';
import { hideStashSchema, stashSettingsSchema } from './stash-schemas.ts';
import {
  STASH_KIND_KEYS,
  STASH_KINDS,
  accurateEnough,
  launchCityAt,
  roundedToGo,
  speedKmh,
  stashBadges,
  stashMetresToGo,
  stashNoticeTarget,
  stashNoticeText,
} from './stash.ts';

const en = (key: Parameters<typeof t>[0], vars?: Record<string, string | number>) => t(key, 'en', vars);
const enp = (key: 'stash.notif.found' | 'push.stash_nearby', n: number, vars?: Record<string, string | number>) => tp(key, n, 'en', vars);

describe('Stash', () => {
  it('opens within 50 m, counting up to 30 m of the accuracy', () => {
    expect(stashMetresToGo(40, 5)).toBe(0);
    expect(stashMetresToGo(75, 30)).toBe(0);
    expect(stashMetresToGo(75, 80)).toBe(0);
    expect(stashMetresToGo(120, 80)).toBe(40);
    expect(stashMetresToGo(90, 5)).toBe(35);
    expect(accurateEnough(100)).toBe(true);
    expect(accurateEnough(101)).toBe(false);
    expect(accurateEnough(Number.NaN)).toBe(false);
  });

  it('rounds what is left up, and says nothing exact far away', () => {
    expect(roundedToGo(0)).toBe(0);
    expect(roundedToGo(35)).toBe(40);
    expect(roundedToGo(121)).toBe(150);
    expect(roundedToGo(640)).toBe(700);
    expect(roundedToGo(1500)).toBeNull();
  });

  it('knows the launch cities and fast jumps', () => {
    expect(launchCityAt({ lat: 6.45, lng: 3.42 })?.name).toBe('Lagos');
    expect(launchCityAt({ lat: 6.17, lng: 1.23 })?.name).toBe('Lomé');
    expect(launchCityAt({ lat: 48.86, lng: 2.33 })?.name).toBe('Paris');
    expect(launchCityAt({ lat: 51.5, lng: -0.12 })).toBeNull();
    expect(speedKmh({ lat: 6.45, lng: 3.42 }, { lat: 48.86, lng: 2.33 }, 60)).toBeGreaterThan(300);
  });

  it('gives badges for 1, 10 and 50 finds and 3 cities', () => {
    expect(stashBadges(0, 0)).toEqual([]);
    expect(stashBadges(12, 3)).toEqual(['first_find', 'finds_10', 'cities_3']);
    expect(stashBadges(50, 1)).toEqual(['first_find', 'finds_10', 'finds_50']);
  });

  it('words its notifications', () => {
    expect(stashNoticeText({ type: 'stash_found', actor: { displayName: 'Ada' }, data: { count: 1 } }, en, enp)).toBe('Ada found your stash');
    expect(stashNoticeText({ type: 'stash_found', actor: { displayName: 'Ada' }, data: { count: 3 } }, en, enp)).toBe('Ada and 2 others found your stash');
    expect(stashNoticeText({ type: 'stash_thanks', actor: { displayName: 'Ada' }, data: {} }, en, enp)).toBe('Ada thanked you for your stash');
    expect(stashNoticeText({ type: 'stash_nearby', data: { count: 3 } }, en, enp)).toBe('3 new stashes near you today');
    expect(stashNoticeText({ type: 'follow', data: {} }, en, enp)).toBeNull();
    expect(stashNoticeTarget({ type: 'stash_found', entityId: 's1' })).toBe('s1');
    expect(stashNoticeTarget({ type: 'stash_nearby' })).toBe('');
    expect(stashNoticeTarget({ type: 'follow', entityId: 's1' })).toBeNull();
    for (const k of STASH_KINDS) expect(en(STASH_KIND_KEYS[k])).not.toBe(STASH_KIND_KEYS[k]);
  });

  it('checks what goes in', () => {
    const base = { audience: 'everyone', duration: '24h', position: { lat: 6.45, lng: 3.42, accuracy: 10 } };
    expect(hideStashSchema.safeParse({ ...base, kind: 'text', body: 'Hi' }).success).toBe(true);
    expect(hideStashSchema.safeParse({ ...base, kind: 'text' }).success).toBe(false);
    expect(hideStashSchema.safeParse({ ...base, kind: 'gift', giftCode: 'X' }).success).toBe(true);
    expect(hideStashSchema.safeParse({ ...base, kind: 'text', body: 'Hi', audience: 'person' }).success).toBe(false);
    expect(stashSettingsSchema.safeParse({ showCounts: false }).success).toBe(true);
  });
});
