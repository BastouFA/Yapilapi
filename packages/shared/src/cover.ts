import type { Adjustments, FilterId } from './filters.ts';

/**
 * Cover photos: one shape everywhere (8:3, "16:6"), so what you frame in the editor is what the
 * profile header shows on the web and on the phone. The editor keeps a recipe next to the cover
 * (the original upload, a look and how strongly, adjustments, turns, flips, a small straighten
 * and the crop), so "Edit cover" reopens the original with everything as you left it and the
 * server renders a new copy from the original each time, never from an earlier result.
 *
 * Order of operations, the same in the previews and on the server: turn, flip, straighten
 * (the picture is turned by a few degrees and enlarged just enough to leave no empty corners,
 * keeping the turned picture's size), crop, then the colour chain, sharpen and vignette.
 *
 * No zod here: the phone imports this file directly.
 */

/** Width ÷ height of every cover. */
export const COVER_RATIO = 8 / 3;
/** A crop may be this far off the shape (relative), for rounding between screen and server sizes. */
export const COVER_RATIO_TOLERANCE = 0.02;
/** How far in you can zoom: the crop's width is at least this fraction of the widest cover crop. */
export const COVER_MAX_ZOOM = 4;
/** Straighten, in degrees either way. */
export const COVER_MAX_STRAIGHTEN = 45;
/** The rendered cover's widest size, in pixels (the profile header is never wider than this at 2× density). */
export const COVER_RENDER_WIDTH = 2048;

export type CoverTurn = 0 | 90 | 180 | 270;

/** A crop as fractions of the turned, flipped and straightened picture. */
export interface CoverCrop {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** How a cover was made from its original photo. */
export interface CoverRecipe {
  filter: FilterId;
  /** How much of the look, 0–100. */
  filterStrength: number;
  adjustments: Partial<Adjustments>;
  rotate: CoverTurn;
  flipH: boolean;
  flipV: boolean;
  /** Degrees, clockwise, -45 to 45. */
  straighten: number;
  crop: CoverCrop;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round5 = (v: number) => Math.round(v * 1e5) / 1e5;

/** The picture's size after quarter turns. */
export function turnedSize(width: number, height: number, rotate: CoverTurn): { W: number; H: number } {
  return rotate === 90 || rotate === 270 ? { W: height, H: width } : { W: width, H: height };
}

/**
 * How much a W × H picture turned by `degrees` must be enlarged so it still covers a W × H frame
 * with no empty corners: the frame, turned back, has to fit inside the enlarged picture.
 */
export function straightenScale(W: number, H: number, degrees: number): number {
  if (!W || !H || !degrees) return 1;
  const a = (Math.abs(degrees) * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return Math.max(c + (H / W) * s, c + (W / H) * s);
}

/** Width ÷ height of a crop in pixels, for a W × H picture. */
export const coverCropRatio = (crop: CoverCrop, W: number, H: number) => (crop.w * W) / (crop.h * H);

/** Whether a crop has the cover's shape, within the tolerance. */
export function coverRatioOk(crop: CoverCrop, W: number, H: number, tolerance = COVER_RATIO_TOLERANCE): boolean {
  if (!W || !H || crop.w <= 0 || crop.h <= 0) return false;
  return Math.abs(coverCropRatio(crop, W, H) / COVER_RATIO - 1) <= tolerance;
}

/** The widest crop with the cover's shape, centred, in a W × H picture. */
export function fitCoverCrop(W: number, H: number): CoverCrop {
  const w = (COVER_RATIO * H) / W;
  const crop = w <= 1 ? { x: (1 - w) / 2, y: 0, w, h: 1 } : { x: 0, y: (1 - 1 / w) / 2, w: 1, h: 1 / w };
  return roundCrop(crop);
}

/** Round a crop to 5 decimals and keep it inside the picture. */
export function roundCrop(c: CoverCrop): CoverCrop {
  const w = clamp(round5(c.w), 0.02, 1);
  const h = clamp(round5(c.h), 0.02, 1);
  return { x: clamp(round5(c.x), 0, round5(1 - w)), y: clamp(round5(c.y), 0, round5(1 - h)), w, h };
}

/** How far in a crop is: 1 is the widest cover crop, up to COVER_MAX_ZOOM. */
export function coverZoom(crop: CoverCrop, W: number, H: number): number {
  return clamp(fitCoverCrop(W, H).w / crop.w, 1, COVER_MAX_ZOOM);
}

/** The crop at another zoom, keeping its centre where it can. */
export function zoomCoverCrop(crop: CoverCrop, W: number, H: number, zoom: number): CoverCrop {
  const fit = fitCoverCrop(W, H);
  const z = clamp(zoom, 1, COVER_MAX_ZOOM);
  const w = fit.w / z;
  const h = fit.h / z;
  const cx = crop.x + crop.w / 2;
  const cy = crop.y + crop.h / 2;
  return roundCrop({ x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w, h });
}

/** Move a crop by fractions of the picture, staying inside it. */
export function moveCoverCrop(crop: CoverCrop, dx: number, dy: number): CoverCrop {
  return roundCrop({ ...crop, x: clamp(crop.x + dx, 0, 1 - crop.w), y: clamp(crop.y + dy, 0, 1 - crop.h) });
}

/** A crop mirrored with a flip, so the same part of the picture stays in the frame. */
export function flipCoverCrop(crop: CoverCrop, axis: 'h' | 'v'): CoverCrop {
  return roundCrop(axis === 'h' ? { ...crop, x: 1 - crop.x - crop.w } : { ...crop, y: 1 - crop.y - crop.h });
}

/** Where to draw the whole (turned, flipped, straightened) picture so that `crop` fills a cover `viewWidth` wide. */
export function coverLayout(crop: CoverCrop, viewWidth: number): { width: number; height: number; left: number; top: number } {
  const viewHeight = viewWidth / COVER_RATIO;
  const width = viewWidth / crop.w;
  const height = viewHeight / crop.h;
  return { width, height, left: -crop.x * width, top: -crop.y * height };
}

/** A new cover from a picture of width × height: the widest centred crop, nothing else changed. */
export function defaultCoverRecipe(width: number, height: number): CoverRecipe {
  return {
    filter: 'original',
    filterStrength: 100,
    adjustments: {},
    rotate: 0,
    flipH: false,
    flipV: false,
    straighten: 0,
    crop: fitCoverCrop(width || 1, height || 1),
  };
}

/** Turn a recipe a quarter either way: the crop starts again from the widest one for the new shape. */
export function turnCoverRecipe(r: CoverRecipe, width: number, height: number, dir: 1 | -1): CoverRecipe {
  const rotate = ((((r.rotate + dir * 90) % 360) + 360) % 360) as CoverTurn;
  const { W, H } = turnedSize(width, height, rotate);
  return { ...r, rotate, crop: fitCoverCrop(W, H) };
}
