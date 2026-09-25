import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Cue } from './captions.js';

/**
 * The Edit Decision List (EDL): a small, versioned RECIPE applied to an unchanged source file at render time. Nothing here ever touches
 * the source media. Pure module (no I/O); every rule has a unit test in edl.unit.test.ts.
 *
 *  - `segments`: the parts of the SOURCE that are kept, in playback order. A "cut" is simply a gap between two segments; a "trim" is a
 *    first segment that starts late / a last segment that ends early. An empty list means "the whole source".
 *  - `aspect` + `cropX`: centre-weighted crop to a target aspect ratio. `cropX` (0..1) moves the crop window horizontally.
 *  - `thumbnail`: a moment (OUTPUT timeline, ms) whose frame becomes the poster of the rendered video.
 *  - `captions`: which caption track to use, and whether it is burned into the picture ("open captions").
 */
export const EDL_VERSION = 1 as const;
export const MAX_SEGMENTS = 200;
export const MIN_SEGMENT_MS = 200;
export const ASPECTS = ['1:1', '4:5', '9:16', '16:9'] as const;
export type Aspect = (typeof ASPECTS)[number];
export const ASPECT_RATIO: Record<Aspect, number> = {
  '1:1': 1,
  '4:5': 4 / 5,
  '9:16': 9 / 16,
  '16:9': 16 / 9,
};

export const segmentSchema = z
  .object({ startMs: z.number().int().min(0), endMs: z.number().int().min(1) })
  .strict();
export const edlSchema = z
  .object({
    version: z.literal(EDL_VERSION),
    segments: z.array(segmentSchema).max(MAX_SEGMENTS),
    aspect: z.enum(ASPECTS).nullable(),
    cropX: z.number().min(0).max(1).optional(),
    thumbnail: z
      .object({ atMs: z.number().int().min(0) })
      .strict()
      .nullable(),
    captions: z
      .object({ lang: z.string().trim().min(2).max(12), burnIn: z.boolean() })
      .strict()
      .nullable(),
  })
  .strict();
export type Edl = z.infer<typeof edlSchema>;
export type Segment = z.infer<typeof segmentSchema>;

export const emptyEdl = (): Edl => ({
  version: EDL_VERSION,
  segments: [],
  aspect: null,
  thumbnail: null,
  captions: null,
});

export interface EdlIssue {
  path: string;
  message: string;
}

/** What the source looks like; needed to check the recipe against reality. */
export interface SourceInfo {
  durationMs: number;
  kind: 'video' | 'audio';
}

/** The segments actually used: an empty list means the whole source. */
export function effectiveSegments(edl: Edl, source: Pick<SourceInfo, 'durationMs'>): Segment[] {
  return edl.segments.length ? edl.segments : [{ startMs: 0, endMs: source.durationMs }];
}

export const outputDurationMs = (edl: Edl, source: Pick<SourceInfo, 'durationMs'>): number =>
  effectiveSegments(edl, source).reduce((n, s) => n + (s.endMs - s.startMs), 0);

/** Semantic validation on top of the shape: bounds, order, overlaps, minimum length, applicability to the source kind. */
export function validateEdl(
  input: unknown,
  source: SourceInfo,
): { ok: true; edl: Edl } | { ok: false; issues: EdlIssue[] } {
  const parsed = edlSchema.safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    };
  const edl = parsed.data;
  const issues: EdlIssue[] = [];
  let prevEnd = -1;
  edl.segments.forEach((s, i) => {
    const at = `segments.${i}`;
    if (s.endMs <= s.startMs)
      issues.push({ path: at, message: 'A segment must end after it starts' });
    else if (s.endMs - s.startMs < MIN_SEGMENT_MS)
      issues.push({ path: at, message: `A segment must be at least ${MIN_SEGMENT_MS} ms long` });
    if (s.endMs > source.durationMs)
      issues.push({
        path: `${at}.endMs`,
        message: `The source is only ${source.durationMs} ms long`,
      });
    if (s.startMs < prevEnd)
      issues.push({ path: at, message: 'Segments must be in source order and must not overlap' });
    prevEnd = Math.max(prevEnd, s.endMs);
  });
  if (source.kind === 'audio' && edl.aspect)
    issues.push({ path: 'aspect', message: 'Aspect crop only applies to video' });
  if (source.kind === 'audio' && edl.captions?.burnIn)
    issues.push({ path: 'captions.burnIn', message: 'Captions can only be burned into video' });
  if (edl.cropX !== undefined && !edl.aspect)
    issues.push({ path: 'cropX', message: 'cropX needs an aspect' });
  if (edl.thumbnail && source.kind === 'audio')
    issues.push({ path: 'thumbnail', message: 'Thumbnails only apply to video' });
  if (!issues.length && edl.thumbnail && edl.thumbnail.atMs >= outputDurationMs(edl, source))
    issues.push({
      path: 'thumbnail.atMs',
      message: 'The thumbnail moment is after the end of the edited video',
    });
  return issues.length ? { ok: false, issues } : { ok: true, edl };
}

