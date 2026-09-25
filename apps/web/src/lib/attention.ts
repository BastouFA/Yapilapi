'use client';

import { useEffect, useRef, useState } from 'react';

const dayKey = (tz: string, now = new Date()) => {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
};

/** Minutes since local midnight in the given time zone. */
export function minutesOfDay(tz: string, now = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
    const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
    return h * 60 + m;
  } catch {
    return now.getUTCHours() * 60 + now.getUTCMinutes();
  }
}

/** True when `nowMin` falls inside [start, end), including ranges that wrap past midnight. */
export function inQuietHours(nowMin: number, start: number | null, end: number | null): boolean {
  if (start === null || end === null || start === end) return false;
  return start < end ? nowMin >= start && nowMin < end : nowMin >= start || nowMin < end;
}

export const minutesToTime = (min: number): string =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
export const timeToMinutes = (v: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v);
  if (!m) return null;
  const h = Number(m[1]),
    min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
};

const safe = {
  get: (k: string): string | null => {
    try {
      return window.localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      window.localStorage.setItem(k, v);
    } catch {
      /* storage unavailable: limit just won't persist across reloads */
    }
  },
};

/**
 * Counts active foreground time per day (per user, per time zone) locally and reports when the daily limit is reached.
 * The counter is a convenience stored in this browser; it contains no credentials.
 */
export function useDailyUsage(
  userId: string,
  limitMinutes: number | null,
  tz: string,
): { limitReached: boolean; snooze: (minutes: number) => void } {
  const [reached, setReached] = useState(false);
  const snoozeUntil = useRef(0);
  const key = `yl_usage:${userId}:${dayKey(tz)}`;

  useEffect(() => {
    if (!limitMinutes) {
      setReached(false);
      return;
    }
    let lastActive = Date.now();
    const bump = () => {
      lastActive = Date.now();
    };
    const events = ['pointerdown', 'keydown', 'scroll', 'touchstart'] as const;
    for (const e of events) window.addEventListener(e, bump, { passive: true });
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible' || Date.now() - lastActive > 60_000) return;
      const seconds = Number(safe.get(key) ?? 0) + 15;
      safe.set(key, String(seconds));
      if (seconds >= limitMinutes * 60 && Date.now() > snoozeUntil.current) setReached(true);
    }, 15_000);
    if (Number(safe.get(key) ?? 0) >= limitMinutes * 60) setReached(true);
    return () => {
      clearInterval(timer);
      for (const e of events) window.removeEventListener(e, bump);
    };
  }, [limitMinutes, key]);

  return {
    limitReached: reached,
    snooze: (minutes) => {
      snoozeUntil.current = Date.now() + minutes * 60_000;
      setReached(false);
      // Re-arm after the snooze even if no further tick crosses the threshold.
      setTimeout(
        () => {
          if (limitMinutes && Number(safe.get(key) ?? 0) >= limitMinutes * 60) setReached(true);
        },
        minutes * 60_000 + 500,
      );
    },
  };
}
