import { describe, expect, it } from 'vitest';
import {
  ASK_AREA_METRES,
  ASK_TOPICS,
  ASK_TOPIC_KEYS,
  askAreaLabel,
  askAreaPoint,
  askDefaultExpiry,
  askNoticePost,
  askNoticeText,
  cityKey,
} from './ask-city.ts';
import { t } from './i18n.ts';

describe('Ask the city', () => {
  it('names the area: a part of a city, or the city alone', () => {
    expect(askAreaLabel({ city: 'Lagos', area: 'Yaba' })).toBe('Yaba, Lagos');
    expect(askAreaLabel({ city: 'Lagos', area: null })).toBe('Lagos');
    expect(askAreaLabel({ city: 'Lagos', area: ' lagos ' })).toBe('Lagos');
  });

  it('matches cities whatever their case and spacing', () => {
    expect(cityKey('  Port   Harcourt ')).toBe('port harcourt');
    expect(cityKey('LAGOS')).toBe(cityKey('lagos'));
  });

  it('keeps only the middle of the map on a 2 km grid, never the exact spot', () => {
    const box = { south: 6.4, west: 3.3, north: 6.6, east: 3.5 };
    const p = askAreaPoint(box);
    expect(p).not.toEqual({ lat: 6.5, lng: 3.4 });
    expect(Math.abs(p.lat - 6.5) * 111_320).toBeLessThanOrEqual(ASK_AREA_METRES / 2 + 1);
    // Nearby views land on the same point.
    expect(askAreaPoint({ south: 6.4001, west: 3.3001, north: 6.6001, east: 3.5001 })).toEqual(p);
  });

  it('closes traffic questions after an hour by default', () => {
    expect(askDefaultExpiry('traffic')).toBe('1h');
    for (const topic of ASK_TOPICS.filter((x) => x !== 'traffic')) expect(askDefaultExpiry(topic)).toBeNull();
  });

  it('puts notifications into words and opens the question', () => {
    const en = (key: Parameters<typeof t>[0], vars?: Record<string, string | number>) => t(key, 'en', vars);
    expect(askNoticeText({ type: 'ask_nearby', data: { area: 'Yaba, Lagos', topic: 'food' } }, en)).toBe(
      `New question in Yaba, Lagos: ${en(ASK_TOPIC_KEYS.food)}`,
    );
    expect(askNoticeText({ type: 'ask_helpful', actor: { displayName: 'Ada' }, data: {} }, en)).toBe('Ada found your answer helpful');
    expect(askNoticeText({ type: 'follow', data: {} }, en)).toBeNull();
    expect(askNoticePost({ type: 'ask_nearby', entityId: 'p1' })).toBe('p1');
    expect(askNoticePost({ type: 'follow', entityId: 'p1' })).toBeNull();
  });
});
