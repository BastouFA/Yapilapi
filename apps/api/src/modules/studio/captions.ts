/**
 * Caption cues: parse / validate / serialise WebVTT and SRT, plus review heuristics. Pure (no I/O), unit tested in captions.unit.test.ts.
 * The stored form is always a validated array of cues, so the render step and the media module's WebVTT sidecar are generated from
 * one source of truth.
 */
export interface Cue {
  startMs: number;
  endMs: number;
  text: string;
}

export const MAX_CUES = 5000;
export const MAX_CUE_TEXT = 500;
export const MAX_CAPTION_BYTES = 512 * 1024;
export const LANG_TAG = /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8}){0,3}$/;

export interface CueIssue {
  index: number | null;
  message: string;
}

/** C0 control characters except TAB (0x09), LF (0x0A) and CR (0x0D): U+0000-0008, 000B, 000C, 000E-001F. */
function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f))
      return true;
  }
  return false;
}

/** Validation of an in-memory cue list (what the API accepts as JSON, and what parsers produce). */
export function validateCues(cues: Cue[]): CueIssue[] {
  const issues: CueIssue[] = [];
  if (cues.length === 0) return [{ index: null, message: 'There are no cues' }];
  if (cues.length > MAX_CUES)
    return [{ index: null, message: `At most ${MAX_CUES} cues are supported` }];
  let prevStart = -1;
  cues.forEach((c, i) => {
    if (!Number.isInteger(c.startMs) || !Number.isInteger(c.endMs) || c.startMs < 0)
      issues.push({ index: i, message: 'Times must be whole milliseconds, zero or later' });
    else if (c.endMs <= c.startMs)
      issues.push({ index: i, message: 'A cue must end after it starts' });
    if (c.startMs < prevStart) issues.push({ index: i, message: 'Cues must be in time order' });
    prevStart = Math.max(prevStart, c.startMs);
    const text = c.text.trim();
    if (!text) issues.push({ index: i, message: 'A cue needs text' });
    if (c.text.length > MAX_CUE_TEXT)
      issues.push({ index: i, message: `A cue may have at most ${MAX_CUE_TEXT} characters` });
    if (c.text.includes('-->')) issues.push({ index: i, message: 'Cue text cannot contain "-->"' });
    if (hasControlChars(c.text))
      issues.push({ index: i, message: 'Cue text contains control characters' });
  });
  return issues;
}

