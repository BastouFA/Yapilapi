import { z } from 'zod';

/**
 * Opening hours: `{ mon: [["09:00","17:00"]], tue: [...], ... }`. Missing/empty day = closed. A range whose close is earlier than its
 * open runs past midnight into the next day ("18:00"-"02:00"); "24:00" as a close means end of day. Times are local to the place's IANA timezone.
 */
export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Day = (typeof DAYS)[number];
export type Hours = Partial<Record<Day, Array<[string, string]>>>;

const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

export const hoursSchema = z
  .object(
    Object.fromEntries(
      DAYS.map((d) => [
        d,
        z
          .array(z.tuple([z.string().regex(TIME_RE), z.string().regex(TIME_RE)]))
          .max(4)
          .optional(),
      ]),
    ) as Record<Day, z.ZodOptional<z.ZodArray<z.ZodTuple<[z.ZodString, z.ZodString]>>>>,
  )
  .strict()
  .superRefine((h, ctx) => {
    for (const d of DAYS) {
      const ranges = h[d] ?? [];
      const segs: Array<[number, number]> = [];
      for (const [i, [o, c]] of ranges.entries()) {
        if (o === '24:00') {
          ctx.addIssue({ code: 'custom', message: 'A range cannot open at 24:00', path: [d, i] });
          continue;
        }
        const om = toMin(o);
        const cm = toMin(c);
        if (om === cm) {
          ctx.addIssue({
            code: 'custom',
            message: 'A range cannot open and close at the same time',
            path: [d, i],
          });
          continue;
        }
        if (cm < om) {
          segs.push([om, 1440]);
          segs.push([0, cm]);
        } else segs.push([om, cm]);
      }
      segs.sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < segs.length; i++) {
        if (segs[i]![0] < segs[i - 1]![1]) {
          ctx.addIssue({ code: 'custom', message: 'Opening ranges overlap', path: [d] });
          break;
        }
      }
    }
  });

export function isValidTimezone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
export const timezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(isValidTimezone, 'Unknown IANA timezone');

export const hasHours = (h: unknown): h is Hours =>
  Boolean(
    h &&
    typeof h === 'object' &&
    DAYS.some((d) => Array.isArray((h as Hours)[d]) && (h as Hours)[d]!.length > 0),
  );

interface LocalParts {
  dayIndex: number;
  minutes: number;
}
const WEEKDAY: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
const fmtCache = new Map<string, Intl.DateTimeFormat>();

/** Local weekday (Mon=0) and minute-of-day at `at` in `tz`. */
export function localParts(at: Date, tz: string): LocalParts {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    fmtCache.set(tz, f);
  }
  const parts = f.formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return {
    dayIndex: WEEKDAY[get('weekday')]!,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

const WEEK = 7 * 1440;

/** Open intervals in minutes since local Monday 00:00 (an overnight range may extend past the end of the week; callers wrap). */
function intervals(hours: Hours): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  DAYS.forEach((d, i) => {
    for (const [o, c] of hours[d] ?? []) {
      const om = toMin(o);
      const cm = toMin(c);
      out.push([i * 1440 + om, i * 1440 + (cm <= om ? cm + 1440 : cm)]);
    }
  });
  return out;
}

/** True if the interval [start, start + durationMin) lies entirely inside opening hours. */
export function isWithinHours(
  hours: unknown,
  tz: string,
  start: Date,
  durationMin: number,
): boolean {
  if (!hasHours(hours)) return false;
  const { dayIndex, minutes } = localParts(start, tz);
  const m0 = dayIndex * 1440 + minutes;
  const m1 = m0 + durationMin;
  for (const [a, b] of intervals(hours)) {
    for (const shift of [0, -WEEK]) {
      if (a + shift <= m0 && m1 <= b + shift) return true;
    }
  }
  return false;
}

/** `null` when no hours are published (unknown), otherwise whether the place is open at `at` in its own timezone. */
export function isOpenNow(hours: unknown, tz: string, at: Date = new Date()): boolean | null {
  if (!hasHours(hours)) return null;
  return isWithinHoursAt(hours, tz, at);
}

/** Point-in-time test: open if `at` falls in [open, close). */
function isWithinHoursAt(hours: Hours, tz: string, at: Date): boolean {
  const { dayIndex, minutes } = localParts(at, tz);
  const m = dayIndex * 1440 + minutes;
  for (const [a, b] of intervals(hours)) {
    for (const shift of [0, -WEEK]) {
      if (a + shift <= m && m < b + shift) return true;
    }
  }
  return false;
}
