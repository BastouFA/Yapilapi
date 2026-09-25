import { describe, expect, it } from 'vitest';
import { isValidTimeZone, resolveTimeWindow, zonedToUtc } from './timewindow.js';

// 2026-09-23 is a Wednesday.
const wed = new Date('2026-09-23T10:00:00Z');

describe('time windows', () => {
  it('converts wall clock in a zone to UTC, including DST', () => {
    expect(zonedToUtc(2026, 9, 23, 9, 0, 'America/New_York').toISOString()).toBe(
      '2026-09-23T13:00:00.000Z',
    );
    expect(zonedToUtc(2026, 1, 15, 9, 0, 'America/New_York').toISOString()).toBe(
      '2026-01-15T14:00:00.000Z',
    );
    expect(zonedToUtc(2026, 9, 23, 9, 0, 'Asia/Tokyo').toISOString()).toBe(
      '2026-09-23T00:00:00.000Z',
    );
  });

  it('validates zone names', () => {
    expect(isValidTimeZone('Europe/Lisbon')).toBe(true);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
  });

  it('resolves tonight in the viewer timezone', () => {
    const w = resolveTimeWindow('tonight', wed, 'America/New_York'); // 06:00 local
    expect(w.from.toISOString()).toBe('2026-09-23T21:00:00.000Z'); // 17:00 EDT
    expect(w.to.toISOString()).toBe('2026-09-24T09:00:00.000Z'); // 05:00 EDT next day
  });

  it('keeps "tonight" open when already evening and after midnight', () => {
    const evening = new Date('2026-09-23T23:30:00Z'); // 19:30 EDT
    expect(resolveTimeWindow('tonight', evening, 'America/New_York').from.toISOString()).toBe(
      evening.toISOString(),
    );
    const late = new Date('2026-09-24T05:00:00Z'); // 01:00 EDT
    const w = resolveTimeWindow('tonight', late, 'America/New_York');
    expect(w.from.toISOString()).toBe(late.toISOString());
    expect(w.to.toISOString()).toBe('2026-09-24T09:00:00.000Z');
  });

  it('resolves today and tomorrow', () => {
    const today = resolveTimeWindow('today', wed, 'UTC');
    expect(today.to.toISOString()).toBe('2026-09-24T00:00:00.000Z');
    const tom = resolveTimeWindow('tomorrow', wed, 'UTC');
    expect(tom.from.toISOString()).toBe('2026-09-24T00:00:00.000Z');
    expect(tom.to.toISOString()).toBe('2026-09-25T00:00:00.000Z');
  });

  it('resolves this weekend (Fri 18:00 - Mon 00:00) and next weekend', () => {
    const w = resolveTimeWindow('this weekend', wed, 'UTC');
    expect(w.from.toISOString()).toBe('2026-09-25T18:00:00.000Z');
    expect(w.to.toISOString()).toBe('2026-09-28T00:00:00.000Z');
    const n = resolveTimeWindow('next weekend', wed, 'UTC');
    expect(n.from.toISOString()).toBe('2026-10-02T18:00:00.000Z');
    expect(n.to.toISOString()).toBe('2026-10-05T00:00:00.000Z');
  });

  it('this weekend is "now" on a Saturday', () => {
    const sat = new Date('2026-09-26T12:00:00Z');
    const w = resolveTimeWindow('this weekend', sat, 'UTC');
    expect(w.from.toISOString()).toBe(sat.toISOString());
    expect(w.to.toISOString()).toBe('2026-09-28T00:00:00.000Z');
  });

  it('resolves this week and next week to Monday boundaries', () => {
    const tw = resolveTimeWindow('this week', wed, 'UTC');
    expect(tw.to.toISOString()).toBe('2026-09-28T00:00:00.000Z');
    const nw = resolveTimeWindow('next week', wed, 'UTC');
    expect(nw.from.toISOString()).toBe('2026-09-28T00:00:00.000Z');
    expect(nw.to.toISOString()).toBe('2026-10-05T00:00:00.000Z');
    const mon = new Date('2026-09-28T08:00:00Z');
    expect(resolveTimeWindow('next week', mon, 'UTC').from.toISOString()).toBe(
      '2026-10-05T00:00:00.000Z',
    );
  });

  it('falls back to UTC for an unknown zone', () => {
    expect(resolveTimeWindow('tomorrow', wed, 'Nope/Zone').from.toISOString()).toBe(
      '2026-09-24T00:00:00.000Z',
    );
  });
});
