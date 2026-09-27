import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addDays,
  addMinutes,
  addMonths,
  calendarDaysBetween,
  ceilToStep,
  clampToRange,
  dayDisabled,
  dayPeriodNames,
  formatClock,
  from12Hour,
  monthDisabled,
  monthGrid,
  monthTitle,
  quickChoices,
  summaryParts,
  to12Hour,
  uses12Hour,
  weekdayNames,
  weekStartFor,
  withDay,
  withTime,
  yearsInRange,
} from './date-picker.ts';

// Paris changes its clocks on the last Sundays of March (02:00 → 03:00) and October (03:00 → 02:00),
// which makes the daylight saving cases below real. Node reads TZ again when it changes.
const previousTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'Europe/Paris';
});
afterAll(() => {
  process.env.TZ = previousTz;
});

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);
const hm = (d: Date) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;

describe('month grid', () => {
  it('starts on the chosen weekday and keeps six full weeks', () => {
    // October 2026 starts on a Thursday.
    const monday = monthGrid(2026, 9, 1);
    expect(monday).toHaveLength(6);
    expect(monday.every((w) => w.length === 7)).toBe(true);
    expect(monday[0]![0]).toMatchObject({ year: 2026, month: 8, day: 28, inMonth: false });
    expect(monday[0]![3]).toMatchObject({ year: 2026, month: 9, day: 1, inMonth: true, key: '2026-10-01' });

    const sunday = monthGrid(2026, 9, 0);
    expect(sunday[0]![0]!.key).toBe('2026-09-27');
    expect(sunday[0]![4]!.key).toBe('2026-10-01');

    const saturday = monthGrid(2026, 9, 6);
    expect(saturday[0]![0]!.key).toBe('2026-09-26');
    expect(saturday[0]![5]!.key).toBe('2026-10-01');
  });

  it('holds every day of the month exactly once, in order', () => {
    for (const [y, m, len] of [
      [2026, 1, 28],
      [2028, 1, 29],
      [2026, 11, 31],
      [2026, 2, 31], // March, with the spring clock change
    ] as const) {
      const days = monthGrid(y, m, 1)
        .flat()
        .filter((c) => c.inMonth)
        .map((c) => c.day);
      expect(days).toEqual(Array.from({ length: len }, (_, i) => i + 1));
    }
  });

  it('rolls over the year at both ends and can be trimmed to the weeks needed', () => {
    const jan = monthGrid(2027, 0, 1);
    expect(jan[0]![0]!.key).toBe('2026-12-28');
    const dec = monthGrid(2026, 11, 1);
    expect(dec[5]![6]!.key).toBe('2027-01-10');
    // February 2027 starts on a Monday and has exactly four weeks.
    expect(monthGrid(2027, 1, 1, false)).toHaveLength(4);
  });

  it('moves between months across years', () => {
    expect(addMonths(2026, 11, 1)).toEqual({ year: 2027, month: 0 });
    expect(addMonths(2026, 0, -1)).toEqual({ year: 2025, month: 11 });
    expect(addMonths(2026, 5, -18)).toEqual({ year: 2024, month: 11 });
  });
});

describe('daylight saving', () => {
  it('adds days on the wall clock, not in 24-hour blocks', () => {
    // 28 March 2026 09:00 + 1 day crosses the spring change: still 09:00.
    const spring = addDays(at(2026, 3, 28, 9), 1);
    expect(spring.getDate()).toBe(29);
    expect(hm(spring)).toBe('9:00');
    expect(spring.getTime() - at(2026, 3, 28, 9).getTime()).toBe(23 * 3_600_000);

    const autumn = addDays(at(2026, 10, 24, 20, 30), 1);
    expect(hm(autumn)).toBe('20:30');
    expect(autumn.getTime() - at(2026, 10, 24, 20, 30).getTime()).toBe(25 * 3_600_000);

    expect(addDays(at(2026, 3, 1, 12), 31).getDate()).toBe(1);
    expect(addDays(at(2026, 3, 1, 12), -1).getDate()).toBe(28);
  });

  it('counts calendar days whatever the length of the day', () => {
    expect(calendarDaysBetween(at(2026, 3, 28, 23, 30), at(2026, 3, 29, 0, 30))).toBe(1);
    expect(calendarDaysBetween(at(2026, 3, 28, 1), at(2026, 3, 30, 23))).toBe(2);
    expect(calendarDaysBetween(at(2026, 10, 25, 23), at(2026, 10, 25, 0))).toBe(0);
    expect(calendarDaysBetween(at(2026, 12, 31), at(2027, 1, 1))).toBe(1);
  });

  it('never gets stuck stepping minutes across the spring gap', () => {
    // 02:00–03:00 doesn't exist on 29 March 2026.
    const before = at(2026, 3, 29, 1, 30);
    const up = addMinutes(before, 60);
    expect(up.getTime()).toBeGreaterThan(before.getTime());
    const down = addMinutes(at(2026, 3, 29, 3, 30), -60);
    expect(down.getTime()).toBeLessThan(at(2026, 3, 29, 3, 30).getTime());
    expect(addMinutes(at(2026, 10, 6, 23, 55), 5)).toEqual(at(2026, 10, 7, 0, 0));
    expect(addMinutes(at(2026, 10, 6, 0, 0), -5)).toEqual(at(2026, 10, 5, 23, 55));
  });
});

