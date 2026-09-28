import { describe, expect, it } from 'vitest';
import {
  COVER_MAX_ZOOM,
  COVER_RATIO,
  coverCropRatio,
  coverLayout,
  coverRatioOk,
  coverZoom,
  defaultCoverRecipe,
  fitCoverCrop,
  flipCoverCrop,
  moveCoverCrop,
  roundCrop,
  straightenScale,
  turnCoverRecipe,
  turnedSize,
  zoomCoverCrop,
  type CoverCrop,
} from './cover.ts';
import { colorMatrix, cssFilter, effectiveAdjustments, isIdentityMatrix, scaleFilterOps } from './filters.ts';
import { coverEditSchema, setCoverSchema } from './schemas.ts';

const inside = (c: CoverCrop) => c.x >= 0 && c.y >= 0 && c.x + c.w <= 1.00001 && c.y + c.h <= 1.00001;

describe('cover crop maths', () => {
  it('fits the widest centred cover in wide and tall pictures', () => {
    const wide = fitCoverCrop(4000, 1000);
    expect(wide.h).toBe(1);
    expect(wide.x).toBeCloseTo((1 - wide.w) / 2, 4);
    expect(coverCropRatio(wide, 4000, 1000)).toBeCloseTo(COVER_RATIO, 3);

    const tall = fitCoverCrop(1200, 1600);
    expect(tall.w).toBe(1);
    expect(tall.y).toBeCloseTo((1 - tall.h) / 2, 4);
    expect(coverCropRatio(tall, 1200, 1600)).toBeCloseTo(COVER_RATIO, 3);
    expect(coverRatioOk(tall, 1200, 1600)).toBe(true);
  });

  it('checks the shape within the tolerance', () => {
    const c = fitCoverCrop(3000, 2000);
    expect(coverRatioOk(c, 3000, 2000)).toBe(true);
    // 1% off is rounding; 5% off is a different shape.
    expect(coverRatioOk({ ...c, h: c.h * 1.01 }, 3000, 2000)).toBe(true);
    expect(coverRatioOk({ ...c, h: c.h * 1.05 }, 3000, 2000)).toBe(false);
    expect(coverRatioOk({ x: 0, y: 0, w: 1, h: 1 }, 3000, 2000)).toBe(false);
    expect(coverRatioOk(c, 0, 2000)).toBe(false);
  });

  it('zooms around the centre and keeps the crop inside the picture and in shape', () => {
    const W = 3000;
    const H = 2000;
    const fit = fitCoverCrop(W, H);
    const in2 = zoomCoverCrop(fit, W, H, 2);
    expect(in2.w).toBeCloseTo(fit.w / 2, 4);
    expect(in2.x + in2.w / 2).toBeCloseTo(0.5, 4);
    expect(in2.y + in2.h / 2).toBeCloseTo(0.5, 4);
    expect(coverZoom(in2, W, H)).toBeCloseTo(2, 3);
    expect(coverRatioOk(in2, W, H)).toBe(true);
    // Past the limits it stops.
    expect(coverZoom(zoomCoverCrop(fit, W, H, 99), W, H)).toBeCloseTo(COVER_MAX_ZOOM, 3);
    const out = zoomCoverCrop(in2, W, H, 0.2);
    for (const k of ['x', 'y', 'w', 'h'] as const) expect(out[k]).toBeCloseTo(fit[k], 4);
    // Zooming out from a corner stays inside.
    const corner = moveCoverCrop(zoomCoverCrop(fit, W, H, 3), 1, 1);
    expect(inside(corner)).toBe(true);
    expect(corner.x + corner.w).toBeCloseTo(1, 4);
    expect(inside(zoomCoverCrop(corner, W, H, 1.2))).toBe(true);
  });

  it('moves and mirrors the crop without leaving the picture', () => {
    const c = zoomCoverCrop(fitCoverCrop(2000, 2000), 2000, 2000, 2);
    expect(moveCoverCrop(c, -5, 0).x).toBe(0);
    expect(moveCoverCrop(c, 0, 5).y + c.h).toBeCloseTo(1, 4);
    const moved = moveCoverCrop(c, 0.1, 0);
    const mirrored = flipCoverCrop(moved, 'h');
    expect(mirrored.x).toBeCloseTo(1 - moved.x - moved.w, 4);
    expect(flipCoverCrop(mirrored, 'h')).toEqual(moved);
    expect(roundCrop({ x: -0.2, y: 0.95, w: 0.5, h: 0.2 })).toEqual({ x: 0, y: 0.8, w: 0.5, h: 0.2 });
  });

  it('enlarges a straightened picture just enough to cover its frame', () => {
    expect(straightenScale(3000, 2000, 0)).toBe(1);
    // A square turned 45°: the diagonal.
    expect(straightenScale(1000, 1000, 45)).toBeCloseTo(Math.SQRT2, 6);
    // Same either way, and more for longer pictures.
    expect(straightenScale(3000, 1000, -10)).toBeCloseTo(straightenScale(3000, 1000, 10), 9);
    expect(straightenScale(3000, 1000, 10)).toBeGreaterThan(straightenScale(1000, 1000, 10));
    // Every corner of the frame, turned back, lands inside the enlarged picture.
    const W = 1600;
    const H = 900;
    for (const deg of [3, -7.5, 20, 45]) {
      const s = straightenScale(W, H, deg);
      const a = (-deg * Math.PI) / 180;
      for (const [x, y] of [
        [W / 2, H / 2],
        [-W / 2, H / 2],
      ]) {
        const rx = x! * Math.cos(a) - y! * Math.sin(a);
        const ry = x! * Math.sin(a) + y! * Math.cos(a);
        expect(Math.abs(rx)).toBeLessThanOrEqual((s * W) / 2 + 1e-6);
        expect(Math.abs(ry)).toBeLessThanOrEqual((s * H) / 2 + 1e-6);
      }
    }
  });

  it('lays out the picture so the crop fills the cover', () => {
    const crop = { x: 0.25, y: 0.1, w: 0.5, h: 0.3 };
    const l = coverLayout(crop, 800);
    expect(l.width).toBe(1600);
    expect(l.left).toBe(-400);
    expect(l.height).toBeCloseTo(800 / COVER_RATIO / 0.3, 6);
    expect(l.top).toBeCloseTo(-0.1 * l.height, 6);
  });

  it('turns a recipe a quarter and refits the crop to the new shape', () => {
    const r = defaultCoverRecipe(3000, 2000);
    expect(r).toMatchObject({ filter: 'original', filterStrength: 100, rotate: 0, straighten: 0 });
    const turned = turnCoverRecipe(r, 3000, 2000, 1);
    expect(turned.rotate).toBe(90);
    expect(turnedSize(3000, 2000, 90)).toEqual({ W: 2000, H: 3000 });
    expect(coverRatioOk(turned.crop, 2000, 3000)).toBe(true);
    expect(turnCoverRecipe(r, 3000, 2000, -1).rotate).toBe(270);
  });
});

