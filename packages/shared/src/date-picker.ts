/**
 * Date math for the mobile date and time picker (apps/mobile/lib/date-time.tsx): the month grid,
 * limits, wall-clock arithmetic that survives daylight saving changes, and the locale facts the
 * picker needs (12 or 24 hour clock, first day of the week, month and weekday names).
 *
 * Everything works on the phone's local time, like the picker. No React here, so it is tested on
 * its own (date-picker.test.ts). Intl is used when present and every call falls back when the
 * runtime is missing a piece (Hermes builds differ in what they ship).
 */

const MINUTE = 60_000;

/** 0 = Sunday … 6 = Saturday, as `Date#getDay`. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface DayCell {
  year: number;
  /** 0-based, as `Date#getMonth`. */
  month: number;
  day: number;
  /** False for the days of the months before and after, shown to fill the first and last weeks. */
  inMonth: boolean;
  /** "2026-10-04": stable key for lists and comparisons. */
  key: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const dayKey = (year: number, month: number, day: number) => {
  const d = new Date(year, month, day);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
export const dateKey = (d: Date) => dayKey(d.getFullYear(), d.getMonth(), d.getDate());

/** Midnight at the start of the date's day, on the local clock. */
export const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

export const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/**
 * The same wall-clock time `n` days later (or earlier). Adding 24 hours of milliseconds would drift
 * by an hour across a daylight saving change; this keeps 09:00 at 09:00. A time that doesn't exist
 * on the new day (inside a spring-forward gap) moves forward, as the clock does.
 */
export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
}

/**
 * Whole calendar days from `from` to `to` (0 = same day, 1 = tomorrow, -1 = yesterday), counted
 * on the calendar rather than in 24-hour blocks, so a 23 or 25 hour day still counts as one.
 */
export function calendarDaysBetween(from: Date, to: Date): number {
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86_400_000);
}

/**
 * Move by `n` minutes on the wall clock (the hour and minute steppers). When the move lands in a
 * daylight saving gap and the clock can't show it, fall back to real elapsed minutes, so stepping
 * back over the gap never gets stuck.
 */
export function addMinutes(d: Date, n: number): Date {
  const wall = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes() + n, 0, 0);
  const moved = Math.sign(wall.getTime() - d.getTime());
  if (n !== 0 && moved !== Math.sign(n)) return new Date(d.getTime() + n * MINUTE);
  return wall;
}

/** The month `n` months from (year, month), as { year, month } with a 0-based month. */
export function addMonths(year: number, month: number, n: number): { year: number; month: number } {
  const total = year * 12 + month + n;
  return { year: Math.floor(total / 12), month: ((total % 12) + 12) % 12 };
}

/**
 * The weeks of a month for a calendar grid, each seven days long, starting on `weekStart`. Days of
 * the neighbouring months fill the first and last weeks (`inMonth: false`). With `fixedWeeks`
 * (the default) there are always six weeks, so the grid keeps its height from month to month.
 */
export function monthGrid(year: number, month: number, weekStart: Weekday = 1, fixedWeeks = true): DayCell[][] {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() - weekStart + 7) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const weeks = fixedWeeks ? 6 : Math.ceil((lead + daysInMonth) / 7);
  const out: DayCell[][] = [];
  for (let w = 0; w < weeks; w++) {
    const row: DayCell[] = [];
    for (let i = 0; i < 7; i++) {
      // Day numbers outside 1..daysInMonth roll into the neighbouring months.
      const d = new Date(year, month, 1 - lead + w * 7 + i);
      row.push({
        year: d.getFullYear(),
        month: d.getMonth(),
        day: d.getDate(),
        inMonth: d.getMonth() === month && d.getFullYear() === year,
        key: dateKey(d),
      });
    }
    out.push(row);
  }
  return out;
}

