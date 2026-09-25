import { describe, expect, it } from 'vitest';
import { parseIntent } from './intent.js';

const now = new Date('2026-09-23T10:00:00Z'); // Wednesday
const p = (q: string, tz = 'UTC') => parseIntent(q, { now, timeZone: tz });

describe('natural-language intents', () => {
  it('"find technology communities"', () => {
    const i = p('find technology communities');
    expect(i.mode).toBe('natural_language');
    expect(i.entityTypes).toEqual(['communities']);
    expect(i.topics).toEqual(['technology']);
    expect(i.keywords).toEqual(['technology']);
    expect(i.timeWindow).toBeNull();
  });

  it('"restaurants suitable for six people"', () => {
    const i = p('restaurants suitable for six people');
    expect(i.entityTypes).toEqual(['places']);
    expect(i.placeKinds).toEqual(['restaurant']);
    expect(i.partySize).toBe(6);
    expect(i.keywords).toEqual([]);
  });

  it('"something interesting to do tonight"', () => {
    const i = p('something interesting to do tonight', 'America/New_York');
    expect(i.entityTypes).toEqual(['events', 'places']);
    expect(i.timeWindow?.label).toBe('tonight');
    expect(i.timeWindow?.to.toISOString()).toBe('2026-09-24T09:00:00.000Z');
    expect(i.keywords).toEqual([]);
    expect(i.placeKinds).toEqual(expect.arrayContaining(['venue', 'attraction', 'restaurant']));
  });

  it('"creators who teach networking"', () => {
    const i = p('creators who teach networking');
    expect(i.entityTypes).toEqual(['creators']);
    expect(i.keywords).toEqual(['teach', 'networking']);
  });

  it('"events this weekend near me"', () => {
    const i = p('events this weekend near me');
    expect(i.entityTypes).toEqual(['events']);
    expect(i.timeWindow?.label).toBe('this weekend');
    expect(i.nearMe).toBe(true);
    expect(i.keywords).toEqual([]);
  });

  it.each([
    ['live music tonight', ['music'], 'tonight'],
    ['jazz concerts tomorrow', [], 'tomorrow'],
    ['workshops next week', [], 'next week'],
    ['weekend events', [], 'this weekend'],
    ['events next weekend', [], 'next weekend'],
    ['what is on today', [], 'today'],
  ])('time phrase in %s', (q, topics, label) => {
    const i = p(q);
    expect(i.timeWindow?.label).toBe(label);
    expect(i.topics).toEqual(topics);
  });

  it.each([
    ['table for 4 at a cafe', 4, 'restaurant'],
    ['party of eight restaurants', 8, 'restaurant'],
    ['restaurants for a group of twelve', 12, 'restaurant'],
    ['venues for 30 people', 30, 'venue'],
    ['bars for ten guests', 10, 'restaurant'],
  ])('party size in %s', (q, size, kind) => {
    const i = p(q);
    expect(i.partySize).toBe(size);
    expect(i.placeKinds).toContain(kind);
  });

  it('does not mistake durations for party size', () => {
    const i = p('yoga classes for 2 hours');
    expect(i.partySize).toBeNull();
  });

  it.each([
    'nearby coffee shops',
    'coffee shops near me',
    'cafes around me',
    'restaurants close to me',
    'local gyms',
  ])('near me: %s', (q) => {
    const i = p(q);
    expect(i.nearMe).toBe(true);
    expect(i.entityTypes).toEqual(['places']);
  });

  it('price hints', () => {
    expect(p('cheap products').priceHint).toBe('cheap');
    expect(p('affordable restaurants near me').priceHint).toBe('cheap');
    expect(p('luxury products').priceHint).toBe('premium');
    expect(p('products under $20').priceHint).toBe('cheap');
    expect(p('restaurants').priceHint).toBeNull();
  });

  it.each([
    ['find people who love hiking', ['people'], ['nature']],
    ['videos about cooking', ['videos'], ['food']],
    ['football groups', ['communities'], ['football']],
    ['fitness clubs', ['communities'], ['fitness']],
    ['startup businesses', ['businesses'], ['startups']],
    ['posts about mental health', ['posts'], ['mental-health']],
    ['cyber security communities', ['communities'], ['cybersecurity']],
  ])('entity + topic in %s', (q, entities, topics) => {
    const i = p(q);
    expect(i.entityTypes).toEqual(entities);
    expect(i.topics).toEqual(topics);
  });

  it('understands plural and singular entity words', () => {
    expect(p('community').entityTypes).toEqual(['communities']);
    expect(p('companies').entityTypes).toEqual(['businesses']);
    expect(p('event').entityTypes).toEqual(['events']);
    expect(p('museums').placeKinds).toEqual(['attraction']);
  });

  it('collects several entity types', () => {
    const i = p('videos and posts about travel');
    expect(i.entityTypes).toEqual(['videos', 'posts']);
    expect(i.topics).toEqual(['travel']);
  });

  it('uses extra topic vocabulary from the database', () => {
    const i = parseIntent('find sailing communities', {
      now,
      topics: [{ slug: 'sailing', name: 'Sailing' }],
    });
    expect(i.topics).toEqual(['sailing']);
    const j = parseIntent('board games events', {
      now,
      topics: [{ slug: 'board-games', name: 'Board Games' }],
    });
    expect(j.topics).toEqual(['board-games']);
    expect(j.entityTypes).toEqual(['events']);
  });

  it('handles accents, case and punctuation', () => {
    const i = p('  Find CAFÉS near me!!  ');
    expect(i.entityTypes).toEqual(['places']);
    expect(i.nearMe).toBe(true);
  });

  it('describes its interpretation', () => {
    expect(p('events this weekend near me').explanation).toMatch(/events.*this weekend.*near you/);
    expect(p('restaurants suitable for six people').explanation).toMatch(/6 people/);
  });
});

