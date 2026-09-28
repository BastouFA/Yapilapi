import type { MessageKey } from './i18n.ts';
import { contrastRatio } from './profile-style.ts';

/**
 * Photo collages: 2 to 9 of your photos put together in one picture, for a post or a story.
 * Everything here is plain data and arithmetic (no zod), so the web preview, the phone preview and
 * the API's renderer (sharp) place every photo the same way: what the preview shows is what gets posted.
 *
 * A layout's cells are fractions of the canvas (0–1 from the left and the top). Grid layouts tile the
 * canvas without overlapping; scrapbook layouts scatter the photos, turned slightly, with a white print
 * edge, and may overlap.
 */

export const COLLAGE_MIN_PHOTOS = 2;
export const COLLAGE_MAX_PHOTOS = 9;
/** How far a photo can be zoomed inside its cell (1 fills the cell). */
export const COLLAGE_MAX_ZOOM = 3;

export const COLLAGE_SHAPES = ['square', 'portrait', 'story'] as const;
export type CollageShape = (typeof COLLAGE_SHAPES)[number];
/** The finished picture's size in pixels: square 1:1, portrait 4:5 and story 9:16, 2160 pixels tall. */
export const COLLAGE_SIZES: Record<CollageShape, { width: number; height: number }> = {
  square: { width: 2160, height: 2160 },
  portrait: { width: 1728, height: 2160 },
  story: { width: 1215, height: 2160 },
};

export const COLLAGE_GAPS = ['none', 'thin', 'wide'] as const;
export type CollageGap = (typeof COLLAGE_GAPS)[number];
/** Space between photos (and around the edge), as a share of the canvas's shorter side. */
export const COLLAGE_GAP_SIZE: Record<CollageGap, number> = { none: 0, thin: 0.012, wide: 0.035 };

export const COLLAGE_RADII = ['none', 'soft', 'round'] as const;
export type CollageRadius = (typeof COLLAGE_RADII)[number];
/** Corner rounding of each photo, as a share of the canvas's shorter side (never more than half the photo). */
export const COLLAGE_RADIUS_SIZE: Record<CollageRadius, number> = { none: 0, soft: 0.02, round: 0.06 };

/** The white print edge around scrapbook photos, as a share of the canvas's shorter side. */
export const COLLAGE_FRAME = 0.014;
export const COLLAGE_FRAME_COLOR = '#FFFFFF';

/**
 * Background colours. `ink` is black or white, whichever reads on the colour at 4.5:1 or more: the
 * previews use it for anything drawn on the background (the tick on the chosen swatch, empty cells).
 */
export const COLLAGE_BACKGROUNDS = [
  { id: 'white', hex: '#FFFFFF' },
  { id: 'paper', hex: '#F3ECE0' },
  { id: 'blush', hex: '#F4D3CD' },
  { id: 'sage', hex: '#CCDDC4' },
  { id: 'sky', hex: '#C9DDF0' },
  { id: 'sun', hex: '#F6D774' },
  { id: 'plum', hex: '#4A2548' },
  { id: 'forest', hex: '#1F3A2E' },
  { id: 'navy', hex: '#172646' },
  { id: 'black', hex: '#101114' },
] as const;
export type CollageBackground = (typeof COLLAGE_BACKGROUNDS)[number]['id'];
export const COLLAGE_BACKGROUND_IDS = COLLAGE_BACKGROUNDS.map((b) => b.id) as [CollageBackground, ...CollageBackground[]];

export const collageBackgroundHex = (id: CollageBackground): string => COLLAGE_BACKGROUNDS.find((b) => b.id === id)?.hex ?? '#FFFFFF';
/** Black or white, whichever has more contrast on this background. */
export const collageInk = (id: CollageBackground): '#000000' | '#FFFFFF' => {
  const hex = collageBackgroundHex(id);
  return contrastRatio(hex, '#000000') >= contrastRatio(hex, '#FFFFFF') ? '#000000' : '#FFFFFF';
};

/** One photo's place: fractions of the canvas, and (scrapbook) a turn in degrees, clockwise. */
export interface CollageCell {
  x: number;
  y: number;
  w: number;
  h: number;
  rotate?: number;
}

