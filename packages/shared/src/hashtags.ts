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

/** @username mentions: 3–30 letters, numbers, dots or underscores, not inside an email address. */
const MENTION = /(^|[^\p{L}\p{N}_.@/])@([a-z0-9_.]{3,30})(?![a-z0-9_])/giu;

/** Distinct mentioned usernames, lower case, in order of appearance. */
export function extractMentions(text: string | null | undefined, max = 10): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const m of text.matchAll(MENTION)) {
    const name = m[2]!.replace(/\.+$/, '').toLowerCase(); // a sentence can end right after a name
    if (name.length < 3 || out.includes(name)) continue;
    out.push(name);
    if (out.length >= max) break;
  }
  return out;
}

export type RichPart = { text: string } | { tag: string; text: string } | { mention: string; text: string };

/** Text split into plain parts, #tags and @mentions, for rendering them as links. */
export function splitRichText(text: string): RichPart[] {
  const found: { start: number; end: number; part: RichPart }[] = [];
  for (const m of text.matchAll(HASHTAG)) {
    if (/^\d+$/.test(m[2]!)) continue;
    const start = m.index! + m[1]!.length;
    found.push({ start, end: start + 1 + m[2]!.length, part: { tag: normalizeTag(m[2]!), text: `#${m[2]}` } });
  }
  for (const m of text.matchAll(MENTION)) {
    const name = m[2]!.replace(/\.+$/, '');
    if (name.length < 3) continue;
    const start = m.index! + m[1]!.length;
    found.push({ start, end: start + 1 + name.length, part: { mention: name.toLowerCase(), text: `@${name}` } });
  }
  found.sort((a, b) => a.start - b.start);
  const parts: RichPart[] = [];
  let last = 0;
  for (const f of found) {
    if (f.start < last) continue;
    if (f.start > last) parts.push({ text: text.slice(last, f.start) });
    parts.push(f.part);
    last = f.end;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
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
