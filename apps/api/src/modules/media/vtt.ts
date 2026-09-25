/** WebVTT validation for caption/subtitle uploads (pure, unit tested). */

export const MAX_VTT_BYTES = 512 * 1024;
const MAX_CUES = 5000;
const TS = String.raw`(?:\d{2,}:)?[0-5]\d:[0-5]\d\.\d{3}`;
const TIMING = new RegExp(`^(${TS})[ \\t]+-->[ \\t]+(${TS})(?:[ \\t].*)?$`);

export function parseVttTimestamp(t: string): number {
  const parts = t.split(':');
  const [secs, ms] = parts.pop()!.split('.');
  const mins = Number(parts.pop());
  const hours = parts.length ? Number(parts.pop()) : 0;
  return ((hours * 60 + mins) * 60 + Number(secs)) * 1000 + Number(ms);
}

export interface VttResult {
  ok: boolean;
  cues: number;
  error?: string;
  /** Normalised content: BOM removed, CRLF -> LF. */
  content?: string;
}

export function validateVtt(input: string): VttResult {
  if (Buffer.byteLength(input, 'utf8') > MAX_VTT_BYTES)
    return { ok: false, cues: 0, error: 'Caption file is too large' };
  if (input.includes('\0'))
    return { ok: false, cues: 0, error: 'Caption file contains invalid characters' };
  const text = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const header = lines[0] ?? '';
  if (!/^WEBVTT(?:[ \t].*)?$/.test(header))
    return { ok: false, cues: 0, error: 'Not a WebVTT file: it must start with WEBVTT' };
  let cues = 0;
  let prevStart = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.includes('-->')) continue;
    const m = TIMING.exec(line);
    if (!m) return { ok: false, cues, error: `Invalid cue timing on line ${i + 1}` };
    const start = parseVttTimestamp(m[1]!);
    const end = parseVttTimestamp(m[2]!);
    if (end <= start)
      return { ok: false, cues, error: `Cue on line ${i + 1} ends before it starts` };
    if (start < prevStart)
      return { ok: false, cues, error: `Cue on line ${i + 1} is out of order` };
    prevStart = start;
    if (++cues > MAX_CUES) return { ok: false, cues, error: 'Too many cues' };
  }
  if (cues === 0) return { ok: false, cues: 0, error: 'Caption file has no cues' };
  return { ok: true, cues, content: text };
}

/** BCP-47-ish language tag, lower-cased primary subtag (e.g. en, pt-BR). */
export const LANG_RE = /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8}){0,3}$/;