export interface CollageLayout {
  id: string;
  /** What it's called in the layout picker (and read out by screen readers). */
  name: MessageKey;
  cells: CollageCell[];
  /** Scattered, turned photos with a print edge; the gap setting doesn't apply. */
  scrapbook?: boolean;
}

const third = 1 / 3;
const row = (y: number, h: number, count: number): CollageCell[] => Array.from({ length: count }, (_, i) => ({ x: i / count, y, w: 1 / count, h }));
const column = (x: number, w: number, count: number, y = 0, h = 1): CollageCell[] =>
  Array.from({ length: count }, (_, i) => ({ x, y: y + (i * h) / count, w, h: h / count }));
const grid = (cols: number, rows: number): CollageCell[] => Array.from({ length: rows }, (_, r) => row(r / rows, 1 / rows, cols)).flat();

const GRIDS: CollageLayout[] = [
  { id: 'side-by-side', name: 'collage.layout.sideBySide', cells: column(0, 0.5, 1).concat(column(0.5, 0.5, 1)) },
  { id: 'stacked', name: 'collage.layout.stacked', cells: row(0, 0.5, 1).concat(row(0.5, 0.5, 1)) },
  { id: 'big-left-2', name: 'collage.layout.bigLeftTwo', cells: [{ x: 0, y: 0, w: 2 * third, h: 1 }, ...column(2 * third, third, 2)] },
  { id: 'big-top-2', name: 'collage.layout.bigTopTwo', cells: [{ x: 0, y: 0, w: 1, h: 0.6 }, ...row(0.6, 0.4, 2)] },
  { id: 'columns-3', name: 'collage.layout.columnsThree', cells: grid(3, 1) },
  { id: 'grid-4', name: 'collage.layout.gridFour', cells: grid(2, 2) },
  { id: 'big-left-3', name: 'collage.layout.bigLeftThree', cells: [{ x: 0, y: 0, w: 2 * third, h: 1 }, ...column(2 * third, third, 3)] },
  { id: 'strips-4', name: 'collage.layout.stripsFour', cells: grid(1, 4) },
  { id: 'two-three', name: 'collage.layout.twoThree', cells: [...row(0, 0.5, 2), ...row(0.5, 0.5, 3)] },
  {
    id: 'big-left-4',
    name: 'collage.layout.bigLeftFour',
    cells: [{ x: 0, y: 0, w: 0.5, h: 1 }, ...column(0.5, 0.25, 2), ...column(0.75, 0.25, 2)],
  },
  { id: 'grid-6', name: 'collage.layout.gridSix', cells: grid(2, 3) },
  {
    id: 'big-5',
    name: 'collage.layout.bigFive',
    cells: [{ x: 0, y: 0, w: 2 * third, h: 2 * third }, ...column(2 * third, third, 2, 0, 2 * third), ...row(2 * third, third, 3)],
  },
  { id: 'big-top-6', name: 'collage.layout.bigTopSix', cells: [{ x: 0, y: 0, w: 1, h: 0.5 }, ...row(0.5, 0.25, 3), ...row(0.75, 0.25, 3)] },
  { id: 'grid-8', name: 'collage.layout.gridEight', cells: grid(2, 4) },
  { id: 'grid-9', name: 'collage.layout.gridNine', cells: grid(3, 3) },
];

// Small turns, alternating, so the scrapbook looks loose without anything falling off the page.
const TURNS = [-4, 3, -2.5, 4, -3, 2, -3.5, 2.5, -2];

/**
 * A scrapbook of `count` photos: a loose grid with each photo nudged and turned a little. Photos are
 * a bit bigger than their slot's share, so neighbours may overlap like prints on a table.
 */
function scrapbook(count: number): CollageLayout {
  const cols = count <= 2 ? 1 : count <= 4 ? 2 : 3;
  const rows = Math.ceil(count / cols);
  const w = (1 / cols) * (count <= 2 ? 0.66 : cols === 2 ? 0.76 : 0.7);
  const h = (1 / rows) * (count <= 2 ? 0.74 : 0.74);
  const cells: CollageCell[] = [];
  for (let i = 0; i < count; i++) {
    const r = Math.floor(i / cols);
    const inRow = Math.min(cols, count - r * cols);
    const c = i % cols;
    // A short last row is centred; every other photo steps a little aside (two photos) or up and down.
    const slotX = (c + (cols - inRow) / 2 + 0.5) / cols;
    const slotY = (r + 0.5) / rows;
    const step = i % 2 ? 1 : -1;
    const dx = count <= 2 ? step * 0.1 : 0;
    const dy = count <= 2 ? 0 : step * 0.01;
    cells.push({ x: round(slotX - w / 2 + dx), y: round(slotY - h / 2 + dy), w: round(w), h: round(h), rotate: TURNS[i % TURNS.length] });
  }
  return { id: `scrapbook-${count}`, name: 'collage.layout.scrapbook', cells, scrapbook: true };
}

