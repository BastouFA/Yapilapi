import { describe, expect, it } from 'vitest';
import {
  formatTimestamp,
  importCaptions,
  parseSrt,
  parseVtt,
  reviewCues,
  toSrt,
  toVtt,
  validateCues,
} from './captions.js';

const VTT = `WEBVTT

NOTE a comment

intro
00:00:01.000 --> 00:00:03.500 align:start
Hello <b>there</b>,
friend

00:01:00.250 --> 00:01:02.000
Second cue
`;
const SRT = `1
00:00:01,000 --> 00:00:03,500
Hello there,
friend

2
00:01:00,250 --> 00:01:02,000
Second cue
`;

describe('WebVTT and SRT parsing', () => {
  it('parses WebVTT: ids, notes, settings and inline tags', () => {
    const r = parseVtt(VTT);
    expect(r).toEqual({
      ok: true,
      cues: [
        { startMs: 1000, endMs: 3500, text: 'Hello there,\nfriend' },
        { startMs: 60_250, endMs: 62_000, text: 'Second cue' },
      ],
    });
  });
  it('parses SRT (comma decimals, numeric ids) and both agree', () => {
    const a = parseSrt(SRT);
    expect(a.ok && a.cues).toEqual([
      { startMs: 1000, endMs: 3500, text: 'Hello there,\nfriend' },
      { startMs: 60_250, endMs: 62_000, text: 'Second cue' },
    ]);
  });
  it('accepts CRLF, a BOM and short timestamps; rejects wrong formats and bad timing', () => {
    expect(parseVtt(`\uFEFFWEBVTT\r\n\r\n00:01.500 --> 00:02.000\r\nHi\r\n`)).toEqual({
      ok: true,
      cues: [{ startMs: 1500, endMs: 2000, text: 'Hi' }],
    });
    expect(parseVtt('hello')).toMatchObject({ ok: false });
    expect(parseSrt(VTT)).toMatchObject({ ok: false, error: expect.stringMatching(/WebVTT/) });
    expect(parseVtt('WEBVTT\n\n00:00:01.000 --> nonsense\nx')).toMatchObject({
      ok: false,
      line: 3,
    });
    expect(parseVtt('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nnul\0l')).toMatchObject({
      ok: false,
    });
    expect(parseVtt(`WEBVTT\n\n${'x'.repeat(600 * 1024)}`)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/large/),
    });
  });
  it('import validates the cues too (order, end after start, text present)', () => {
    expect(importCaptions('vtt', VTT).ok).toBe(true);
    expect(
      importCaptions(
        'vtt',
        'WEBVTT\n\n00:00:05.000 --> 00:00:06.000\na\n\n00:00:01.000 --> 00:00:02.000\nb',
      ),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/order/) });
    expect(importCaptions('vtt', 'WEBVTT\n\n00:00:05.000 --> 00:00:04.000\na')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/end after/),
    });
    expect(importCaptions('vtt', 'WEBVTT\n\n00:00:05.000 --> 00:00:06.000\n')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/text/),
    });
    expect(importCaptions('srt', '')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/no cues/),
    });
  });
});

describe('cue validation and serialisation', () => {
  it('flags every kind of invalid cue', () => {
    const msgs = (c: Array<{ startMs: number; endMs: number; text: string }>) =>
      validateCues(c)
        .map((i) => i.message)
        .join('|');
    expect(msgs([])).toMatch(/no cues/);
    expect(msgs([{ startMs: 5, endMs: 5, text: 'a' }])).toMatch(/end after/);
    expect(msgs([{ startMs: 1.5, endMs: 5, text: 'a' }])).toMatch(/whole milliseconds/);
    expect(msgs([{ startMs: 0, endMs: 5, text: '  ' }])).toMatch(/needs text/);
    expect(msgs([{ startMs: 0, endMs: 5, text: 'a --> b' }])).toMatch(/-->/);
    expect(msgs([{ startMs: 0, endMs: 5, text: 'x'.repeat(501) }])).toMatch(/at most 500/);
    expect(msgs([{ startMs: 0, endMs: 5, text: 'bell\u0007' }])).toMatch(/control/);
    for (const bad of ['\u0000', '\u0008', '\u000B', '\u000C', '\u000E', '\u001F'])
      expect(msgs([{ startMs: 0, endMs: 5, text: `a${bad}b` }])).toMatch(/control/);
    for (const fine of ['\t', '\n', '\r', '\u0020', '\u007F'])
      expect(msgs([{ startMs: 0, endMs: 5, text: `a${fine}b` }])).toBe('');
    expect(msgs([{ startMs: 0, endMs: 5, text: 'ok' }])).toBe('');
  });
  it('round-trips through WebVTT and SRT and escapes markup on output', () => {
    const cues = [
      { startMs: 3_723_004, endMs: 3_725_000, text: 'a < b & c' },
      { startMs: 3_726_000, endMs: 3_727_000, text: 'line1\nline2' },
    ];
    expect(toSrt(cues)).toContain('01:02:03,004 --> 01:02:05,000');
    expect(toVtt(cues)).toContain('a &lt; b &amp; c');
    const back = parseSrt(toSrt(cues));
    expect(back.ok && back.cues).toEqual(cues);
    expect(formatTimestamp(61_001, '.')).toBe('00:01:01.001');
  });
});

describe('caption review heuristics', () => {
  it('finds reading speed, short cues, long lines, too many lines and overlaps', () => {
    const cues = [
      { startMs: 0, endMs: 1000, text: 'x'.repeat(50) },
      { startMs: 1500, endMs: 1900, text: 'ok' },
      { startMs: 3000, endMs: 8000, text: 'a\nb\nc' },
      { startMs: 9000, endMs: 12_000, text: 'fine words here' },
      { startMs: 11_000, endMs: 14_000, text: 'overlapping cue' },
    ];
    const codes = reviewCues(cues).map((f) => `${f.index}:${f.code}`);
    expect(codes).toEqual(
      expect.arrayContaining([
        '0:too_fast',
        '0:too_long_line',
        '1:too_short',
        '2:too_many_lines',
        '3:overlap',
      ]),
    );
    expect(reviewCues([{ startMs: 0, endMs: 2000, text: 'Perfectly readable line' }])).toEqual([]);
  });
});
