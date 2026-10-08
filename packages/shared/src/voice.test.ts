import { describe, expect, it } from 'vitest';
import {
  activeSegment,
  listenFinished,
  nextVoiceRate,
  peaksFromSamples,
  resamplePeaks,
  seekMs,
  VOICE_INTRO_MAX_MS,
  VOICE_MAX_MS,
  VOICE_PEAKS,
  voiceClock,
  voiceLimitMs,
} from './voice.ts';
import { commentSchema, createPostSchema } from './schemas.ts';

describe('voice helpers', () => {
  it('has a limit per purpose', () => {
    expect(voiceLimitMs('yap')).toBe(VOICE_MAX_MS);
    expect(voiceLimitMs('comment')).toBe(VOICE_MAX_MS);
    expect(voiceLimitMs('intro')).toBe(VOICE_INTRO_MAX_MS);
  });

  it('tells the time and steps through speeds', () => {
    expect(voiceClock(0)).toBe('0:00');
    expect(voiceClock(7_900)).toBe('0:07');
    expect(voiceClock(60_000)).toBe('1:00');
    expect(nextVoiceRate(1)).toBe(1.5);
    expect(nextVoiceRate(1.5)).toBe(2);
    expect(nextVoiceRate(2)).toBe(1);
    expect(nextVoiceRate(3)).toBe(1);
  });

  it('draws loudness bars from samples, the loudest at 100', () => {
    const quietThenLoud = [...Array(400).fill(0.01), ...Array(400).fill(0.5)];
    const peaks = peaksFromSamples(quietThenLoud, 8);
    expect(peaks).toHaveLength(8);
    expect(peaks.slice(4)).toEqual([100, 100, 100, 100]);
    expect(peaks[0]).toBeGreaterThan(0);
    expect(peaks[0]).toBeLessThan(10);
    expect(peaksFromSamples([], 4)).toEqual([0, 0, 0, 0]);
    expect(peaksFromSamples(Array(100).fill(0))).toEqual(Array(VOICE_PEAKS).fill(0));
  });

  it('redraws a waveform with another number of bars', () => {
    expect(resamplePeaks([10, 50, 20, 80], 2)).toEqual([50, 80]);
    expect(resamplePeaks([10, 50], 4)).toEqual([10, 10, 50, 50]);
    expect(resamplePeaks([], 3)).toEqual([0, 0, 0]);
  });

  it('finds the line being spoken, scrubs and knows a finished listen', () => {
    const segments = [
      { start: 0, end: 1.5, text: 'Hello' },
      { start: 2, end: 3, text: 'there' },
    ];
    expect(activeSegment(segments, 0.4)).toBe(0);
    expect(activeSegment(segments, 1.8)).toBe(-1);
    expect(activeSegment(segments, 2.5)).toBe(1);
    expect(seekMs(0.5, 30_000)).toBe(15_000);
    expect(seekMs(-1, 30_000)).toBe(0);
    expect(seekMs(2, 30_000)).toBe(30_000);
    expect(listenFinished(27_000, 30_000)).toBe(true);
    expect(listenFinished(20_000, 30_000)).toBe(false);
  });
});

describe('Yap schemas', () => {
  const media = [{ id: '00000000-0000-4000-8000-000000000001', url: 'https://example.test/v.m4a', kind: 'audio' as const }];
  it('a Yap is one recording with a short line', () => {
    expect(createPostSchema.safeParse({ format: 'yap', visibility: 'public', body: '', media }).success).toBe(true);
    expect(createPostSchema.safeParse({ format: 'yap', visibility: 'public', body: 'Hi', media: [] }).success).toBe(false);
    expect(createPostSchema.safeParse({ format: 'yap', visibility: 'public', body: 'x'.repeat(281), media }).success).toBe(false);
    expect(createPostSchema.safeParse({ format: 'yap', visibility: 'public', body: '', media, poll: { options: ['a', 'b'] } }).success).toBe(false);
  });
  it('a comment has words, a recording or both', () => {
    expect(commentSchema.safeParse({ body: '' }).success).toBe(false);
    expect(commentSchema.safeParse({ voiceId: media[0]!.id }).success).toBe(true);
    expect(commentSchema.safeParse({ body: 'Nice' }).success).toBe(true);
  });
});
