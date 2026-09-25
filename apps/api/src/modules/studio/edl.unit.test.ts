import { describe, expect, it } from 'vitest';
import {
  cut,
  cutMany,
  edlHash,
  effectiveSegments,
  emptyEdl,
  isIdentity,
  outputDurationMs,
  remapCues,
  sourceToOutput,
  trim,
  validateEdl,
  type Edl,
} from './edl.js';

const src = { durationMs: 10_000, kind: 'video' as const };
const withSegs = (segments: Array<[number, number]>): Edl => ({
  ...emptyEdl(),
  segments: segments.map(([startMs, endMs]) => ({ startMs, endMs })),
});

describe('EDL validation', () => {
  it('accepts the empty recipe and a normal one', () => {
    expect(validateEdl(emptyEdl(), src).ok).toBe(true);
    const r = validateEdl(
      {
        ...withSegs([
          [0, 2000],
          [3000, 9000],
        ]),
        aspect: '9:16',
        cropX: 0.3,
        thumbnail: { atMs: 500 },
        captions: { lang: 'en', burnIn: true },
      },
      src,
    );
    expect(r.ok).toBe(true);
  });
  it('rejects unknown keys, wrong versions and bad shapes', () => {
    expect(validateEdl({ ...emptyEdl(), version: 2 }, src).ok).toBe(false);
    expect(validateEdl({ ...emptyEdl(), extra: 1 }, src).ok).toBe(false);
    expect(validateEdl({ ...emptyEdl(), segments: [{ startMs: -1, endMs: 5 }] }, src).ok).toBe(
      false,
    );
    expect(validateEdl({ ...emptyEdl(), aspect: '3:2' }, src).ok).toBe(false);
    expect(validateEdl('nope', src).ok).toBe(false);
  });
  it('checks segments against the source: bounds, order, overlap, minimum length', () => {
    const bad = (segs: Array<[number, number]>) => {
      const r = validateEdl(withSegs(segs), src);
      return r.ok ? [] : r.issues.map((i) => i.message);
    };
    expect(bad([[0, 12_000]])[0]).toMatch(/only 10000 ms/);
    expect(bad([[5000, 5000]])[0]).toMatch(/end after/);
    expect(bad([[0, 100]])[0]).toMatch(/at least 200/);
    expect(
      bad([
        [4000, 6000],
        [1000, 2000],
      ])[0],
    ).toMatch(/order/);
    expect(
      bad([
        [0, 3000],
        [2000, 4000],
      ])[0],
    ).toMatch(/overlap/);
    expect(
      bad([
        [0, 3000],
        [3000, 4000],
      ]),
    ).toEqual([]);
    expect(
      validateEdl(
        {
          ...emptyEdl(),
          segments: Array.from({ length: 201 }, (_, i) => ({ startMs: i * 10, endMs: i * 10 + 5 })),
        },
        { durationMs: 100_000, kind: 'video' },
      ).ok,
    ).toBe(false);
  });
  it('checks applicability: audio has no crop/burn-in/thumbnail; cropX needs an aspect; thumbnail must be inside the output', () => {
    const audio = { durationMs: 10_000, kind: 'audio' as const };
    expect(validateEdl({ ...emptyEdl(), aspect: '1:1' }, audio).ok).toBe(false);
    expect(validateEdl({ ...emptyEdl(), captions: { lang: 'en', burnIn: true } }, audio).ok).toBe(
      false,
    );
    expect(validateEdl({ ...emptyEdl(), captions: { lang: 'en', burnIn: false } }, audio).ok).toBe(
      true,
    );
    expect(validateEdl({ ...emptyEdl(), cropX: 0.2 }, src).ok).toBe(false);
    expect(validateEdl({ ...withSegs([[0, 2000]]), thumbnail: { atMs: 2000 } }, src).ok).toBe(
      false,
    ); // output is only 2 s
    expect(validateEdl({ ...withSegs([[0, 2000]]), thumbnail: { atMs: 1999 } }, src).ok).toBe(true);
  });
});