const round = (v: number) => Math.round(v * 10000) / 10000;

export const COLLAGE_LAYOUTS: CollageLayout[] = [
  ...GRIDS,
  ...Array.from({ length: COLLAGE_MAX_PHOTOS - COLLAGE_MIN_PHOTOS + 1 }, (_, i) => scrapbook(i + COLLAGE_MIN_PHOTOS)),
];
export const COLLAGE_LAYOUT_IDS = COLLAGE_LAYOUTS.map((l) => l.id) as [string, ...string[]];

export const collageLayout = (id: string): CollageLayout | undefined => COLLAGE_LAYOUTS.find((l) => l.id === id);
/** The layouts for exactly this many photos, grids first. */
export const collageLayoutsFor = (count: number): CollageLayout[] => COLLAGE_LAYOUTS.filter((l) => l.cells.length === count);

/** What a collage is made of: sent to POST /v1/media/collage, drawn by the previews. */
export interface CollageCellInput {
  mediaId: string;
  /** Which part of the photo stays in view, 0–1 from the left and the top (like CSS object-position). */
  focusX: number;
  focusY: number;
  /** 1 fills the cell; up to COLLAGE_MAX_ZOOM. */
  zoom?: number;
}

export interface CollageSpec {
  layout: string;
  shape: CollageShape;
  gap: CollageGap;
  radius: CollageRadius;
  background: CollageBackground;
  /** One per cell of the layout, in the layout's order. */
  cells: CollageCellInput[];
}

export const COLLAGE_DEFAULTS = { gap: 'thin', radius: 'none', background: 'white' } as const satisfies Pick<CollageSpec, 'gap' | 'radius' | 'background'>;

