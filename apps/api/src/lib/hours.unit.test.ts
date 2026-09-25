import { describe, expect, it } from 'vitest';
import { hoursSchema, isOpenNow, isValidTimezone, isWithinHours, localParts } from './hours.js';

const weekdays = {
  mon: [['09:00', '17:00']],
  tue: [['09:00', '17:00']],
  wed: [['09:00', '17:00']],
  thu: [['09:00', '17:00']],
  fri: [['09:00', '17:00']],
} as const;

describe('hours validation', () => {
  it('accepts well-formed hours and rejects malformed ones', () => {
    expect(hoursSchema.safeParse(weekdays).success).toBe(true);
    expect(hoursSchema.safeParse({}).success).toBe(true);
    expect(hoursSchema.safeParse({ mon: [['9:00', '17:00']] }).success).toBe(false); // not zero padded
    expect(hoursSchema.safeParse({ mon: [['09:00', '25:00']] }).success).toBe(false);
    expect(hoursSchema.safeParse({ funday: [['09:00', '17:00']] }).success).toBe(false); // unknown key
    expect(hoursSchema.safeParse({ mon: [['09:00', '09:00']] }).success).toBe(false); // zero length
    expect(hoursSchema.safeParse({ mon: [['24:00', '02:00']] }).success).toBe(false);
    expect(
      hoursSchema.safeParse({
        mon: [
          ['09:00', '12:00'],
          ['11:00', '14:00'],
        ],
      }).success,
    ).toBe(false); // overlap
    expect(
      hoursSchema.safeParse({
        mon: [
          ['09:00', '12:00'],
          ['13:00', '17:00'],
        ],
      }).success,
    ).toBe(true); // lunch break
    expect(hoursSchema.safeParse({ mon: [['18:00', '02:00']] }).success).toBe(true); // overnight
    expect(hoursSchema.safeParse({ mon: [['00:00', '24:00']] }).success).toBe(true);
  });

  it('validates IANA timezones', () => {
    expect(isValidTimezone('Europe/Paris')).toBe(true);
    expect(isValidTimezone('Asia/Tokyo')).toBe(true);
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
  });
});

describe('isOpenNow', () => {
  // 2026-09-21 is a Monday.
  it('evaluates in the place timezone, not the server timezone', () => {
    const at = new Date('2026-09-21T02:00:00Z'); // Mon 02:00 UTC = Mon 11:00 Tokyo = Sun 22:00 New York
    expect(localParts(at, 'Asia/Tokyo')).toEqual({ dayIndex: 0, minutes: 11 * 60 });
    expect(isOpenNow(weekdays, 'Asia/Tokyo', at)).toBe(true);
    expect(isOpenNow(weekdays, 'UTC', at)).toBe(false);
    expect(isOpenNow(weekdays, 'America/New_York', at)).toBe(false); // Sunday evening: closed
  });

  it('treats open as inclusive and close as exclusive', () => {
    expect(isOpenNow(weekdays, 'UTC', new Date('2026-09-21T09:00:00Z'))).toBe(true);
    expect(isOpenNow(weekdays, 'UTC', new Date('2026-09-21T16:59:00Z'))).toBe(true);
    expect(isOpenNow(weekdays, 'UTC', new Date('2026-09-21T17:00:00Z'))).toBe(false);
    expect(isOpenNow(weekdays, 'UTC', new Date('2026-09-26T12:00:00Z'))).toBe(false); // Saturday
  });

  it('handles overnight ranges, including the week wrap-around', () => {
    const bar = { fri: [['18:00', '02:00']], sun: [['20:00', '03:00']] } as const;
    expect(isOpenNow(bar, 'UTC', new Date('2026-09-25T23:00:00Z'))).toBe(true); // Fri 23:00
    expect(isOpenNow(bar, 'UTC', new Date('2026-09-26T01:30:00Z'))).toBe(true); // Sat 01:30 (still Friday's session)
    expect(isOpenNow(bar, 'UTC', new Date('2026-09-26T02:00:00Z'))).toBe(false);
    expect(isOpenNow(bar, 'UTC', new Date('2026-09-21T01:00:00Z'))).toBe(true); // Mon 01:00 = Sunday's session wrapped over the week end
    expect(isOpenNow(bar, 'UTC', new Date('2026-09-21T03:00:00Z'))).toBe(false);
  });

  it('returns null (unknown) when no hours are published, and supports 24h days', () => {
    expect(isOpenNow({}, 'UTC')).toBeNull();
    expect(isOpenNow(null, 'UTC')).toBeNull();
    expect(isOpenNow({ mon: [] }, 'UTC')).toBeNull();
    expect(isOpenNow({ mon: [['00:00', '24:00']] }, 'UTC', new Date('2026-09-21T23:59:00Z'))).toBe(
      true,
    );
  });

  it('isWithinHours requires the whole interval to fit', () => {
    const start = new Date('2026-09-21T16:00:00Z');
    expect(isWithinHours(weekdays, 'UTC', start, 60)).toBe(true);
    expect(isWithinHours(weekdays, 'UTC', start, 90)).toBe(false);
    expect(isWithinHours({}, 'UTC', start, 30)).toBe(false);
  });
});
