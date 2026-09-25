import { contentWords } from './knowledge.js';

/**
 * Deterministic extractive summariser: picks the most representative sentences (by word frequency) and keeps their original
 * order. It never adds words that are not in the source, so a summary is grounded by construction. The DEV provider uses it;
 * real providers do abstractive summaries under the same untrusted-data rules.
 */
export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function extractiveSummary(
  text: string,
  opts: { maxSentences?: number; maxChars?: number } = {},
): string {
  const sentences = splitSentences(text);
  if (sentences.length === 0) return '';
  const max = opts.maxSentences ?? 3;
  if (sentences.length <= max) return clamp(sentences.join(' '), opts.maxChars ?? 900);
  const freq = new Map<string, number>();
  for (const s of sentences) for (const w of contentWords(s)) freq.set(w, (freq.get(w) ?? 0) + 1);
  const scored = sentences.map((s, i) => {
    const ws = contentWords(s);
    const score = ws.length
      ? ws.reduce((n, w) => n + (freq.get(w) ?? 0), 0) / Math.sqrt(ws.length)
      : 0;
    return { s, i, score: score + (i === 0 ? 0.5 : 0) };
  });
  const top = [...scored]
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .sort((a, b) => a.i - b.i);
  return clamp(top.map((t) => t.s).join(' '), opts.maxChars ?? 900);
}

const clamp = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
