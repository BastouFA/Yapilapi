// Time zones for events and time slots for bookings, shared by the phone app's event and place
// screens. Pure functions: "wall" dates are Dates whose local fields (getFullYear … getMinutes)
// hold a clock time, the way the phone's date picker hands them over.

/** Time zones offered when the phone can't list them all (Intl.supportedValuesOf). */
export const COMMON_TIME_ZONES = [
  'UTC',
  'Africa/Abidjan',
  'Africa/Accra',
  'Africa/Addis_Ababa',
  'Africa/Algiers',
  'Africa/Cairo',
  'Africa/Casablanca',
  'Africa/Dakar',
  'Africa/Dar_es_Salaam',
  'Africa/Douala',
  'Africa/Johannesburg',
  'Africa/Kampala',
  'Africa/Kigali',
  'Africa/Kinshasa',
  'Africa/Lagos',
  'Africa/Nairobi',
  'Africa/Tunis',
  'America/Chicago',
  'America/Los_Angeles',
  'America/Mexico_City',
  'America/New_York',
  'America/Sao_Paulo',
  'America/Toronto',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Riyadh',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Europe/Berlin',
  'Europe/Istanbul',
  'Europe/Lisbon',
  'Europe/London',
  'Europe/Madrid',
  'Europe/Paris',
] as const;

/** Every time zone the engine knows, or the common ones; the given zones first when missing. */
export function timeZoneList(extra: (string | null | undefined)[] = []): string[] {
  let all: string[] = [];
  try {
    const f = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    all = f ? f('timeZone') : [];
  } catch {
    all = [];
  }
  if (!all.length) all = [...COMMON_TIME_ZONES];
  if (!all.includes('UTC')) all = ['UTC', ...all];
  const missing = extra.filter((z): z is string => !!z && !all.includes(z));
  return [...new Set([...missing, ...all])];
}