describe('limits', () => {
  // Computed in beforeAll (not as a describe-body const) so they pick up the Europe/Paris TZ the
  // outer beforeAll sets: describe bodies run during collection, before any beforeAll has run, so
  // a plain const here would be built under the runner's default TZ instead.
  let min: Date;
  let max: Date;
  beforeAll(() => {
    min = at(2026, 10, 6, 14, 37);
    max = at(2026, 12, 5, 14, 37);
  });

  it('rounds to the five-minute grid inside the limits', () => {
    expect(ceilToStep(at(2026, 10, 6, 14, 37))).toEqual(at(2026, 10, 6, 14, 40));
    expect(ceilToStep(at(2026, 10, 6, 14, 40))).toEqual(at(2026, 10, 6, 14, 40));
    expect(ceilToStep(new Date(2026, 9, 6, 14, 40, 1))).toEqual(at(2026, 10, 6, 14, 45));
    expect(ceilToStep(at(2026, 10, 6, 23, 58))).toEqual(at(2026, 10, 7, 0, 0));

    expect(clampToRange(at(2026, 10, 6, 9), { min, max })).toEqual(at(2026, 10, 6, 14, 40));
    expect(clampToRange(at(2027, 1, 1), { min, max })).toEqual(at(2026, 12, 5, 14, 35));
    expect(clampToRange(at(2026, 11, 1, 10, 10), { min, max })).toEqual(at(2026, 11, 1, 10, 10));
    expect(clampToRange(at(2020, 1, 1), {})).toEqual(at(2020, 1, 1));
    // A window narrower than a step: the minimum itself.
    const tight = { min: at(2026, 10, 6, 14, 41), max: at(2026, 10, 6, 14, 43) };
    expect(clampToRange(at(2026, 10, 6), tight)).toEqual(tight.min);
  });

  it('disables days entirely outside the limits', () => {
    const limits = { min, max };
    expect(dayDisabled(2026, 9, 5, limits)).toBe(true);
    expect(dayDisabled(2026, 9, 6, limits)).toBe(false); // the rest of today still counts
    expect(dayDisabled(2026, 11, 5, limits)).toBe(false);
    expect(dayDisabled(2026, 11, 6, limits)).toBe(true);
    // In date mode the day's midnight has to be inside.
    expect(dayDisabled(2026, 9, 6, limits, 'date')).toBe(true);
    expect(dayDisabled(2026, 9, 7, limits, 'date')).toBe(false);
    expect(dayDisabled(1999, 0, 1, {})).toBe(false);
  });

  it('disables whole months outside the limits', () => {
    expect(monthDisabled(2026, 8, { min, max })).toBe(true);
    expect(monthDisabled(2026, 9, { min, max })).toBe(false);
    expect(monthDisabled(2026, 11, { min, max })).toBe(false);
    expect(monthDisabled(2027, 0, { min, max })).toBe(true);
  });

  it('keeps the time when the day changes, and the day when the time changes', () => {
    const value = at(2026, 10, 10, 9, 15);
    expect(withDay(value, 2026, 10, 20, { min, max })).toEqual(at(2026, 11, 20, 9, 15));
    // Today, 09:15 has passed: the first time still possible.
    expect(withDay(value, 2026, 9, 6, { min, max })).toEqual(at(2026, 10, 6, 14, 40));
    expect(withTime(value, 21, 5, { min, max })).toEqual(at(2026, 10, 10, 21, 5));
    expect(withTime(at(2026, 12, 5, 9), 22, 0, { min, max })).toEqual(at(2026, 12, 5, 14, 35));
  });

  it('lists the years a jump can go to', () => {
    expect(yearsInRange({ min: at(2026, 9, 27), max: at(2051, 9, 27) }, at(2026, 9, 27))).toHaveLength(26);
    expect(yearsInRange({}, at(2026, 1, 1), 1)).toEqual([2025, 2026, 2027]);
  });
});