describe('look strength', () => {
  it('scales a look from nothing to all of it', () => {
    expect(isIdentityMatrix(colorMatrix('vivid', {}, 0))).toBe(true);
    expect(cssFilter('noir', {}, 0)).toBe('none');
    expect(colorMatrix('vivid', {}, 1)).toEqual(colorMatrix('vivid'));
    expect(scaleFilterOps([['saturate', 1.5]], 0.5)).toEqual([['saturate', 1.25]]);
    expect(scaleFilterOps([['sepia', 0.4]], 0.5)).toEqual([['sepia', 0.2]]);
    // The look's own vignette scales too; your adjustments don't.
    expect(effectiveAdjustments('noir', { vignette: 10 }, 0.5).vignette).toBe(10 + 35 * 0.5);
    expect(effectiveAdjustments('original', { brightness: 20 }, 0).brightness).toBe(20);
  });
});

describe('cover edit schema', () => {
  const crop = fitCoverCrop(3000, 2000);
  it('fills in defaults and keeps to the editor’s ranges', () => {
    const r = coverEditSchema.parse({ crop });
    expect(r).toEqual({ filter: 'original', adjustments: {}, rotate: 0, flipH: false, flipV: false, filterStrength: 100, straighten: 0, crop });
    expect(coverEditSchema.safeParse({ crop, straighten: 50 }).success).toBe(false);
    expect(coverEditSchema.safeParse({ crop, filterStrength: 101 }).success).toBe(false);
    expect(coverEditSchema.safeParse({ crop, filter: 'sparkly' }).success).toBe(false);
    expect(coverEditSchema.safeParse({ crop, adjustments: { brightness: 300 } }).success).toBe(false);
    expect(coverEditSchema.safeParse({ crop, rotate: 45 }).success).toBe(false);
  });
  it('needs a crop inside the picture, and takes no text or video options', () => {
    expect(coverEditSchema.safeParse({}).success).toBe(false);
    expect(coverEditSchema.safeParse({ crop: { x: 0.6, y: 0, w: 0.6, h: 0.5 } }).success).toBe(false);
    expect(coverEditSchema.safeParse({ crop, text: { value: 'Hi' } }).success).toBe(false);
    expect(coverEditSchema.safeParse({ crop, trim: { startMs: 0, endMs: 2000 } }).success).toBe(false);
    expect(setCoverSchema.safeParse({ mediaId: '00000000-0000-4000-8000-000000000000', edit: { crop } }).success).toBe(true);
  });
});