/** True when rendering would change nothing (no segments, no crop, no burn-in): the source itself can be published. */
export function isIdentity(edl: Edl, source: Pick<SourceInfo, 'durationMs'>): boolean {
  const segs = edl.segments;
  const whole =
    segs.length === 0 ||
    (segs.length === 1 && segs[0]!.startMs === 0 && segs[0]!.endMs >= source.durationMs);
  return whole && !edl.aspect && !edl.captions?.burnIn && !edl.thumbnail;
}

/** Stable content hash of the recipe (key order independent). Binds renders and publications to an exact edit. */
export function edlHash(edl: Edl): string {
  const c = {
    v: edl.version,
    s: edl.segments.map((x) => [x.startMs, x.endMs]),
    a: edl.aspect,
    x: edl.aspect ? (edl.cropX ?? 0.5) : null,
    t: edl.thumbnail?.atMs ?? null,
    c: edl.captions ? [edl.captions.lang.toLowerCase(), edl.captions.burnIn] : null,
  };
  return createHash('sha256').update(JSON.stringify(c)).digest('hex');
}

// ------------------------------------------------------------------ editing helpers (all return NEW recipes)
/** Keep only [startMs, endMs) of the source (a trim of both ends). Segments outside it are dropped, partial ones clipped. */
export function trim(
  edl: Edl,
  source: Pick<SourceInfo, 'durationMs'>,
  startMs: number,
  endMs: number,
): Edl {
  const kept: Segment[] = [];
  for (const s of effectiveSegments(edl, source)) {
    const a = Math.max(s.startMs, startMs);
    const b = Math.min(s.endMs, endMs);
    if (b - a >= MIN_SEGMENT_MS) kept.push({ startMs: a, endMs: b });
  }
  return { ...edl, segments: kept };
}

/** Remove [startMs, endMs) of the source from the middle. Splits the segment that contains it. */
export function cut(
  edl: Edl,
  source: Pick<SourceInfo, 'durationMs'>,
  startMs: number,
  endMs: number,
): Edl {
  const out: Segment[] = [];
  for (const s of effectiveSegments(edl, source)) {
    if (endMs <= s.startMs || startMs >= s.endMs) {
      out.push(s);
      continue;
    }
    if (startMs - s.startMs >= MIN_SEGMENT_MS) out.push({ startMs: s.startMs, endMs: startMs });
    if (s.endMs - endMs >= MIN_SEGMENT_MS) out.push({ startMs: endMs, endMs: s.endMs });
  }
  return { ...edl, segments: out };
}

/** Cut several ranges at once (used to apply an accepted silence suggestion). */
export const cutMany = (
  edl: Edl,
  source: Pick<SourceInfo, 'durationMs'>,
  ranges: Array<{ startMs: number; endMs: number }>,
): Edl =>
  [...ranges]
    .sort((a, b) => a.startMs - b.startMs)
    .reduce((e, r) => cut(e, source, r.startMs, r.endMs), edl);

// ------------------------------------------------------------------ timeline mapping
/** Source time -> output time, or null when that moment was cut. */
export function sourceToOutput(
  edl: Edl,
  source: Pick<SourceInfo, 'durationMs'>,
  ms: number,
): number | null {
  let acc = 0;
  for (const s of effectiveSegments(edl, source)) {
    if (ms >= s.startMs && ms < s.endMs) return acc + (ms - s.startMs);
    acc += s.endMs - s.startMs;
  }
  return null;
}

export type { Cue };

/**
 * Re-time caption cues from the SOURCE timeline onto the OUTPUT timeline. Cues wholly inside cut material disappear; cues that straddle a cut
 * are clipped to what remains (a cue spanning several kept segments is split, one piece per segment). Pieces shorter than 200 ms are dropped.
 */
export function remapCues(cues: Cue[], edl: Edl, source: Pick<SourceInfo, 'durationMs'>): Cue[] {
  const out: Cue[] = [];
  let offset = 0;
  for (const seg of effectiveSegments(edl, source)) {
    for (const c of cues) {
      const a = Math.max(c.startMs, seg.startMs);
      const b = Math.min(c.endMs, seg.endMs);
      if (b - a >= MIN_SEGMENT_MS)
        out.push({
          startMs: offset + (a - seg.startMs),
          endMs: offset + (b - seg.startMs),
          text: c.text,
        });
    }
    offset += seg.endMs - seg.startMs;
  }
  return out.sort((x, y) => x.startMs - y.startMs || x.endMs - y.endMs);
}