describe('quick choices and summaries', () => {
  it('offers in an hour, tonight and tomorrow morning', () => {
    const q = quickChoices(at(2026, 10, 6, 14, 37));
    expect(q.map((x) => x.id)).toEqual(['hour', 'tonight', 'morning']);
    expect(q[0]!.at).toEqual(at(2026, 10, 6, 15, 40));
    expect(q[1]!.at).toEqual(at(2026, 10, 6, 20, 0));
    expect(q[2]!.at).toEqual(at(2026, 10, 7, 9, 0));
    // Tomorrow morning on the night before the autumn change is still 09:00.
    expect(hm(quickChoices(at(2026, 10, 24, 22))[2]!.at)).toBe('9:00');
  });

  it('says today, tomorrow or a date', () => {
    const now = at(2026, 12, 30, 23, 50);
    expect(summaryParts(at(2026, 12, 30, 23, 55), now)).toEqual({ day: 'today', withYear: false });
    expect(summaryParts(at(2026, 12, 31, 0, 5), now)).toEqual({ day: 'tomorrow', withYear: false });
    expect(summaryParts(at(2027, 1, 1, 9), now)).toEqual({ day: 'date', withYear: true });
  });
});

describe('locale', () => {
  it('detects 12 and 24 hour clocks', () => {
    expect(uses12Hour('en-US')).toBe(true);
    expect(uses12Hour('en-GB')).toBe(false);
    expect(uses12Hour('fr')).toBe(false);
    expect(uses12Hour('pt-BR')).toBe(false);
    expect(uses12Hour('es')).toBe(false);
  });

  it('falls back when Intl is missing or incomplete', () => {
    expect(uses12Hour('en', undefined)).toBe(true);
    expect(uses12Hour('en-GB', undefined)).toBe(false);
    expect(uses12Hour('fr-FR', undefined)).toBe(false);
    expect(uses12Hour('ar', undefined)).toBe(true);
    expect(uses12Hour('sw', undefined)).toBe(false);
    const throwing = {
      DateTimeFormat: function () {
        throw new Error('no ICU');
      } as unknown as typeof Intl.DateTimeFormat,
    };
    expect(uses12Hour('en-US', throwing)).toBe(true);
    expect(monthTitle('fr', 2026, 9, throwing)).toBe('October 2026');
    expect(weekdayNames('fr', 1, 'short', throwing)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    expect(formatClock('en', at(2026, 1, 1, 21, 5), true, throwing)).toBe('9:05 PM');
    expect(formatClock('fr', at(2026, 1, 1, 9, 5), false, throwing)).toBe('09:05');
    // Only resolvedOptions without hourCycle or hour12: formatToParts decides.
    const partsOnly = {
      DateTimeFormat: function () {
        return {
          resolvedOptions: () => ({}),
          formatToParts: () => [
            { type: 'hour', value: '1' },
            { type: 'dayPeriod', value: 'PM' },
          ],
        };
      } as unknown as typeof Intl.DateTimeFormat,
    };
    expect(uses12Hour('xx', partsOnly)).toBe(true);
  });

  it('converts between 12 and 24 hour clocks', () => {
    expect(to12Hour(0)).toEqual({ hour: 12, pm: false });
    expect(to12Hour(12)).toEqual({ hour: 12, pm: true });
    expect(to12Hour(23)).toEqual({ hour: 11, pm: true });
    for (let h = 0; h < 24; h++) {
      const { hour, pm } = to12Hour(h);
      expect(from12Hour(hour, pm)).toBe(h);
    }
  });

  it('finds the first day of the week', () => {
    expect(weekStartFor('en-US')).toBe(0);
    expect(weekStartFor('en-GB')).toBe(1);
    expect(weekStartFor('fr')).toBe(1);
    expect(weekStartFor('ar-EG')).toBe(6);
    // Without Intl.Locale, as on Hermes.
    expect(weekStartFor('en', {})).toBe(0);
    expect(weekStartFor('en-NG', {})).toBe(1);
    expect(weekStartFor('ar', {})).toBe(6);
    expect(weekStartFor('pt', {})).toBe(0);
    expect(weekStartFor('pt-PT', {})).toBe(0);
    expect(weekStartFor('yo', {})).toBe(1);
    expect(weekStartFor('ha', {})).toBe(1);
    expect(weekStartFor('sw', {})).toBe(1);
  });

  it('names months, weekdays and day periods in the language', () => {
    expect(monthTitle('en', 2026, 9)).toBe('October 2026');
    expect(monthTitle('fr', 2026, 9)).toBe('octobre 2026');
    expect(weekdayNames('en', 0, 'short')).toEqual(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
    expect(weekdayNames('en', 1, 'long')[0]).toBe('Monday');
    expect(weekdayNames('fr', 1, 'long')[6]).toBe('dimanche');
    expect(dayPeriodNames('en')).toEqual({ am: 'AM', pm: 'PM' });
    expect(formatClock('en-GB', at(2026, 1, 1, 20, 0), false)).toBe('20:00');
    expect(formatClock('en-US', at(2026, 1, 1, 20, 0), true)).toMatch(/^8:00\sPM$/);
  });
});