describe('EDL editing is non-destructive and composable', () => {
  it('trim clips both ends; cut splits; cutMany applies several ranges', () => {
    expect(trim(emptyEdl(), src, 1000, 8000).segments).toEqual([{ startMs: 1000, endMs: 8000 }]);
    expect(cut(emptyEdl(), src, 2000, 4000).segments).toEqual([
      { startMs: 0, endMs: 2000 },
      { startMs: 4000, endMs: 10_000 },
    ]);
    expect(cut(withSegs([[0, 5000]]), src, 0, 1000).segments).toEqual([
      { startMs: 1000, endMs: 5000 },
    ]);
    expect(cut(withSegs([[0, 5000]]), src, 4900, 5000).segments).toEqual([
      { startMs: 0, endMs: 4900 },
    ]);
    expect(
      cutMany(emptyEdl(), src, [
        { startMs: 6000, endMs: 7000 },
        { startMs: 1000, endMs: 2000 },
      ]).segments,
    ).toEqual([
      { startMs: 0, endMs: 1000 },
      { startMs: 2000, endMs: 6000 },
      { startMs: 7000, endMs: 10_000 },
    ]);
    const original = emptyEdl();
    cut(original, src, 1000, 2000);
    expect(original.segments).toEqual([]); // input untouched
    expect(cut(emptyEdl(), src, 0, 10_000).segments).toEqual([]); // cutting everything leaves nothing (caller must refuse an empty result)
  });
  it('durations and identity', () => {
    expect(outputDurationMs(emptyEdl(), src)).toBe(10_000);
    expect(
      outputDurationMs(
        withSegs([
          [0, 2000],
          [5000, 6500],
        ]),
        src,
      ),
    ).toBe(3500);
    expect(effectiveSegments(emptyEdl(), src)).toEqual([{ startMs: 0, endMs: 10_000 }]);
    expect(isIdentity(emptyEdl(), src)).toBe(true);
    expect(isIdentity(withSegs([[0, 10_000]]), src)).toBe(true);
    expect(isIdentity(withSegs([[0, 9000]]), src)).toBe(false);
    expect(isIdentity({ ...emptyEdl(), aspect: '1:1' }, src)).toBe(false);
    expect(isIdentity({ ...emptyEdl(), captions: { lang: 'en', burnIn: false } }, src)).toBe(true); // sidecar captions do not change the picture
  });
  it('hash is stable and sensitive to every recipe field', () => {
    const a = withSegs([[0, 2000]]);
    expect(edlHash(a)).toBe(edlHash({ ...a }));
    expect(edlHash(a)).toBe(edlHash({ ...a, cropX: 0.9 })); // cropX without an aspect does not change the render
    const variants: Edl[] = [
      withSegs([[0, 2001]]),
      { ...a, aspect: '1:1' },
      { ...a, aspect: '1:1', cropX: 0.1 },
      { ...a, thumbnail: { atMs: 1 } },
      { ...a, captions: { lang: 'en', burnIn: false } },
      { ...a, captions: { lang: 'en', burnIn: true } },
    ];
    const hashes = new Set([edlHash(a), ...variants.map(edlHash)]);
    expect(hashes.size).toBe(variants.length + 1);
    expect(edlHash({ ...a, captions: { lang: 'EN', burnIn: true } })).toBe(
      edlHash({ ...a, captions: { lang: 'en', burnIn: true } }),
    );
  });
});

describe('timeline mapping', () => {
  const edl = withSegs([
    [1000, 3000],
    [5000, 6000],
  ]);
  it('maps source time to output time and null for cut material', () => {
    expect(sourceToOutput(edl, src, 1000)).toBe(0);
    expect(sourceToOutput(edl, src, 2500)).toBe(1500);
    expect(sourceToOutput(edl, src, 3000)).toBeNull();
    expect(sourceToOutput(edl, src, 5500)).toBe(2500);
    expect(sourceToOutput(edl, src, 9000)).toBeNull();
  });
  it('re-times captions: drops cut cues, clips straddling ones, splits across segments', () => {
    const cues = [
      { startMs: 0, endMs: 900, text: 'gone' }, // before the first segment
      { startMs: 1200, endMs: 2000, text: 'kept' },
      { startMs: 2800, endMs: 3600, text: 'clipped' }, // straddles the cut after 3000
      { startMs: 3200, endMs: 4800, text: 'cut' },
      { startMs: 2500, endMs: 5400, text: 'spans' }, // spans the cut: two pieces
    ];
    const out = remapCues(cues, edl, src);
    expect(out.map((c) => c.text)).toEqual(['kept', 'spans', 'clipped', 'spans']);
    expect(out.find((c) => c.text === 'kept')).toMatchObject({ startMs: 200, endMs: 1000 });
    expect(out.filter((c) => c.text === 'spans')).toEqual([
      { startMs: 1500, endMs: 2000, text: 'spans' },
      { startMs: 2000, endMs: 2400, text: 'spans' },
    ]);
    expect(out.find((c) => c.text === 'clipped')).toMatchObject({ startMs: 1800, endMs: 2000 });
    for (const c of out) expect(c.endMs).toBeLessThanOrEqual(outputDurationMs(edl, src));
  });
});
