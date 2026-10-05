import { describe, expect, it } from 'vitest';
import { authorTranscript, transcriptLanguage, transcriptText } from './transcript.ts';

describe('transcriptText', () => {
  it('keeps only the words, as running text with paragraphs at long pauses', () => {
    const vtt = [
      'WEBVTT',
      '',
      'NOTE made automatically',
      '',
      '1',
      '00:00.000 --> 00:01.500 align:start',
      'Hello <b>everyone</b>,',
      'and welcome.',
      '',
      '00:01.600 --> 00:03.000',
      'Fish &amp; chips tonight.',
      '',
      '00:06.000 --> 00:07.000',
      'Another thought.',
      '',
    ].join('\r\n');
    expect(transcriptText(vtt)).toBe('Hello everyone, and welcome. Fish & chips tonight.\n\nAnother thought.');
  });

  it('is empty for a file without cues', () => {
    expect(transcriptText('WEBVTT\n\n')).toBe('');
    expect(transcriptText('')).toBe('');
  });

  it('reads hour-long timings', () => {
    expect(transcriptText('WEBVTT\n\n1:00:00.000 --> 1:00:01.000\nA\n\n1:00:05.000 --> 1:00:06.000\nB\n')).toBe('A\n\nB');
  });
});

describe('the author’s transcript', () => {
  const fr = { lang: 'fr', label: 'Français' };
  const en = { lang: 'en', label: 'English' };

  it('is the one in their language, else the first one', () => {
    expect(authorTranscript([en, fr], 'fr-CA')).toBe(fr);
    expect(authorTranscript([fr], 'sw')).toBe(fr);
    expect(authorTranscript([], 'en')).toBeNull();
  });

  it('is made in their language, named in itself', () => {
    expect(transcriptLanguage('pt-BR')).toEqual({ lang: 'pt', label: 'Português' });
    expect(transcriptLanguage('yo')).toEqual({ lang: 'yo', label: 'Yorùbá' });
  });
});