/** True when the engine accepts this zone name. */
export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** A zone name for people: "Africa/Dar_es_Salaam" → "Africa / Dar es Salaam". */
export const timeZoneLabel = (tz: string) => tz.replace(/_/g, ' ').replace(/\//g, ' / ');

function zonedParts(instant: number, tz: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour') % 24, mi: get('minute'), s: get('second') };
}

/** How far ahead of UTC the zone's clock is at that instant, in milliseconds. */
export function zoneOffsetMs(instant: number, tz: string): number {
  const p = zonedParts(instant, tz);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * The moment a clock in `tz` shows the wall time held in `wall`'s local fields. Across a daylight
 * saving jump the later offset wins, as calendars do. Falls back to the phone's own zone when the
 * zone is unknown.
 */
export function zonedWallToUtc(wall: Date, tz: string): Date {
  if (!isTimeZone(tz)) return new Date(wall.getTime());
  try {
    const guess = Date.UTC(wall.getFullYear(), wall.getMonth(), wall.getDate(), wall.getHours(), wall.getMinutes(), 0);
    const first = zoneOffsetMs(guess, tz);
    const second = zoneOffsetMs(guess - first, tz);
    return new Date(guess - second);
  } catch {
    // An engine without formatToParts: the phone's own zone.
    return new Date(wall.getTime());
  }
}

/** The reverse: a Date whose local fields show the time a clock in `tz` reads at `instant`. */
export function utcToZonedWall(instant: Date | string, tz: string): Date {
  const at = typeof instant === 'string' ? new Date(instant) : instant;
  if (!isTimeZone(tz)) return new Date(at.getTime());
  try {
    const p = zonedParts(at.getTime(), tz);
    return new Date(p.y, p.mo - 1, p.d, p.h, p.mi, 0, 0);
  } catch {
    return new Date(at.getTime());
  }
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

const weekdayOf = (word: string): number | null => {
  const i = WEEKDAYS.indexOf(word.trim().toLowerCase().slice(0, 3) as (typeof WEEKDAYS)[number]);
  return i < 0 ? null : i;
};

/**
 * The weekdays (0 is Sunday) an opening-hours key covers: "mon", "Monday", "tue-sun" (a range,
 * wrapping past Sunday as in "fri-mon"), or a list such as "sat, sun". Null when it names no day.
 */
export function hoursKeyDays(key: string): number[] | null {
  const days = new Set<number>();
  for (const part of key.split(/[,&/]|\band\b/)) {
    if (!part.trim()) continue;
    const [a, b, ...rest] = part.split(/\s*[-–—]\s*|\s+to\s+/);
    const from = weekdayOf(a ?? '');
    if (from === null || rest.length) return null;
    if (b === undefined) {
      days.add(from);
      continue;
    }
    const to = weekdayOf(b);
    if (to === null) return null;
    for (let d = from; ; d = (d + 1) % 7) {
      days.add(d);
      if (d === to) break;
    }
  }
  return days.size ? [...days] : null;
}

/** Opening hours as written, in week order (Monday first); lines that name no day come last. */
export function hoursInWeekOrder(hours: Record<string, unknown> | null | undefined): [string, string][] {
  const rank = (k: string) => {
    const days = hoursKeyDays(k);
    return days ? (days[0]! + 6) % 7 : 7;
  };
  return Object.entries(hours ?? {})
    .filter((e): e is [string, string] => typeof e[1] === 'string')
    .sort((a, b) => rank(a[0]) - rank(b[0]));
}

/**
 * An opening-hours key in the reader's language: "tue-sun" reads "Tue – Sun" in English, "mar. – dim."
 * in French. Keys that name no day are shown as they are.
 */
export function hoursKeyLabel(key: string, locale: string): string {
  const days = hoursKeyDays(key);
  if (!days) return key;
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
  } catch {
    return key;
  }
  // 2023-01-01 was a Sunday.
  const name = (d: number) => fmt.format(new Date(Date.UTC(2023, 0, 1 + d)));
  return key
    .split(/\s*,\s*/)
    .map((part) => {
      const ends = part.split(/\s*[-–—]\s*|\s+to\s+/).map(weekdayOf);
      return ends.every((d) => d !== null) ? ends.map((d) => name(d!)).join(' – ') : part;
    })
    .join(', ');
}
/** Opening hours when a place gives none it can be read from. */
export const DEFAULT_BOOKING_HOURS: [number, number][] = [[8 * 60, 22 * 60]];

/**
 * A place's opening ranges for one weekday, in minutes after midnight, read from its free-form
 * hours ({ mon: "9:00-22:00", sat: "12:00–15:00, 18:00–23:30", sun: "closed" }). An empty list
 * means closed; null means the hours say nothing that can be read for that day.
 */
export function openingRanges(hours: Record<string, unknown> | null | undefined, weekday: number): [number, number][] | null {
  if (!hours) return null;
  // A key names one day ("mon", "Monday") or several ("tue-sun", "sat, sun"); the most specific one wins.
  const matching = Object.entries(hours)
    .map(([k, v]) => ({ days: hoursKeyDays(k), v }))
    .filter((x) => x.days?.includes(weekday))
    .sort((a, b) => a.days!.length - b.days!.length);
  const entry = matching[0] ? ([null, matching[0].v] as const) : null;
  if (!entry || typeof entry[1] !== 'string') return null;
  const text = entry[1].toLowerCase();
  if (/closed|ferm|cerrado|fechado/.test(text)) return [];
  const out: [number, number][] = [];
  const re = /(\d{1,2})(?:[:h.](\d{2}))?\s*(am|pm)?\s*[-–—to]+\s*(\d{1,2})(?:[:h.](\d{2}))?\s*(am|pm)?/g;
  for (const m of text.matchAll(re)) {
    const toMin = (h: string, mi: string | undefined, ap: string | undefined) => {
      let hh = Number(h) % 24;
      if (ap === 'pm' && hh < 12) hh += 12;
      if (ap === 'am' && hh === 12) hh = 0;
      return hh * 60 + Number(mi ?? 0);
    };
    const open = toMin(m[1]!, m[2], m[3]);
    let close = toMin(m[4]!, m[5], m[6]);
    if (close <= open) close += 24 * 60;
    out.push([open, close]);
  }
  return out.length ? out : null;
}

/**
 * Times someone can ask to book on `day` (local wall time): every `step` minutes while the place is
 * open, the last one `lastBefore` minutes before it closes, none within `lead` minutes of `now`, and
 * none after midnight (those belong to the next day's hours).
 */
export function bookingSlots(
  day: Date,
  hours: Record<string, unknown> | null | undefined,
  now: Date,
  opts: { step?: number; lastBefore?: number; lead?: number } = {},
): Date[] {
  const step = opts.step ?? 30;
  const lastBefore = opts.lastBefore ?? 60;
  const lead = opts.lead ?? 15;
  const ranges = openingRanges(hours, day.getDay()) ?? DEFAULT_BOOKING_HOURS;
  const earliest = now.getTime() + lead * 60_000;
  const seen = new Set<number>();
  const out: Date[] = [];
  for (const [open, close] of ranges) {
    const last = Math.max(open, close - lastBefore);
    for (let m = Math.ceil(open / step) * step; m <= last && m < 24 * 60; m += step) {
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(m / 60), m % 60, 0, 0);
      if (at.getTime() < earliest || seen.has(at.getTime())) continue;
      seen.add(at.getTime());
      out.push(at);
    }
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}
