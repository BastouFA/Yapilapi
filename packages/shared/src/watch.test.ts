import { describe, expect, it } from 'vitest';
import {
  betterClock,
  clockSample,
  driftFix,
  expectedPositionMs,
  isNewerPlayback,
  WATCH_DRIFT_OK_MS,
  WATCH_DRIFT_SEEK_MS,
  WATCH_MAX_RATE_NUDGE,
} from './watch.ts';
import { isEmptyWeek, weekOf } from './wrap.ts';

describe('clock offset', () => {
  it('splits the round trip evenly', () => {
    // Sent at 1000, back at 1200 (on this device); the server said 5100 on the way.
    expect(clockSample(1000, 1200, 5100)).toEqual({ offset: 4000, rtt: 200 });
  });

  it('never has a negative round trip', () => {
    expect(clockSample(1000, 990, 1000).rtt).toBe(0);
  });

  it('keeps the sample with the shortest round trip', () => {
    const a = { offset: 50, rtt: 80 };
    const b = { offset: 90, rtt: 300 };
    expect(betterClock(null, a)).toBe(a);
    expect(betterClock(a, b)).toBe(a);
    expect(betterClock(b, a)).toBe(a);
    // An old estimate loses its advantage over time.
    expect(betterClock(a, b, 400)).toBe(b);
  });
});

describe('expected position', () => {
  it('moves on while playing and stays while paused', () => {
    expect(expectedPositionMs({ playing: true, positionMs: 1000, at: 10_000 }, 12_500)).toBe(3500);
    expect(expectedPositionMs({ playing: false, positionMs: 1000, at: 10_000 }, 12_500)).toBe(1000);
  });

  it('stays within the video', () => {
    expect(expectedPositionMs({ playing: true, positionMs: 9000, at: 0 }, 5000, 10_000)).toBe(10_000);
    // A reading from the future (clock estimate off) doesn't move backwards.
    expect(expectedPositionMs({ playing: true, positionMs: 1000, at: 5000 }, 4000)).toBe(1000);
  });
});

describe('drift correction', () => {
  it('leaves small drift alone', () => {
    expect(driftFix(1000, 1000 + WATCH_DRIFT_OK_MS)).toEqual({ kind: 'none', rate: 1 });
  });

  it('speeds up when behind and slows down when ahead, within limits', () => {
    const behind = driftFix(1000, 1800);
    expect(behind.kind).toBe('nudge');
    expect(behind.rate).toBeGreaterThan(1);
    expect(behind.rate).toBeLessThanOrEqual(1 + WATCH_MAX_RATE_NUDGE);
    const ahead = driftFix(1800, 1000);
    expect(ahead.kind).toBe('nudge');
    expect(ahead.rate).toBeLessThan(1);
    expect(ahead.rate).toBeGreaterThanOrEqual(1 - WATCH_MAX_RATE_NUDGE);
  });

  it('seeks when far off, and always when paused', () => {
    expect(driftFix(0, WATCH_DRIFT_SEEK_MS + 10)).toEqual({ kind: 'seek', toMs: WATCH_DRIFT_SEEK_MS + 10, rate: 1 });
    expect(driftFix(1000, 1500, false)).toEqual({ kind: 'seek', toMs: 1500, rate: 1 });
  });
});

describe('playback ordering', () => {
  it('takes higher seq, or a newer reading of the same state', () => {
    expect(isNewerPlayback({ seq: 2, at: 10 }, null)).toBe(true);
    expect(isNewerPlayback({ seq: 3, at: 5 }, { seq: 2, at: 10 })).toBe(true);
    expect(isNewerPlayback({ seq: 2, at: 11 }, { seq: 2, at: 10 })).toBe(true);
    expect(isNewerPlayback({ seq: 2, at: 10 }, { seq: 2, at: 10 })).toBe(false);
    expect(isNewerPlayback({ seq: 1, at: 99 }, { seq: 2, at: 10 })).toBe(false);
  });
});

describe('weekly wrap weeks', () => {
  it('runs Monday to Sunday', () => {
    expect(weekOf('2026-09-27')).toEqual({ start: '2026-09-21', end: '2026-09-27' }); // a Sunday
    expect(weekOf('2026-09-21')).toEqual({ start: '2026-09-21', end: '2026-09-27' }); // a Monday
    expect(weekOf('2027-01-01')).toEqual({ start: '2026-12-28', end: '2027-01-03' });
  });

  it('knows an empty week', () => {
    const none = { posts: 0, reels: 0, newFriends: 0, communities: 0, places: 0, events: 0, songs: 0 };
    expect(isEmptyWeek(none)).toBe(true);
    expect(isEmptyWeek({ ...none, songs: 1 })).toBe(false);
  });
});
