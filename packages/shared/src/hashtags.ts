/**
 * Hashtags: "#" followed by 2–40 letters, digits or underscores, in any
 * script. Not matched inside words or URLs ("a#b", "page.html#top").
 */
const HASHTAG = /(^|[^\p{L}\p{N}_&/#])#([\p{L}\p{M}\p{N}_]{2,40})(?![\p{L}\p{M}\p{N}_])/gu;

/** Normalised tag: lower case, no "#". */
export function normalizeTag(tag: string): string {
  return tag.replace(/^#/, '').normalize('NFC').toLocaleLowerCase('und');
}

/** Distinct hashtags in a text, normalised, in order of appearance. */
export function extractHashtags(text: string | null | undefined, max = 10): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const m of text.matchAll(HASHTAG)) {
    const tag = normalizeTag(m[2]!);
    if (/^\d+$/.test(tag) || out.includes(tag)) continue; // "#1" is a number, not a tag
    out.push(tag);
    if (out.length >= max) break;
  }
  return out;
}

/** Text split into plain parts and hashtags, for rendering tags as links. */
export function splitHashtags(text: string): ({ text: string } | { tag: string; text: string })[] {
  const parts: ({ text: string } | { tag: string; text: string })[] = [];
  let last = 0;
  for (const m of text.matchAll(HASHTAG)) {
    const start = m.index! + m[1]!.length;
    if (/^\d+$/.test(m[2]!)) continue;
    if (start > last) parts.push({ text: text.slice(last, start) });
    parts.push({ tag: normalizeTag(m[2]!), text: `#${m[2]}` });
    last = start + 1 + m[2]!.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
