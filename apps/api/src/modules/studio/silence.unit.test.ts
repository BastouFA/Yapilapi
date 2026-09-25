import { describe, expect, it } from 'vitest';
import {
  highlightCandidates,
  parseSilenceDetect,
  silenceCuts,
  soundSpans,
  thumbnailMoments,
} from './silence.js';

const STDERR = `[silencedetect @ 0x1] silence_start: 1.5
[silencedetect @ 0x1] silence_end: 3.25 | silence_duration: 1.75
size=N/A time=00:00:10.00 bitrate=N/A speed= 500x
[silencedetect @ 0x1] silence_start: 8
`;

describe('silencedetect parsing', () => {
  it('reads closed ranges and closes a trailing one at the end of the media', () => {
    expect(parseSilenceDetect(STDERR, 10_000)).toEqual([
      { startMs: 1500, endMs: 3250 },
      { startMs: 8000, endMs: 10_000 },
    ]);
    expect(parseSilenceDetect('', 5000)).toEqual([]);
    expect(
      parseSilenceDetect('silence_start: -0.02\nsilence_end: 1 | silence_duration: 1', 5000),
    ).toEqual([{ startMs: 0, endMs: 1000 }]);
    expect(parseSilenceDetect('silence_end: 4', 5000)).toEqual([]); // an end without a start is ignored
  });
});

describe('cut proposals', () => {
  it('drops short pauses, pads the rest so speech is not clipped, and ignores slivers', () => {
    const cuts = silenceCuts([
      { startMs: 1000, endMs: 1500 },
      { startMs: 2000, endMs: 4000 },
      { startMs: 4500, endMs: 5300 },
      { startMs: 6000, endMs: 6900 },
    ]);
    expect(cuts).toEqual([
      { startMs: 2150, endMs: 3850 },
      { startMs: 4650, endMs: 5150 },
      { startMs: 6150, endMs: 6750 },
    ]);
    expect(silenceCuts([{ startMs: 0, endMs: 900 }], { minSilenceMs: 800, padMs: 400 })).toEqual(
      [],
    ); // nothing left after padding
  });
  it('finds sound spans, highlight candidates and thumbnail moments', () => {
    const sil = [
      { startMs: 2000, endMs: 3000 },
      { startMs: 5000, endMs: 5500 },
    ];
    expect(soundSpans(sil, 10_000)).toEqual([
      { startMs: 0, endMs: 2000 },
      { startMs: 3000, endMs: 5000 },
      { startMs: 5500, endMs: 10_000 },
    ]);
    const hl = highlightCandidates(sil, 10_000, 2);
    expect(hl.map((h) => [h.startMs, h.endMs])).toEqual([
      [0, 2000],
      [5500, 10_000],
    ]);
    expect(hl.every((h) => h.score > 0 && h.score <= 1)).toBe(true);
    expect(highlightCandidates([], 100_000, 1)[0]).toMatchObject({ startMs: 0, endMs: 30_000 });
    const moments = thumbnailMoments(sil, 10_000, 3);
    expect(moments.length).toBeGreaterThan(0);
    for (const m of moments) expect(sil.some((s) => m >= s.startMs && m < s.endMs)).toBe(false); // never inside silence
    expect(thumbnailMoments([{ startMs: 0, endMs: 9000 }], 10_000, 2).every((m) => m >= 9000)).toBe(
      true,
    );
  });
});
