import { describe, expect, it } from 'vitest';
import {
  ANON_ID_RE,
  CLIENT_EVENTS,
  SERVER_EVENTS,
  clientEventCatalog,
  validateEvent,
} from './events.js';
import {
  MIN_CELL,
  MSA_DAILY_CAP,
  cappedActions,
  isMeaningfulWeeklyParticipant,
  suppress,
} from './msa.js';

describe('event allowlist', () => {
  it('accepts a valid client event and returns only the parsed properties', () => {
    expect(validateEvent('screen_view', { screen: 'feed' }, 'client')).toEqual({
      ok: true,
      name: 'screen_view',
      props: { screen: 'feed' },
    });
  });

  it('rejects unknown names, including prototype keys', () => {
    for (const name of ['nope', '', '__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(validateEvent(name, {}, 'client')).toEqual({ ok: false, reason: 'unknown_event' });
      expect(validateEvent(name, {}, 'server')).toEqual({ ok: false, reason: 'unknown_event' });
    }
  });

  it('never lets a client send a server event, and vice versa', () => {
    for (const name of Object.keys(SERVER_EVENTS))
      expect(validateEvent(name, {}, 'client')).toEqual({
        ok: false,
        reason: 'not_allowed_from_client',
      });
    for (const name of Object.keys(CLIENT_EVENTS))
      expect(validateEvent(name, {}, 'server')).toEqual({ ok: false, reason: 'unknown_event' });
  });

  it('rejects unknown properties instead of silently dropping them', () => {
    expect(validateEvent('screen_view', { screen: 'feed', userId: 'x' }, 'client')).toEqual({
      ok: false,
      reason: 'invalid_properties',
    });
  });

  it('has no free-text property: strings must be enum members', () => {
    expect(
      validateEvent(
        'search_performed',
        { surface: 'global', had_results: true, query: 'my ex' },
        'client',
      ).ok,
    ).toBe(false);
    expect(
      validateEvent('screen_view', { screen: 'https://evil.example/?q=secret' }, 'client').ok,
    ).toBe(false);
    expect(validateEvent('client_error', { code: 'timeout', screen: 'feed' }, 'client').ok).toBe(
      true,
    );
    expect(
      validateEvent(
        'client_error',
        { code: 'Error: user alice@example.com not found', screen: 'feed' },
        'client',
      ).ok,
    ).toBe(false);
  });

  it('bounds numbers and rejects wrong types', () => {
    expect(
      validateEvent('web_vital', { metric: 'LCP', value: 1234.5, rating: 'good' }, 'client').ok,
    ).toBe(true);
    for (const value of [-1, 700_000, Number.NaN, Infinity, '12'])
      expect(
        validateEvent('web_vital', { metric: 'LCP', value, rating: 'good' }, 'client').ok,
      ).toBe(false);
  });

  it('treats missing properties as empty', () => {
    expect(validateEvent('appeal_created', undefined, 'server').ok).toBe(true);
    expect(validateEvent('screen_view', undefined, 'client')).toEqual({
      ok: false,
      reason: 'invalid_properties',
    });
  });

  it('publishes a catalog of exactly the client events', () => {
    const cat = clientEventCatalog();
    expect(cat.map((c) => c.name).sort()).toEqual(Object.keys(CLIENT_EVENTS).sort());
    for (const c of cat)
      expect(JSON.stringify(c.properties)).toContain('"additionalProperties":false');
  });

  it('anonymous ids must be random-looking tokens, not emails or short values', () => {
    expect(ANON_ID_RE.test('a3f9c2d4e5b6a7c8d9e0f1a2')).toBe(true);
    for (const bad of [
      'short',
      'has spaces in it 1234567890',
      'me@example.com-1234567890',
      'x'.repeat(65),
    ])
      expect(ANON_ID_RE.test(bad)).toBe(false);
  });
});

describe('Meaningful Social Actions rules', () => {
  it('caps each type per day', () => {
    expect(cappedActions({ message: 100 })).toBe(MSA_DAILY_CAP.message);
    expect(cappedActions({ comment: 11, post: 6, plan: 5 })).toBe(10 + 5 + 5);
    expect(cappedActions({ message: 3, comment: 2 })).toBe(5);
    expect(cappedActions({ message: -4 })).toBe(0);
    expect(cappedActions({})).toBe(0);
  });

  it('a Meaningful Weekly Participant needs >= 3 actions on >= 2 distinct days', () => {
    expect(isMeaningfulWeeklyParticipant({ '2026-01-01': 2, '2026-01-02': 1 })).toBe(true);
    expect(isMeaningfulWeeklyParticipant({ '2026-01-01': 30 })).toBe(false); // one very busy day is not a habit
    expect(isMeaningfulWeeklyParticipant({ '2026-01-01': 1, '2026-01-02': 1 })).toBe(false);
    expect(
      isMeaningfulWeeklyParticipant(
        new Map([
          ['a', 1],
          ['b', 1],
          ['c', 1],
        ]),
      ),
    ).toBe(true);
    expect(isMeaningfulWeeklyParticipant({ a: 3, b: 0 })).toBe(false); // zero-action days do not count as days
  });

  it('suppresses small cells but keeps zero and large counts', () => {
    expect(suppress(0)).toBe(0);
    for (let n = 1; n < MIN_CELL; n++) expect(suppress(n)).toBeNull();
    expect(suppress(MIN_CELL)).toBe(MIN_CELL);
    expect(suppress(1000)).toBe(1000);
    expect(suppress(null)).toBeNull();
  });
});