/** Round up to the next whole step of minutes (seconds count: 10:00:30 rounds up to 10:05). */
export function ceilToStep(d: Date, step = 5): Date {
  const exact = d.getSeconds() === 0 && d.getMilliseconds() === 0 && d.getMinutes() % step === 0;
  if (exact) return new Date(d.getTime());
  const minutes = Math.floor(d.getMinutes() / step) * step + step;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), minutes, 0, 0);
}

/** Round down to a whole step of minutes. */
export function floorToStep(d: Date, step = 5): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), Math.floor(d.getMinutes() / step) * step, 0, 0);
}

export interface Limits {
  min?: Date | null;
  max?: Date | null;
}

export const inRange = (d: Date, { min, max }: Limits) => (!min || d.getTime() >= min.getTime()) && (!max || d.getTime() <= max.getTime());

/**
 * Bring a time inside [min, max] on the picker's grid of `step` minutes: below the minimum it
 * becomes the first step at or after it, above the maximum the last step at or before it. A
 * window narrower than one step gives the minimum itself.
 */
export function clampToRange(d: Date, { min, max }: Limits, step = 5): Date {
  let out = new Date(d.getTime());
  if (min && out.getTime() < min.getTime()) out = ceilToStep(min, step);
  if (max && out.getTime() > max.getTime()) out = floorToStep(max, step);
  if (min && out.getTime() < min.getTime()) out = new Date(min.getTime());
  return out;
}

/**
 * Whether a day can be picked. In `datetime` mode a day counts when any moment of it is inside
 * the limits (a time is then clamped); in `date` mode the day's midnight must be.
 */
export function dayDisabled(year: number, month: number, day: number, { min, max }: Limits, mode: 'date' | 'datetime' = 'datetime'): boolean {
  const start = new Date(year, month, day);
  if (mode === 'date') return !inRange(start, { min, max });
  const nextStart = new Date(year, month, day + 1);
  if (min && nextStart.getTime() <= min.getTime()) return true;
  if (max && start.getTime() > max.getTime()) return true;
  return false;
}

/** Whether a whole month is outside the limits (the arrows to it are then disabled). */
export function monthDisabled(year: number, month: number, { min, max }: Limits): boolean {
  const start = new Date(year, month, 1);
  const nextStart = new Date(year, month + 1, 1);
  if (min && nextStart.getTime() <= min.getTime()) return true;
  if (max && start.getTime() > max.getTime()) return true;
  return false;
}

/** The chosen day with the time of day kept, clamped into the limits. */
export function withDay(value: Date, year: number, month: number, day: number, limits: Limits, step = 5): Date {
  return clampToRange(new Date(year, month, day, value.getHours(), value.getMinutes()), limits, step);
}

/** The same day at a new hour and minute, clamped into the limits. */
export function withTime(value: Date, hour: number, minute: number, limits: Limits, step = 5): Date {
  return clampToRange(new Date(value.getFullYear(), value.getMonth(), value.getDate(), hour, minute), limits, step);
}

// ── 12 and 24 hour clocks ───────────────────────────────────────────────

/** 13 → { hour: 1, pm: true }; 0 → { hour: 12, pm: false }. */
export const to12Hour = (h: number) => ({ hour: h % 12 === 0 ? 12 : h % 12, pm: h >= 12 });
/** The reverse of `to12Hour`. */
export const from12Hour = (hour: number, pm: boolean) => (hour % 12) + (pm ? 12 : 0);

type IntlLike = { DateTimeFormat: typeof Intl.DateTimeFormat };

/** Languages whose default region uses a 12-hour clock, for runtimes without Intl. */
const TWELVE_HOUR_LANGS = new Set(['en', 'ar', 'hi', 'ur', 'bn', 'ko', 'fil']);
/** Regions that use a 24-hour clock although their language's default region doesn't. */
const TWENTY_FOUR_HOUR_REGIONS = new Set(['GB', 'IE', 'ZA', 'NG', 'KE', 'GH', 'MA', 'DZ', 'TN', 'IL', 'DE', 'FR']);

