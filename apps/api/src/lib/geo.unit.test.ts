import { describe, expect, it } from 'vitest';
import { boundsSql, geoBounds, haversineKm } from './geo.js';
import { hoursSchema, isOpenNow, isWithinHours, isValidTimezone, localParts } from './hours.js';

describe('geo', () => {
  it('computes known distances', () => {
    expect(haversineKm(0, 0, 0, 0)).toBe(0);
    // London -> Paris is about 344 km
    expect(haversineKm(51.5074, -0.1278, 48.8566, 2.3522)).toBeGreaterThan(340);
    expect(haversineKm(51.5074, -0.1278, 48.8566, 2.3522)).toBeLessThan(348);
    // one degree of latitude is about 111.2 km
    expect(haversineKm(10, 20, 11, 20)).toBeCloseTo(111.19, 1);
  });

  it('bounding boxes contain every point inside the radius, including near the antimeridian and poles', () => {
    const b = geoBounds(10, 179.9, 50);
    expect(b.lngRanges).toHaveLength(2);
    expect(b.lngRanges![0]![1]).toBe(180);
    expect(b.lngRanges![1]![0]).toBe(-180);
    expect(geoBounds(89.9, 10, 100).lngRanges).toBeNull();
    const plain = geoBounds(48.85, 2.35, 10);
    expect(plain.lngRanges).toHaveLength(1);
    expect(plain.latMin).toBeLessThan(48.85);
    // a point exactly 10km east must fall inside the lng range
    const east = 2.35 + 10 / (111.195 * Math.cos((48.85 * Math.PI) / 180));
    expect(east).toBeLessThanOrEqual(plain.lngRanges![0]![1] + 1e-6);
  });

  it('builds parameterised bounds SQL', () => {
    const params: unknown[] = ['x'];
    const sql = boundsSql('lat', 'lng', geoBounds(10, 179.9, 50), params);
    expect(sql).toContain('lat BETWEEN $2 AND $3');
    expect(sql).toContain('OR');
    expect(params).toHaveLength(1 + 2 + 4);
  });
});

describe('opening hours', () => {
  const week = {
    mon: [['09:00', '17:00']],
    tue: [
      ['09:00', '12:00'],
      ['13:00', '17:00'],
    ],
    fri: [['18:00', '02:00']],
  } as const;

  it('validates structure', () => {
    expect(hoursSchema.safeParse(week).success).toBe(true);
    expect(hoursSchema.safeParse({}).success).toBe(true);
    expect(hoursSchema.safeParse({ mon: [['9:00', '17:00']] }).success).toBe(false);
    expect(hoursSchema.safeParse({ mon: [['09:00', '09:00']] }).success).toBe(false);
    expect(
      hoursSchema.safeParse({
        mon: [
          ['09:00', '12:00'],
          ['11:00', '14:00'],
        ],
      }).success,
    ).toBe(false);
    expect(hoursSchema.safeParse({ monday: [['09:00', '12:00']] }).success).toBe(false);
    expect(hoursSchema.safeParse({ mon: [['24:00', '12:00']] }).success).toBe(false);
    expect(hoursSchema.safeParse({ mon: [['00:00', '24:00']] }).success).toBe(true);
    expect(hoursSchema.safeParse({ mon: [['09:00', '25:00']] }).success).toBe(false);
  });

  it('computes open-now in the place timezone, not the server timezone', () => {
    // 2026-09-21 is a Monday. 15:00Z = 11:00 in New York (EDT), 17:00 in Berlin (CEST), 00:00 Tuesday in Tokyo.
    const at = new Date('2026-09-21T15:00:00Z');
    expect(localParts(at, 'America/New_York')).toEqual({ dayIndex: 0, minutes: 11 * 60 });
    expect(isOpenNow(week, 'America/New_York', at)).toBe(true);
    expect(isOpenNow(week, 'Europe/Berlin', at)).toBe(false); // 17:00 is the closing time (exclusive)
    expect(isOpenNow(week, 'Asia/Tokyo', at)).toBe(false);
    expect(isOpenNow({}, 'UTC', at)).toBeNull();
  });

  it('handles split days and overnight ranges', () => {
    expect(isOpenNow(week, 'UTC', new Date('2026-09-22T12:30:00Z'))).toBe(false); // Tue lunch break
    expect(isOpenNow(week, 'UTC', new Date('2026-09-22T13:00:00Z'))).toBe(true);
    // Friday 18:00 -> Saturday 02:00
    expect(isOpenNow(week, 'UTC', new Date('2026-09-25T23:00:00Z'))).toBe(true);
    expect(isOpenNow(week, 'UTC', new Date('2026-09-26T01:30:00Z'))).toBe(true);
    expect(isOpenNow(week, 'UTC', new Date('2026-09-26T02:00:00Z'))).toBe(false);
    // Sunday overnight wraps into Monday when configured
    expect(isOpenNow({ sun: [['22:00', '03:00']] }, 'UTC', new Date('2026-09-21T01:00:00Z'))).toBe(
      true,
    );
  });

  it('checks whole intervals against hours', () => {
    const at = (s: string) => new Date(s);
    expect(isWithinHours(week, 'UTC', at('2026-09-21T09:00:00Z'), 60)).toBe(true);
    expect(isWithinHours(week, 'UTC', at('2026-09-21T16:30:00Z'), 60)).toBe(false);
    expect(isWithinHours(week, 'UTC', at('2026-09-21T16:00:00Z'), 60)).toBe(true);
    expect(isWithinHours(week, 'UTC', at('2026-09-22T11:30:00Z'), 60)).toBe(false); // crosses lunch break
    expect(isWithinHours(week, 'UTC', at('2026-09-23T10:00:00Z'), 30)).toBe(false); // wednesday closed
    expect(isWithinHours({}, 'UTC', at('2026-09-21T10:00:00Z'), 30)).toBe(false);
  });

  it('validates timezones', () => {
    expect(isValidTimezone('Europe/Paris')).toBe(true);
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
  });
});
