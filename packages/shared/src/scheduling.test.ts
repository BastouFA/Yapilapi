import { describe, expect, it } from 'vitest';
import {
  bookingSlots,
  hoursInWeekOrder,
  hoursKeyDays,
  hoursKeyLabel,
  openingRanges,
  timeZoneLabel,
  timeZoneList,
  utcToZonedWall,
  zonedWallToUtc,
} from './scheduling.ts';

const hm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

describe('time zones', () => {
  it('turns a wall time in a zone into the right moment and back', () => {
    // 19:30 in Lagos (UTC+1, no daylight saving) is 18:30 UTC.
    const wall = new Date(2026, 9, 3, 19, 30);
    expect(zonedWallToUtc(wall, 'Africa/Lagos').toISOString()).toBe('2026-10-03T18:30:00.000Z');
    const back = utcToZonedWall('2026-10-03T18:30:00.000Z', 'Africa/Lagos');
    expect([back.getFullYear(), back.getMonth(), back.getDate(), back.getHours(), back.getMinutes()]).toEqual([2026, 9, 3, 19, 30]);
  });

  it('follows daylight saving', () => {
    // New York is UTC-4 in July and UTC-5 in December.
    expect(zonedWallToUtc(new Date(2026, 6, 1, 9, 0), 'America/New_York').toISOString()).toBe('2026-07-01T13:00:00.000Z');
    expect(zonedWallToUtc(new Date(2026, 11, 1, 9, 0), 'America/New_York').toISOString()).toBe('2026-12-01T14:00:00.000Z');
  });

  it('keeps the time as it is for an unknown zone', () => {
    const wall = new Date(2026, 0, 5, 8, 0);
    expect(zonedWallToUtc(wall, 'Nowhere/Land').getTime()).toBe(wall.getTime());
  });

  it('lists zones with the ones asked for first', () => {
    const list = timeZoneList(['Mars/Olympus']);
    expect(list[0]).toBe('Mars/Olympus');
    expect(list).toContain('UTC');
    expect(list).toContain('Africa/Lagos');
    expect(timeZoneLabel('Africa/Dar_es_Salaam')).toBe('Africa / Dar es Salaam');
  });
});

describe('opening hours', () => {
  it('reads common ways of writing hours', () => {
    expect(openingRanges({ mon: '9:00-22:00' }, 1)).toEqual([[540, 1320]]);
    expect(openingRanges({ Saturday: '12:00–15:00, 18:00–23:30' }, 6)).toEqual([
      [720, 900],
      [1080, 1410],
    ]);
    expect(openingRanges({ fri: '6pm - 1am' }, 5)).toEqual([[1080, 1500]]);
    expect(openingRanges({ sun: 'Closed' }, 0)).toEqual([]);
    expect(openingRanges({ sun: 'ask us' }, 0)).toBeNull();
    expect(openingRanges({}, 2)).toBeNull();
    expect(openingRanges(null, 2)).toBeNull();
  });

  it('reads keys for several days, the most specific winning', () => {
    const hours = { mon: 'closed', 'tue-sun': '12:00-22:00', sat: '10:00-23:00' };
    expect(openingRanges(hours, 1)).toEqual([]);
    expect(openingRanges(hours, 3)).toEqual([[720, 1320]]);
    expect(openingRanges(hours, 0)).toEqual([[720, 1320]]);
    expect(openingRanges(hours, 6)).toEqual([[600, 1380]]);
    expect(hoursKeyDays('fri-mon')).toEqual([5, 6, 0, 1]);
    expect(hoursKeyDays('sat, sun')).toEqual([6, 0]);
    expect(hoursKeyDays('Monday')).toEqual([1]);
    expect(hoursKeyDays('holidays')).toBeNull();
  });

  it("names the days in the reader's language", () => {
    expect(hoursKeyLabel('tue-sun', 'en')).toBe('Tue – Sun');
    expect(hoursKeyLabel('mon', 'fr')).toBe('lun.');
    expect(hoursKeyLabel('sat, sun', 'en')).toBe('Sat, Sun');
    expect(hoursKeyLabel('holidays', 'en')).toBe('holidays');
    // Stored hours come back in any order; they're shown Monday first.
    expect(hoursInWeekOrder({ fri: 'a', mon: 'b', holidays: 'c', 'sat-sun': 'd', tue: 'e' }).map(([k]) => k)).toEqual([
      'mon',
      'tue',
      'fri',
      'sat-sun',
      'holidays',
    ]);
  });
});

describe('booking slots', () => {
  const monday = new Date(2026, 9, 5); // a Monday
  const before = new Date(2026, 9, 1, 12, 0);

  it('offers half hours while open, the last an hour before closing', () => {
    const slots = bookingSlots(monday, { mon: '18:00-21:00' }, before).map(hm);
    expect(slots).toEqual(['18:00', '18:30', '19:00', '19:30', '20:00']);
  });

  it('uses the usual hours when the place gives none, and nothing on a closed day', () => {
    const slots = bookingSlots(monday, null, before).map(hm);
    expect(slots[0]).toBe('08:00');
    expect(slots.at(-1)).toBe('21:00');
    expect(bookingSlots(monday, { mon: 'closed' }, before)).toEqual([]);
  });

  it('leaves out times that have passed, and those after midnight', () => {
    const now = new Date(2026, 9, 5, 19, 10);
    expect(bookingSlots(monday, { mon: '18:00-02:00' }, now).map(hm)).toEqual([
      '19:30',
      '20:00',
      '20:30',
      '21:00',
      '21:30',
      '22:00',
      '22:30',
      '23:00',
      '23:30',
    ]);
  });
});