function regionOf(locale: string): string | undefined {
  return locale
    .replace(/_/g, '-')
    .split('-')
    .slice(1)
    .find((p) => /^([A-Za-z]{2}|\d{3})$/.test(p))
    ?.toUpperCase();
}

/**
 * Whether the locale shows time on a 12-hour clock (9:00 PM) rather than 24 hours (21:00). Reads
 * the formatter's hour cycle, then looks at how it writes 13:00, then falls back to a small table.
 */
export function uses12Hour(locale: string, intl: IntlLike | undefined = globalThis.Intl): boolean {
  if (intl?.DateTimeFormat) {
    try {
      const f = new intl.DateTimeFormat(locale, { hour: 'numeric' });
      const o = f.resolvedOptions() as Intl.ResolvedDateTimeFormatOptions & { hourCycle?: string };
      if (o.hourCycle) return o.hourCycle === 'h11' || o.hourCycle === 'h12';
      if (typeof o.hour12 === 'boolean') return o.hour12;
      if (typeof f.formatToParts === 'function') return f.formatToParts(new Date(2020, 0, 1, 13)).some((p) => p.type === 'dayPeriod');
    } catch {
      // Fall through to the table.
    }
  }
  const lang = locale.split(/[-_]/)[0]!.toLowerCase();
  const region = regionOf(locale);
  if (region === 'US' || region === 'CA' || region === 'AU' || region === 'IN' || region === 'PH') return true;
  if (region && TWENTY_FOUR_HOUR_REGIONS.has(region)) return false;
  return TWELVE_HOUR_LANGS.has(lang);
}

/** Regions whose week starts on Sunday or Saturday; everywhere else it starts on Monday (ISO 8601). */
const SUNDAY_REGIONS = new Set([
  'US',
  'CA',
  'BR',
  'MX',
  'JP',
  'KR',
  'CN',
  'TW',
  'HK',
  'IL',
  'IN',
  'PH',
  'ZA',
  'KE',
  'ET',
  'AU',
  'PE',
  'CO',
  'SA',
  'PK',
  'GT',
  'VE',
  'PT',
  'ZW',
]);
const SATURDAY_REGIONS = new Set(['EG', 'AE', 'AF', 'BH', 'DJ', 'DZ', 'IQ', 'IR', 'JO', 'KW', 'LY', 'OM', 'QA', 'SD', 'SY']);
/** The region assumed when a locale names only its language (CLDR's likely region). */
const LIKELY_REGION: Record<string, string> = { en: 'US', fr: 'FR', ar: 'EG', es: 'ES', pt: 'BR', sw: 'TZ', yo: 'NG', ha: 'NG' };

/**
 * First day of the week for a calendar in this locale: 0 Sunday, 1 Monday, 6 Saturday. Uses
 * `Intl.Locale#getWeekInfo` (or the older `weekInfo`) when the runtime has it; Hermes and older
 * engines don't, so a table by region covers the rest.
 */
export function weekStartFor(locale: string, intl: unknown = globalThis.Intl): Weekday {
  try {
    const Locale = (intl as { Locale?: new (tag: string) => { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } } })?.Locale;
    if (Locale) {
      const l = new Locale(locale);
      const info = typeof l.getWeekInfo === 'function' ? l.getWeekInfo() : l.weekInfo;
      if (info && typeof info.firstDay === 'number') return (info.firstDay % 7) as Weekday; // 7 means Sunday there
    }
  } catch {
    // Fall through to the table.
  }
  const lang = locale.split(/[-_]/)[0]!.toLowerCase();
  const region = regionOf(locale) ?? LIKELY_REGION[lang];
  if (region && SATURDAY_REGIONS.has(region)) return 6;
  if (region && SUNDAY_REGIONS.has(region)) return 0;
  return 1;
}

// ── Names, in the app's language ────────────────────────────────────────