// ------------------------------------------------------------------ timestamps
const pad = (n: number, w: number) => String(n).padStart(w, '0');
export function formatTimestamp(ms: number, sep: '.' | ','): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}${sep}${pad(ms % 1000, 3)}`;
}

const TS = String.raw`(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})`;
const TIMING = new RegExp(`^\\s*${TS}\\s*-->\\s*${TS}(?:\\s.*)?$`);
function ts(h: string | undefined, m: string, s: string, f: string): number {
  return ((Number(h ?? 0) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(f.padEnd(3, '0'));
}

export type ParseResult = { ok: true; cues: Cue[] } | { ok: false; error: string; line?: number };

function normalise(input: string): string | null {
  if (Buffer.byteLength(input, 'utf8') > MAX_CAPTION_BYTES) return null;
  return input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

/** Shared block parser for WebVTT and SRT (they only differ in header, cue ids and the decimal separator). */
function parseBlocks(text: string, firstLine: number): ParseResult {
  const lines = text.split('\n');
  const cues: Cue[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.includes('-->')) {
      i++;
      continue;
    }
    const m = TIMING.exec(line);
    if (!m)
      return {
        ok: false,
        error: `Invalid cue timing on line ${i + firstLine}`,
        line: i + firstLine,
      };
    const startMs = ts(m[1], m[2]!, m[3]!, m[4]!);
    const endMs = ts(m[5], m[6]!, m[7]!, m[8]!);
    const body: string[] = [];
    i++;
    while (i < lines.length && lines[i]!.trim() !== '') {
      if (lines[i]!.includes('-->')) break;
      body.push(lines[i]!);
      i++;
    }
    // WebVTT cue text may carry inline tags (<b>, <c.x>, <00:00:01.000>): keep the words, drop the markup.
    const textOut = body
      .join('\n')
      .replace(/<[^>]*>/g, '')
      .trim();
    cues.push({ startMs, endMs, text: textOut });
    if (cues.length > MAX_CUES)
      return { ok: false, error: `At most ${MAX_CUES} cues are supported` };
  }
  return { ok: true, cues };
}

export function parseVtt(input: string): ParseResult {
  const text = normalise(input);
  if (text === null) return { ok: false, error: 'The caption file is too large' };
  if (text.includes('\0'))
    return { ok: false, error: 'The caption file contains invalid characters' };
  if (!/^WEBVTT(?:[ \t].*)?(?:\n|$)/.test(text))
    return { ok: false, error: 'Not a WebVTT file: it must start with WEBVTT', line: 1 };
  // NOTE/STYLE/REGION blocks contain no timings; they are skipped by the block parser.
  return parseBlocks(text, 1);
}

export function parseSrt(input: string): ParseResult {
  const text = normalise(input);
  if (text === null) return { ok: false, error: 'The caption file is too large' };
  if (text.includes('\0'))
    return { ok: false, error: 'The caption file contains invalid characters' };
  if (/^WEBVTT/.test(text)) return { ok: false, error: 'This looks like WebVTT, not SRT' };
  return parseBlocks(text, 1);
}

/** Parse and validate in one step: what the import endpoints call. */
export function importCaptions(
  format: 'vtt' | 'srt',
  input: string,
): { ok: true; cues: Cue[] } | { ok: false; error: string; line?: number; issues?: CueIssue[] } {
  const r = format === 'vtt' ? parseVtt(input) : parseSrt(input);
  if (!r.ok) return r;
  const issues = validateCues(r.cues);
  return issues.length
    ? {
        ok: false,
        error: issues[0]!.message,
        ...(issues[0]!.index !== null ? { line: issues[0]!.index + 1 } : {}),
        issues,
      }
    : r;
}

const safeText = (t: string) =>
  t
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n{2,}/g, '\n');

export function toVtt(cues: Cue[]): string {
  return `WEBVTT\n\n${cues.map((c) => `${formatTimestamp(c.startMs, '.')} --> ${formatTimestamp(c.endMs, '.')}\n${safeText(c.text.trim())}`).join('\n\n')}\n`;
}

export function toSrt(cues: Cue[]): string {
  return `${cues.map((c, i) => `${i + 1}\n${formatTimestamp(c.startMs, ',')} --> ${formatTimestamp(c.endMs, ',')}\n${c.text.trim().replace(/\n{2,}/g, '\n')}`).join('\n\n')}\n`;
}

// ------------------------------------------------------------------ review heuristics (used by the "captions_review" suggestion)
export interface CaptionFinding {
  index: number;
  code: 'too_fast' | 'too_short' | 'too_long_line' | 'overlap' | 'too_many_lines';
  message: string;
}
export const MAX_CPS = 20;
export const MAX_LINE_CHARS = 42;

export function reviewCues(cues: Cue[]): CaptionFinding[] {
  const out: CaptionFinding[] = [];
  cues.forEach((c, i) => {
    const dur = c.endMs - c.startMs;
    const chars = c.text.replace(/\s+/g, ' ').trim().length;
    if (dur > 0 && (chars / dur) * 1000 > MAX_CPS)
      out.push({
        index: i,
        code: 'too_fast',
        message: `${Math.round((chars / dur) * 1000)} characters per second is hard to read (aim for ${MAX_CPS} or fewer)`,
      });
    if (dur < 700) out.push({ index: i, code: 'too_short', message: 'On screen for under 0.7 s' });
    const lines = c.text.split('\n');
    if (lines.some((l) => l.length > MAX_LINE_CHARS))
      out.push({
        index: i,
        code: 'too_long_line',
        message: `A line has more than ${MAX_LINE_CHARS} characters`,
      });
    if (lines.length > 2)
      out.push({ index: i, code: 'too_many_lines', message: 'More than two lines' });
    const next = cues[i + 1];
    if (next && next.startMs < c.endMs)
      out.push({ index: i, code: 'overlap', message: 'Overlaps the next cue' });
  });
  return out;
}
