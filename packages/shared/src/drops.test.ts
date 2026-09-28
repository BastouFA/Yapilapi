import { describe, expect, it } from 'vitest';
import { createDropSchema, updateDropSchema } from './drop-schemas.ts';
import { dropCountdown, dropDay, dropPhase, dropScheduleProblem } from './drops.ts';

const now = new Date('2026-10-01T12:00:00Z'); // a Thursday
const inMin = (m: number) => new Date(now.getTime() + m * 60_000).toISOString();

describe('drop schedule', () => {
  it('needs a start 5 minutes to 180 days ahead', () => {
    expect(dropScheduleProblem(inMin(10), null, now)).toBeNull();
    expect(dropScheduleProblem(inMin(1), null, now)).toEqual({ field: 'startsAt', problem: 'startTooSoon' });
    expect(dropScheduleProblem(inMin(-60), null, now)?.problem).toBe('startTooSoon');
    expect(dropScheduleProblem(inMin(181 * 24 * 60), null, now)?.problem).toBe('startTooLate');
    expect(dropScheduleProblem('not a date', null, now)?.problem).toBe('startInvalid');
  });

  it('needs an end 15 minutes to 30 days after the start', () => {
    expect(dropScheduleProblem(inMin(10), inMin(30), now)).toBeNull();
    expect(dropScheduleProblem(inMin(10), inMin(20), now)).toEqual({ field: 'endsAt', problem: 'endTooSoon' });
    expect(dropScheduleProblem(inMin(10), inMin(5), now)?.problem).toBe('endTooSoon');
    expect(dropScheduleProblem(inMin(10), inMin(10 + 31 * 24 * 60), now)?.problem).toBe('endTooLate');
  });

  it('checks the form', () => {
    const productId = '00000000-0000-4000-8000-000000000001';
    expect(createDropSchema.safeParse({ title: 'Autumn prints', startsAt: inMin(60), items: [{ productId }] }).success).toBe(true);
    expect(createDropSchema.safeParse({ title: ' ', startsAt: inMin(60), items: [{ productId }] }).success).toBe(false);
    expect(createDropSchema.safeParse({ title: 'x', startsAt: inMin(60), items: [] }).success).toBe(false);
    expect(createDropSchema.safeParse({ title: 'x', startsAt: inMin(60), items: [{ productId }, { productId }] }).success).toBe(false);
    expect(createDropSchema.safeParse({ title: 'x', startsAt: inMin(60), items: [{ productId, quantity: 0 }] }).success).toBe(false);
    expect(createDropSchema.safeParse({ title: 'x', startsAt: inMin(60), items: [{ productId, perBuyerLimit: 101 }] }).success).toBe(false);
    expect(updateDropSchema.safeParse({}).success).toBe(false);
    expect(updateDropSchema.safeParse({ endsAt: null }).success).toBe(true);
  });
});

describe('drop timing words', () => {
  it('says today, tomorrow, a weekday or a date', () => {
    const tz = 'UTC';
    expect(dropDay('2026-10-01T18:00:00Z', 'en-US', now, tz)).toEqual({ kind: 'today', day: '', time: '6:00 PM' });
    expect(dropDay('2026-10-02T18:00:00Z', 'en-US', now, tz).kind).toBe('tomorrow');
    expect(dropDay('2026-10-03T18:00:00Z', 'en-US', now, tz)).toEqual({ kind: 'weekday', day: 'Saturday', time: '6:00 PM' });
    expect(dropDay('2026-10-20T18:00:00Z', 'en-US', now, tz)).toMatchObject({ kind: 'date', day: 'Tue, Oct 20' });
    expect(dropDay('2027-01-05T18:00:00Z', 'en-US', now, tz).day).toContain('2027');
    // The day depends on where you are: 23:30 UTC is already tomorrow in Lagos.
    expect(dropDay('2026-10-01T23:30:00Z', 'en-GB', now, 'Africa/Lagos').kind).toBe('tomorrow');
  });

  it('counts down in whole days, hours or minutes, never seconds', () => {
    expect(dropCountdown(inMin(3 * 24 * 60 + 30), now)).toEqual({ value: 3, unit: 'day' });
    expect(dropCountdown(inMin(5 * 60 + 59), now)).toEqual({ value: 5, unit: 'hour' });
    expect(dropCountdown(inMin(42), now)).toEqual({ value: 42, unit: 'minute' });
    expect(dropCountdown(new Date(now.getTime() + 10_000), now)).toEqual({ value: 1, unit: 'minute' });
    expect(dropCountdown(inMin(-1), now)).toBeNull();
  });

  it('counts days by the calendar, so it agrees with the day it names', () => {
    const tz = 'UTC';
    // Thursday noon to Saturday 11:30 is 47.5 hours: "Saturday · in 2 days", not "in 1 day".
    expect(dropCountdown('2026-10-03T11:30:00Z', now, tz)).toEqual({ value: 2, unit: 'day' });
    expect(dropDay('2026-10-03T11:30:00Z', 'en-US', now, tz).day).toBe('Saturday');
    // Friday 23:00 is 35 hours away: tomorrow, in 1 day.
    expect(dropCountdown('2026-10-02T23:00:00Z', now, tz)).toEqual({ value: 1, unit: 'day' });
    // Under a day it still counts hours.
    expect(dropCountdown('2026-10-02T09:00:00Z', now, tz)).toEqual({ value: 21, unit: 'hour' });
  });

  it('knows a drop that is about to open', () => {
    expect(dropPhase({ status: 'scheduled', startsAt: inMin(10) }, now)).toBe('upcoming');
    expect(dropPhase({ status: 'scheduled', startsAt: inMin(-1) }, now)).toBe('opening');
    expect(dropPhase({ status: 'open', startsAt: inMin(-1) }, now)).toBe('open');
  });
});