/** A cell in pixels on a canvas of `width` × `height`: position, size and turn. */
export interface CellRect {
  left: number;
  top: number;
  width: number;
  height: number;
  rotate: number;
  /** Corner radius of the photo (of its print edge, on a scrapbook). */
  radius: number;
  /** Width of the white print edge (scrapbook only; 0 otherwise). The photo sits inside it. */
  frame: number;
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/**
 * Where one cell goes on a canvas of `width` × `height`, with the gap and rounding chosen. Grid gaps are
 * the same between photos and around the edge. Whole pixels, so the renderer and previews agree.
 */
export function cellRect(layout: CollageLayout, index: number, width: number, height: number, gap: CollageGap, radius: CollageRadius): CellRect {
  const c = layout.cells[index]!;
  const short = Math.min(width, height);
  const g = layout.scrapbook ? 0 : COLLAGE_GAP_SIZE[gap] * short;
  const x0 = c.x * width + (near(c.x, 0) ? g : g / 2);
  const x1 = (c.x + c.w) * width - (near(c.x + c.w, 1) ? g : g / 2);
  const y0 = c.y * height + (near(c.y, 0) ? g : g / 2);
  const y1 = (c.y + c.h) * height - (near(c.y + c.h, 1) ? g : g / 2);
  const left = Math.round(x0);
  const top = Math.round(y0);
  const w = Math.max(1, Math.round(x1) - left);
  const h = Math.max(1, Math.round(y1) - top);
  return {
    left,
    top,
    width: w,
    height: h,
    rotate: c.rotate ?? 0,
    radius: Math.round(Math.min(COLLAGE_RADIUS_SIZE[radius] * short, w / 2, h / 2)),
    frame: layout.scrapbook ? Math.max(1, Math.round(COLLAGE_FRAME * short)) : 0,
  };
}

/**
 * How a photo of `imageWidth` × `imageHeight` fills a box of `boxWidth` × `boxHeight`: scaled to cover
 * the box (times `zoom`), then placed so the focus point lines up like CSS object-position does.
 * `left` and `top` are 0 or less: where the photo's corner sits relative to the box's.
 */
export function coverBox(imageWidth: number, imageHeight: number, boxWidth: number, boxHeight: number, focusX = 0.5, focusY = 0.5, zoom = 1) {
  const z = Math.min(COLLAGE_MAX_ZOOM, Math.max(1, zoom));
  const scale = Math.max(boxWidth / Math.max(1, imageWidth), boxHeight / Math.max(1, imageHeight)) * z;
  const width = imageWidth * scale;
  const height = imageHeight * scale;
  const fx = Math.min(1, Math.max(0, focusX));
  const fy = Math.min(1, Math.max(0, focusY));
  return { width, height, left: (boxWidth - width) * fx, top: (boxHeight - height) * fy, scale };
}

/**
 * The part of the photo that shows in the box, in the photo's own pixels: what the renderer cuts out
 * before scaling it to the box.
 */
export function coverCrop(imageWidth: number, imageHeight: number, boxWidth: number, boxHeight: number, focusX = 0.5, focusY = 0.5, zoom = 1) {
  const b = coverBox(imageWidth, imageHeight, boxWidth, boxHeight, focusX, focusY, zoom);
  const width = Math.max(1, Math.min(imageWidth, Math.round(boxWidth / b.scale)));
  const height = Math.max(1, Math.min(imageHeight, Math.round(boxHeight / b.scale)));
  const left = Math.min(imageWidth - width, Math.max(0, Math.round(-b.left / b.scale)));
  const top = Math.min(imageHeight - height, Math.max(0, Math.round(-b.top / b.scale)));
  return { left, top, width, height };
}

/**
 * The focus point after dragging the photo by (dx, dy) pixels inside a box: dragging right shows more
 * of the left side, like moving a print under a window. Stays within 0–1.
 */
export function dragFocus(
  focus: { x: number; y: number },
  dx: number,
  dy: number,
  image: { width: number; height: number },
  box: { width: number; height: number },
  zoom = 1,
): { x: number; y: number } {
  const b = coverBox(image.width, image.height, box.width, box.height, focus.x, focus.y, zoom);
  const spareX = b.width - box.width;
  const spareY = b.height - box.height;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return {
    x: spareX > 0.5 ? clamp(focus.x - dx / spareX) : focus.x,
    y: spareY > 0.5 ? clamp(focus.y - dy / spareY) : focus.y,
  };
}

/** The corners of a turned cell, for checking it stays on the canvas. */
export function turnedBounds(r: Pick<CellRect, 'left' | 'top' | 'width' | 'height' | 'rotate'>) {
  const a = (Math.abs(r.rotate) * Math.PI) / 180;
  const w = r.width * Math.cos(a) + r.height * Math.sin(a);
  const h = r.width * Math.sin(a) + r.height * Math.cos(a);
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  return { left: cx - w / 2, top: cy - h / 2, right: cx + w / 2, bottom: cy + h / 2 };
}

/** A starting collage for these photos: the first layout for their number, centred, not zoomed. */
export function defaultCollage(mediaIds: string[], shape: CollageShape = 'square'): CollageSpec | null {
  const layout = collageLayoutsFor(mediaIds.length)[0];
  if (!layout) return null;
  return { layout: layout.id, shape, ...COLLAGE_DEFAULTS, cells: mediaIds.map((mediaId) => ({ mediaId, focusX: 0.5, focusY: 0.5, zoom: 1 })) };
}

/** Change layout, keeping the photos in their order (the new layout has the same number of cells). */
export function withLayout(spec: CollageSpec, layoutId: string): CollageSpec {
  const layout = collageLayout(layoutId);
  if (!layout || layout.cells.length !== spec.cells.length) return spec;
  return { ...spec, layout: layoutId };
}

/** Swap the photos in two cells (each keeps its own focus and zoom). */
export function swapCells(spec: CollageSpec, a: number, b: number): CollageSpec {
  if (a === b || !spec.cells[a] || !spec.cells[b]) return spec;
  const cells = [...spec.cells];
  [cells[a], cells[b]] = [cells[b]!, cells[a]!];
  return { ...spec, cells };
}
