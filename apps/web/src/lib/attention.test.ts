import { describe, expect, it } from 'vitest';
import { inQuietHours, minutesOfDay, minutesToTime, timeToMinutes } from './attention';

describe('quiet hours', () => {
  it('handles ranges inside a day', () => {
    expect(inQuietHours(13 * 60, 12 * 60, 14 * 60)).toBe(true);
    expect(inQuietHours(14 * 60, 12 * 60, 14 * 60)).toBe(false); // end is exclusive
    expect(inQuietHours(11 * 60, 12 * 60, 14 * 60)).toBe(false);
  });
  it('handles ranges that wrap past midnight', () => {
    expect(inQuietHours(23 * 60, 22 * 60, 7 * 60)).toBe(true);
    expect(inQuietHours(3 * 60, 22 * 60, 7 * 60)).toBe(true);
    expect(inQuietHours(12 * 60, 22 * 60, 7 * 60)).toBe(false);
  });
  it('is off when unset or empty', () => {
    expect(inQuietHours(60, null, 120)).toBe(false);
    expect(inQuietHours(60, 120, null)).toBe(false);
    expect(inQuietHours(60, 100, 100)).toBe(false);
  });
});

describe('time conversion', () => {
  it('round-trips HH:MM', () => {
    expect(minutesToTime(0)).toBe('00:00');
    expect(minutesToTime(22 * 60 + 5)).toBe('22:05');
    expect(timeToMinutes('07:30')).toBe(450);
    expect(timeToMinutes('7:30')).toBe(450);
  });
  it('rejects invalid times', () => {
    for (const bad of ['', '24:00', '12:60', 'noon', '1230'])
      expect(timeToMinutes(bad), bad).toBeNull();
  });
  it('reads the local minute of day in a time zone', () => {
    const at = new Date('2026-09-20T22:30:00Z');
    expect(minutesOfDay('UTC', at)).toBe(22 * 60 + 30);
    expect(minutesOfDay('Africa/Lagos', at)).toBe(23 * 60 + 30); // UTC+1
    expect(minutesOfDay('Not/AZone', at)).toBe(22 * 60 + 30); // falls back to UTC
  });
});