const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const EN_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function format(locale: string, d: Date, opts: Intl.DateTimeFormatOptions, fallback: () => string, intl: IntlLike | undefined = globalThis.Intl): string {
  try {
    if (!intl?.DateTimeFormat) return fallback();
    return new intl.DateTimeFormat(locale, opts).format(d);
  } catch {
    return fallback();
  }
}

/** "October 2026" (or the locale's own order and words). */
export function monthTitle(locale: string, year: number, month: number, intl?: IntlLike): string {
  return format(locale, new Date(year, month, 1), { month: 'long', year: 'numeric' }, () => `${EN_MONTHS[month]} ${year}`, intl);
}

/**
 * Weekday headers in grid order from `weekStart`: `narrow` for the column heads ("M"), `long` for
 * screen readers ("Monday").
 */
export function weekdayNames(locale: string, weekStart: Weekday, style: 'narrow' | 'short' | 'long' = 'short', intl?: IntlLike): string[] {
  // 4 January 2026 was a Sunday.
  return Array.from({ length: 7 }, (_, i) => {
    const wd = (weekStart + i) % 7;
    const en = EN_DAYS[wd]!;
    return format(locale, new Date(2026, 0, 4 + wd), { weekday: style }, () => (style === 'long' ? en : style === 'short' ? en.slice(0, 3) : en[0]!), intl);
  });
}

/** The words for morning and afternoon on a 12-hour clock ("AM", "PM"; "ص", "م" in Arabic). */
export function dayPeriodNames(locale: string, intl: IntlLike | undefined = globalThis.Intl): { am: string; pm: string } {
  const pick = (h: number, fallback: string) => {
    try {
      const f = new intl!.DateTimeFormat(locale, { hour: 'numeric', hour12: true });
      return f.formatToParts(new Date(2026, 0, 5, h)).find((p) => p.type === 'dayPeriod')?.value || fallback;
    } catch {
      return fallback;
    }
  };
  return { am: pick(9, 'AM'), pm: pick(21, 'PM') };
}

/** "9:05 PM" or "21:05", on the clock the picker shows. */
export function formatClock(locale: string, d: Date, hour12: boolean, intl?: IntlLike): string {
  return format(
    locale,
    d,
    { hour: 'numeric', minute: '2-digit', hour12 },
    () => {
      if (!hour12) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
      const { hour, pm } = to12Hour(d.getHours());
      return `${hour}:${pad(d.getMinutes())} ${pm ? 'PM' : 'AM'}`;
    },
    intl,
  );
}

/**
 * Which words a summary line starts with: today, tomorrow, or a date (with the year when it isn't
 * this year). The mobile picker turns it into "Tomorrow at 9:00" or "Sat 4 Oct at 20:00".
 */
export function summaryParts(d: Date, now: Date): { day: 'today' | 'tomorrow' | 'date'; withYear: boolean } {
  const diff = calendarDaysBetween(now, d);
  return { day: diff === 0 ? 'today' : diff === 1 ? 'tomorrow' : 'date', withYear: d.getFullYear() !== now.getFullYear() };
}

// ── Quick choices ───────────────────────────────────────────────────────

export type QuickChoice = 'hour' | 'tonight' | 'morning';

/**
 * In 1 hour (rounded up to the step), tonight at 20:00 and tomorrow at 09:00. The picker hides
 * the ones outside its limits, so "tonight" disappears late in the evening.
 */
export function quickChoices(now: Date, step = 5): { id: QuickChoice; at: Date }[] {
  const tonight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 20, 0);
  const morning = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0);
  return [
    { id: 'hour', at: ceilToStep(new Date(now.getTime() + 60 * MINUTE), step) },
    { id: 'tonight', at: tonight },
    { id: 'morning', at: morning },
  ];
}

/** The year choices for a quick jump between years, from the limits (or a window around `around`). */
export function yearsInRange({ min, max }: Limits, around: Date, span = 5): number[] {
  const from = min ? min.getFullYear() : around.getFullYear() - span;
  const to = max ? max.getFullYear() : around.getFullYear() + span;
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);
}
