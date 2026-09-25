/**
 * WebVTT parsing, validation and sanitizing for caption tracks.
 *
 * Uploaded files are parsed strictly and re-serialized from the parsed cues, so
 * what we store is always well-formed: STYLE and REGION blocks are dropped, cue
 * settings are limited to the standard ones, and cue text keeps only the WebVTT
 * cue tags (c, i, b, u, v, lang, ruby, rt and timestamps). Everything else that
 * looks like markup is escaped, so a track can never carry HTML.
 */

export const MAX_VTT_BYTES = 512 * 1024;
export const MAX_CUES = 5000;
export const MAX_CUE_TEXT = 1000;

export interface Cue {
  /** Seconds. */
  start: number;
  end: number;
  text: string;
  id?: string;
  settings?: string;
}

export class VttError extends Error {
  constructor(
    message: string,
    public line?: number,
  ) {
    super(message);
  }
}

const TIME = /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/;
const ALLOWED_TAGS = new Set(['c', 'i', 'b', 'u', 'v', 'lang', 'ruby', 'rt']);
const SETTING =
  /^(vertical:(rl|lr)|line:-?\d+(\.\d+)?%?(,(start|center|end))?|position:\d+(\.\d+)?%(,(line-left|center|line-right))?|size:\d+(\.\d+)?%|align:(start|center|end|left|right))$/;

export function parseTime(s: string): number | null {
  const m = TIME.exec(s);
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

export function formatTime(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms % 1000, 3)}`;
}

/**
 * Keep WebVTT cue tags, escape everything else. Character references are kept
 * when they are valid, and a bare "&" becomes "&amp;". "-->" can't appear in a
 * cue payload, so it is escaped too.
 */
export function sanitizeCueText(text: string): string {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '');
  const out = lines
    .join('\n')
    .replace(/&(?!(amp|lt|gt|nbsp|lrm|rlm|#\d{1,7}|#x[0-9a-fA-F]{1,6});)/g, '&amp;')
    .replace(/<([^<>\n]*)>|<|>/g, (whole, inner: string | undefined) => {
      if (inner === undefined) return whole === '<' ? '&lt;' : '&gt;';
      if (TIME.test(inner)) return whole;
      const m = /^(\/?)([a-z]+)((?:\.[\w-]+)*)(?:[ \t]+([^<>&"]*))?$/.exec(inner);
      if (!m || !ALLOWED_TAGS.has(m[2]!)) return `&lt;${inner.replace(/>/g, '&gt;')}&gt;`;
      const [, close, name, classes, annotation] = m;
      if (close) return `</${name}>`;
      // Only v and lang carry an annotation (speaker name, language tag).
      const note = (name === 'v' || name === 'lang') && annotation?.trim() ? ` ${annotation.trim()}` : '';
      return `<${name}${classes}${note}>`;
    })
    .replace(/-->/g, '--&gt;');
  return out.slice(0, MAX_CUE_TEXT);
}

/** Decode the few character references a caption editor shows as text. */
export function decodeCueText(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function sanitizeSettings(raw: string): string | undefined {
  const kept = raw
    .split(/[ \t]+/)
    .filter((s) => SETTING.test(s))
    .join(' ');
  return kept || undefined;
}

/**
 * Parse a WebVTT file. Throws VttError (with a line number where it helps) when
 * the file isn't well-formed. Returned cue text is already sanitized.
 */
export function parseVtt(input: string | Buffer): Cue[] {
  if (Buffer.isBuffer(input)) {
    if (input.length > MAX_VTT_BYTES) throw new VttError('Caption files can be up to 512 KB.');
    input = new TextDecoder('utf-8', { fatal: false }).decode(input);
  } else if (Buffer.byteLength(input) > MAX_VTT_BYTES) throw new VttError('Caption files can be up to 512 KB.');
  if (input.includes('\u0000')) throw new VttError('This file is not a text file.');
  const lines = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  if (!/^WEBVTT([ \t].*)?$/.test(lines[0] ?? '')) throw new VttError('A WebVTT file must start with "WEBVTT".', 1);

  const cues: Cue[] = [];
  let i = 1;
  // The header runs until the first blank line.
  while (i < lines.length && lines[i]!.trim() !== '') {
    if (lines[i]!.includes('-->')) throw new VttError('Leave a blank line after the WEBVTT header.', i + 1);
    i++;
  }
  while (i < lines.length) {
    while (i < lines.length && lines[i]!.trim() === '') i++;
    if (i >= lines.length) break;
    const blockStart = i;
    const block: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== '') block.push(lines[i++]!);
    const first = block[0]!;
    if (/^(NOTE|STYLE|REGION)([ \t]|$)/.test(first) && !first.includes('-->')) continue;
    let t = 0;
    let id: string | undefined;
    if (!first.includes('-->')) {
      id = first.trim().slice(0, 100);
      t = 1;
    }
    const timing = block[t];
    if (!timing?.includes('-->')) throw new VttError('Each cue needs a timing line like "00:00:01.000 --> 00:00:04.000".', blockStart + t + 1);
    const m = /^(\S+)[ \t]+-->[ \t]+(\S+)(?:[ \t]+(.*))?$/.exec(timing.trim());
    const start = m ? parseTime(m[1]!) : null;
    const end = m ? parseTime(m[2]!) : null;
    if (start === null || end === null) throw new VttError('This timing line is not valid WebVTT.', blockStart + t + 1);
    if (end <= start) throw new VttError('A cue must end after it starts.', blockStart + t + 1);
    const text = sanitizeCueText(block.slice(t + 1).join('\n'));
    if (block.slice(t + 1).some((l) => l.includes('-->'))) throw new VttError('Leave a blank line between cues.', blockStart + t + 2);
    if (!text) continue;
    cues.push({ start, end, text, id, settings: m![3] ? sanitizeSettings(m![3]) : undefined });
    if (cues.length > MAX_CUES) throw new VttError(`A track can have up to ${MAX_CUES} cues.`);
  }
  return cues;
}

/** Serialize cues to a WebVTT file. Cue text is sanitized again on the way out. */
export function serializeVtt(cues: Cue[]): string {
  const blocks = [...cues]
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .map((c) => {
      const head = c.id && !c.id.includes('-->') ? `${c.id.replace(/\n/g, ' ')}\n` : '';
      const settings = c.settings ? sanitizeSettings(c.settings) : undefined;
      return `${head}${formatTime(c.start)} --> ${formatTime(c.end)}${settings ? ` ${settings}` : ''}\n${sanitizeCueText(c.text)}`;
    })
    .filter((b) => !b.endsWith('\n'));
  return `WEBVTT\n\n${blocks.join('\n\n')}${blocks.length ? '\n' : ''}`;
}
