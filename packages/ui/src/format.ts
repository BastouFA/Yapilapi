/** Intl-based formatting shared by UI components and the apps. Every function takes an explicit BCP-47 locale. */

const cache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat | Intl.RelativeTimeFormat>();
function memo<T extends Intl.NumberFormat | Intl.DateTimeFormat | Intl.RelativeTimeFormat>(
  key: string,
  make: () => T,
): T {
  let v = cache.get(key) as T | undefined;
  if (!v) {
    v = make();
    cache.set(key, v);
  }
  return v;
}

const safeLocale = (locale: string): string => {
  try {
    return Intl.NumberFormat.supportedLocalesOf([locale])[0] ?? 'en';
  } catch {
    return 'en';
  }
};

export function formatNumber(n: number, locale: string, opts?: Intl.NumberFormatOptions): string {
  const l = safeLocale(locale);
  return memo(`n|${l}|${JSON.stringify(opts ?? {})}`, () => new Intl.NumberFormat(l, opts)).format(
    n,
  );
}

/** 1.2K style counts. */
export function formatCompact(n: number, locale: string): string {
  return formatNumber(n, locale, { notation: 'compact', maximumFractionDigits: 1 });
}

export function formatCurrency(amount: number, currency: string, locale: string): string {
  return formatNumber(amount, locale, { style: 'currency', currency });
}

export function formatDate(
  d: Date | string | number,
  locale: string,
  opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
  timeZone?: string,
): string {
  const l = safeLocale(locale);
  const o = timeZone ? { ...opts, timeZone } : opts;
  return memo(`d|${l}|${JSON.stringify(o)}`, () => new Intl.DateTimeFormat(l, o)).format(
    new Date(d),
  );
}

export function formatDateTime(
  d: Date | string | number,
  locale: string,
  timeZone?: string,
): string {
  return formatDate(d, locale, { dateStyle: 'medium', timeStyle: 'short' }, timeZone);
}

export function formatTime(d: Date | string | number, locale: string, timeZone?: string): string {
  return formatDate(d, locale, { timeStyle: 'short' }, timeZone);
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
];

/** "3 hours ago" / "il y a 3 heures" / "قبل 3 ساعات". Falls back to a plain date beyond ~a year. */
export function formatRelativeTime(
  d: Date | string | number,
  locale: string,
  now: number = Date.now(),
): string {
  const l = safeLocale(locale);
  const seconds = Math.round((new Date(d).getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  const rtf = memo(
    `r|${l}`,
    () => new Intl.RelativeTimeFormat(l, { numeric: 'auto', style: 'short' }),
  );
  if (abs < 45) return rtf.format(0, 'second');
  for (const [unit, size] of UNITS) {
    if (abs >= size || unit === 'minute') return rtf.format(Math.round(seconds / size), unit);
  }
  return rtf.format(seconds, 'second');
}
