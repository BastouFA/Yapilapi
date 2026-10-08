import { describe, expect, it } from 'vitest';
import { clipBytes, parseStationId, radioBack, radioOutcome, readResume, RADIO_RESUME_MS, sleepClock, stationId } from './radio.ts';
import type { Post } from './types.ts';

describe('stations', () => {
  it('round-trips a station through its id, and refuses ones that are not', () => {
    for (const s of [{ kind: 'for_you' as const }, { kind: 'topics' as const, key: 'music' }, { kind: 'squad' as const, key: 'abc' }]) {
      expect(parseStationId(stationId(s))).toEqual({ kind: s.kind, key: s.key ?? null });
    }
    expect(parseStationId('weather')).toBeNull();
    expect(parseStationId('squad')).toBeNull();
    expect(parseStationId('friends:someone')).toBeNull();
    expect(parseStationId(null)).toBeNull();
  });
});

describe('listening', () => {
  it('tells a finish from a quick skip', () => {
    expect(radioOutcome(9_000, 9_000, 10_000)).toBe('complete');
    expect(radioOutcome(2_000, 2_000, 10_000)).toBe('skip');
    expect(radioOutcome(6_000, 6_000, 10_000)).toBeNull();
  });

  it('goes back to the start, or to the Yap before at its very start', () => {
    expect(radioBack(10_000, 2)).toBe('restart');
    expect(radioBack(1_000, 2)).toBe('previous');
    expect(radioBack(1_000, 0)).toBe('restart');
  });

  it('counts a clip by its stored size, or by its length', () => {
    const post = (sizes: Record<string, number> | undefined, durationMs: number) =>
      ({ media: [{ kind: 'audio', sizes }], voice: { durationMs } }) as unknown as Pick<Post, 'media' | 'voice'>;
    expect(clipBytes(post({ original: 12_345 }, 30_000))).toBe(12_345);
    expect(clipBytes(post(undefined, 30_000))).toBe(120_000);
  });

  it('shows the sleep timer as minutes and seconds', () => {
    expect(sleepClock(15 * 60_000)).toBe('15:00');
    expect(sleepClock(61_500)).toBe('1:02');
    expect(sleepClock(-5)).toBe('0:00');
  });

  it('picks up where it was only while that is recent', () => {
    const now = Date.now();
    const kept = { station: 'friends', postId: 'p1', positionMs: 1234.4, at: now - 1000 };
    expect(readResume(kept, now)).toEqual({ ...kept, positionMs: 1234 });
    expect(readResume({ ...kept, at: now - RADIO_RESUME_MS - 1 }, now)).toBeNull();
    expect(readResume({ ...kept, station: 'weather' }, now)).toBeNull();
    expect(readResume('nonsense', now)).toBeNull();
  });
});
