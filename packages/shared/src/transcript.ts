import { TRANSLATION_LANGUAGES } from './translation.ts';

/**
 * The words of a WebVTT caption file as plain text, for a recording's transcript: the header,
 * notes, cue ids, timings and styling tags are dropped, and the cues read as running text
 * (a blank line between paragraphs where the speaker paused for 2 seconds or more).
 */
export function transcriptText(vtt: string): string {
  const blocks = vtt.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  const out: string[] = [];
  let lastEnd: number | null = null;
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim());
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    const [from, to] = lines[at]!.split('-->').map((x) => seconds(x.trim().split(/\s+/)[0]!));
    const text = lines
      .slice(at + 1)
      .join(' ')
      .replace(/<[^>]*>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    const pause = lastEnd !== null && from != null && from - lastEnd >= 2;
    out.push(out.length ? (pause ? `\n\n${text}` : ` ${text}`) : text);
    lastEnd = to ?? lastEnd;
  }
  return out.join('');
}

/** "01:02.500" or "1:01:02.500" as seconds. */
function seconds(stamp: string): number | null {
  const parts = stamp.split(':').map(Number);
  if (parts.some((n) => Number.isNaN(n))) return null;
  return parts.reduce((total, n) => total * 60 + n, 0);
}

/**
 * The transcript an audio post's author edits: the one in their language, else the first (usually
 * the only one); null when the recording has none yet.
 */
export function authorTranscript<T extends { lang: string }>(tracks: readonly T[], locale: string): T | null {
  const base = locale.split('-')[0]!.toLowerCase();
  return tracks.find((x) => x.lang.split('-')[0]!.toLowerCase() === base) ?? tracks[0] ?? null;
}

/**
 * The language a new transcript is made in: the author's, as when the post went out, with its
 * label (the language's name in itself).
 */
export function transcriptLanguage(locale: string): { lang: string; label: string } {
  const lang = locale.split('-')[0]!.toLowerCase();
  return { lang, label: TRANSLATION_LANGUAGES.find((l) => l.code === lang)?.autonym ?? lang };
}
