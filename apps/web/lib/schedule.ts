import { SCHEDULE_MAX_DAYS, SCHEDULE_MIN_MINUTES } from '@yapilapi/shared';

/** A date as a datetime-local value ("2026-10-06T20:00"), in the browser's time zone. */
export function localInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The earliest and latest times a post can be scheduled for, as datetime-local values. */
export function scheduleBounds(now = Date.now()): { min: string; max: string } {
  return { min: localInput(new Date(now + SCHEDULE_MIN_MINUTES * 60_000)), max: localInput(new Date(now + SCHEDULE_MAX_DAYS * 86_400_000)) };
}

/** The start of the next hour: where the time picker opens. */
export function nextHour(): string {
  const d = new Date(Date.now() + 60 * 60_000);
  d.setMinutes(0, 0, 0);
  return localInput(d);
}

export const SCHEDULE_HINT = `Between ${SCHEDULE_MIN_MINUTES} minutes and ${SCHEDULE_MAX_DAYS} days from now, in your time zone. Until then, only you can see it, in Drafts.`;
