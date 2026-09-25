import { describe, expect, it } from 'vitest';
import { LANG_RE, parseVttTimestamp, validateVtt } from './vtt.js';

const GOOD = `WEBVTT

00:00:01.000 --> 00:00:03.500
Hello there

00:00:04.000 --> 00:00:06.000 align:start
General <b>Kenobi</b>
`;

describe('validateVtt', () => {
  it('accepts a well-formed file (and normalises CRLF / BOM)', () => {
    const r = validateVtt(GOOD);
    expect(r).toMatchObject({ ok: true, cues: 2 });
    const r2 = validateVtt('﻿' + GOOD.replace(/\n/g, '\r\n'));
    expect(r2.ok).toBe(true);
    expect(r2.content).not.toContain('\r');
    expect(validateVtt('WEBVTT - my track\n\n01:02.000 --> 01:03.000\nshort form\n').ok).toBe(true);
  });

  it('rejects things that are not WebVTT', () => {
    expect(validateVtt('1\n00:00:01,000 --> 00:00:02,000\nSRT is not VTT').ok).toBe(false);
    expect(validateVtt('<html>').ok).toBe(false);
    expect(validateVtt('WEBVTT\n\nno cues here').ok).toBe(false);
    expect(validateVtt('WEBVTTX\n\n00:00:01.000 --> 00:00:02.000\nx').ok).toBe(false);
    expect(validateVtt('WEBVTT\n\n00:00:05.000 --> 00:00:02.000\nbackwards').ok).toBe(false);
    expect(
      validateVtt(
        'WEBVTT\n\n00:00:05.000 --> 00:00:06.000\na\n\n00:00:01.000 --> 00:00:02.000\nout of order',
      ).ok,
    ).toBe(false);
    expect(validateVtt('WEBVTT\n\n00:00:61.000 --> 00:00:62.000\nbad seconds').ok).toBe(false);
    expect(validateVtt('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nx\0').ok).toBe(false);
    expect(validateVtt('WEBVTT\n\n' + 'x'.repeat(600 * 1024)).ok).toBe(false);
  });

  it('parses timestamps', () => {
    expect(parseVttTimestamp('01:02:03.004')).toBe(3_723_004);
    expect(parseVttTimestamp('02:03.500')).toBe(123_500);
  });

  it('validates language tags', () => {
    for (const ok of ['en', 'pt-BR', 'zh-Hans', 'fil']) expect(LANG_RE.test(ok)).toBe(true);
    for (const bad of ['', 'e', '../x', 'en_US', 'english-language-long', 'en/../..'])
      expect(LANG_RE.test(bad)).toBe(false);
  });
});
