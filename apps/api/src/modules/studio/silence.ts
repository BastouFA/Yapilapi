/**
 * Silence heuristics from ffmpeg's `silencedetect` filter (pure parts: output parsing and turning silences into cut / highlight proposals).
 * These are HEURISTICS on the audio level: they do not understand speech. Proposals are shown to the creator and never applied automatically.
 */
export interface Range {
  startMs: number;
  endMs: number;
}

/** Parse ffmpeg stderr lines `silence_start: 1.23` / `silence_end: 2.5 | silence_duration: 1.27`. A trailing open silence ends at `durationMs`. */
export function parseSilenceDetect(stderr: string, durationMs: number): Range[] {
  const out: Range[] = [];
  let open: number | null = null;
  for (const line of stderr.split('\n')) {
    const s = /silence_start:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (s) {
      open = Math.max(0, Math.round(Number(s[1]) * 1000));
      continue;
    }
    const e = /silence_end:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (e && open !== null) {
      const end = Math.min(durationMs, Math.round(Number(e[1]) * 1000));
      if (end > open) out.push({ startMs: open, endMs: end });
      open = null;
    }
  }
  if (open !== null && durationMs > open) out.push({ startMs: open, endMs: durationMs });
  return out;
}

export interface CutOptions {
  /** Silences shorter than this are left alone (natural pauses). */
  minSilenceMs?: number;
  /** Silence kept on each side of a cut so speech is not clipped and the cut does not sound abrupt. */
  padMs?: number;
}

/** Turn detected silences into ranges to CUT: each is shrunk by `padMs` on both sides; ones that would be empty or tiny are dropped. */
export function silenceCuts(silences: Range[], opts: CutOptions = {}): Range[] {
  const min = opts.minSilenceMs ?? 800;
  const pad = opts.padMs ?? 150;
  return silences
    .filter((r) => r.endMs - r.startMs >= min)
    .map((r) => ({ startMs: r.startMs + pad, endMs: r.endMs - pad }))
    .filter((r) => r.endMs - r.startMs >= 300)
    .sort((a, b) => a.startMs - b.startMs);
}

/** The complement of the silences: stretches with sound, longest first. Used for "highlights": where something is actually happening. */
export function soundSpans(silences: Range[], durationMs: number): Range[] {
  const spans: Range[] = [];
  let at = 0;
  for (const s of [...silences].sort((a, b) => a.startMs - b.startMs)) {
    if (s.startMs > at) spans.push({ startMs: at, endMs: s.startMs });
    at = Math.max(at, s.endMs);
  }
  if (durationMs > at) spans.push({ startMs: at, endMs: durationMs });
  return spans.filter((r) => r.endMs - r.startMs >= 1000);
}

export interface Highlight extends Range {
  score: number;
  reason: string;
}

/** Up to `max` candidate clips: the longest uninterrupted sound spans, capped at `maxClipMs`. The score is only a ranking among these candidates. */
export function highlightCandidates(
  silences: Range[],
  durationMs: number,
  max = 3,
  maxClipMs = 30_000,
): Highlight[] {
  return soundSpans(silences, durationMs)
    .sort((a, b) => b.endMs - b.startMs - (a.endMs - a.startMs))
    .slice(0, max)
    .map((r) => ({
      startMs: r.startMs,
      endMs: Math.min(r.endMs, r.startMs + maxClipMs),
      score: Math.round(((r.endMs - r.startMs) / Math.max(1, durationMs)) * 100) / 100,
      reason: 'Longest stretch without silence',
    }))
    .sort((a, b) => a.startMs - b.startMs);
}

/** Thumbnail candidates: moments in the first sound spans (something is happening), spread across the video. Times are SOURCE ms. */
export function thumbnailMoments(silences: Range[], durationMs: number, count = 3): number[] {
  const spans = soundSpans(silences, durationMs);
  const base = spans.length ? spans : [{ startMs: 0, endMs: durationMs }];
  const total = base.reduce((n, r) => n + (r.endMs - r.startMs), 0);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    let target = ((i + 0.5) / count) * total;
    for (const r of base) {
      const len = r.endMs - r.startMs;
      if (target < len) {
        out.push(Math.min(durationMs - 1, r.startMs + Math.round(target)));
        break;
      }
      target -= len;
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}