describe('fallback to plain keyword search', () => {
  it.each([
    'purple monkey dishwasher',
    'grant olaide',
    'zxqv',
    'the office',
    'react hooks tutorial',
  ])('unrecognised "%s" is a keyword search', (q) => {
    const i = p(q);
    expect(i.mode).toBe('keyword');
    expect(i.entityTypes).toEqual([]);
    expect(i.timeWindow).toBeNull();
    expect(i.partySize).toBeNull();
    expect(i.nearMe).toBe(false);
    expect(i.keywords.length).toBeGreaterThan(0);
  });

  it('keeps all typed words but drops glue words', () => {
    expect(p('the lord of the rings').keywords).toEqual(['lord', 'rings']);
  });

  it('empty and whitespace queries produce nothing structured', () => {
    for (const q of ['', '   ']) {
      const i = p(q);
      expect(i.mode).toBe('keyword');
      expect(i.keywords).toEqual([]);
      expect(i.entityTypes).toEqual([]);
    }
  });

  it('only stop words falls back to the typed words', () => {
    expect(p('the of').keywords).toEqual(['the', 'of']);
  });

  it('a bare topic word stays a keyword search but records the topic', () => {
    const i = p('technology');
    expect(i.mode).toBe('keyword');
    expect(i.topics).toEqual(['technology']);
    expect(i.keywords).toEqual(['technology']);
  });
});

describe('search syntax passthrough', () => {
  it('quoted phrases and exclusions are passed verbatim', () => {
    const i = p('"dark mode" -light');
    expect(i.rawSyntax).toBe(true);
    expect(i.keywords).toEqual(['"dark mode" -light']);
    expect(i.entityTypes).toEqual([]);
  });
  it('@handle searches people', () => {
    const i = p('@Jane_Doe');
    expect(i.entityTypes).toEqual(['people', 'creators']);
    expect(i.keywords).toEqual(['jane_doe']);
  });
  it('#tag searches content and topics', () => {
    const i = p('#technology');
    expect(i.entityTypes).toContain('posts');
    expect(i.topics).toEqual(['technology']);
  });
});

describe('robustness', () => {
  it('never throws on hostile input', () => {
    for (const q of [
      "'; DROP TABLE users; --",
      '\u0000\u0001',
      'a'.repeat(5000),
      '((((',
      '%_\\',
      '<script>alert(1)</script>',
      '日本語のクエリ',
      '🙂🙂🙂',
    ]) {
      expect(() => p(q)).not.toThrow();
    }
  });
  it('caps the keyword count', () => {
    const i = p(Array.from({ length: 50 }, (_, n) => `word${n}`).join(' '));
    expect(i.keywords.length).toBeLessThanOrEqual(12);
  });
  it('is deterministic', () => {
    expect(p('events this weekend near me')).toEqual(p('events this weekend near me'));
  });
});
