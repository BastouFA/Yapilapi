import type { TimeWindow } from './types.js';

/**
 * Time-zone aware resolution of relative time phrases ("tonight", "this weekend", ...) to absolute windows.
 * Pure: everything is derived from `now` and an IANA zone. Uses only Intl (no dependencies).
 */

interface Parts {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  /** 0 = Sunday */
  dow: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** True when `tz` is a usable IANA zone name. */
export function isValidTimeZone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

function localParts(date: Date, tz: string): Parts & { s: number } {
  const p: Record<string, number> = {};
  for (const part of formatter(tz).formatToParts(date))
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  const dow = new Date(Date.UTC(p.year!, p.month! - 1, p.day!)).getUTCDay();
  return { y: p.year!, m: p.month!, d: p.day!, h: p.hour!, mi: p.minute!, s: p.second!, dow };
}

/** Offset (local minus UTC) in ms at the given instant. */
function offsetMs(date: Date, tz: string): number {
  const p = localParts(date, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(date.getTime() / 1000) * 1000;
}

/** The UTC instant at which the wall clock in `tz` reads y-m-d h:mi (day overflow is normalised by Date.UTC). */
export function zonedToUtc(
  y: number,
  m: number,
  d: number,
  h: number,
  mi: number,
  tz: string,
): Date {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const off1 = offsetMs(new Date(guess), tz);
  let t = guess - off1;
  const off2 = offsetMs(new Date(t), tz);
  if (off2 !== off1) t = guess - off2; // crossed a DST boundary
  return new Date(t);
}

export type TimeLabel = TimeWindow['label'];

export function resolveTimeWindow(label: TimeLabel, now: Date, tz = 'UTC'): TimeWindow {
  const zone = isValidTimeZone(tz) ? tz : 'UTC';
  const l = localParts(now, zone);
  const at = (dayOffset: number, h = 0, mi = 0) =>
    zonedToUtc(l.y, l.m, l.d + dayOffset, h, mi, zone);
  const later = (a: Date, b: Date) => (a.getTime() > b.getTime() ? a : b);

  switch (label) {
    case 'today':
      return { label, from: now, to: at(1) };
    case 'tonight': {
      // After midnight and before 5am "tonight" still means the night that is in progress.
      if (l.h < 5) return { label, from: now, to: at(0, 5) };
      return { label, from: later(now, at(0, 17)), to: at(1, 5) };
    }
    case 'tomorrow':
      return { label, from: at(1), to: at(2) };
    case 'this week': {
      const toMonday = l.dow === 1 ? 7 : (8 - l.dow) % 7;
      return { label, from: now, to: at(toMonday) };
    }
    case 'next week': {
      const toMonday = l.dow === 1 ? 7 : (8 - l.dow) % 7;
      return { label, from: at(toMonday), to: at(toMonday + 7) };
    }
    case 'this weekend':
    case 'next weekend': {
      // Weekend = Friday 18:00 to Monday 00:00 (local). On Saturday/Sunday "this weekend" is the one in progress.
      const friOffset = l.dow === 6 ? -1 : l.dow === 0 ? -2 : 5 - l.dow;
      const shift = label === 'next weekend' ? 7 : 0;
      const start = at(friOffset + shift, 18);
      const end = at(friOffset + shift + 3);
      return { label, from: later(now, start), to: end };
    }
  }
}
