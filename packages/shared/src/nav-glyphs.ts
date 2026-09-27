/**
 * The primary navigation's own symbols (Pulse, Wander, Spark, Yap), drawn once as simple
 * geometry on a 24px grid so the web (SVG) and the mobile app (plain Views, no SVG library)
 * render exactly the same shapes. "You" is the person's own avatar, so it has no glyph.
 *
 * Every shape is a rounded box, a dot or a drop (a pin: a circle with a point straight down).
 * `outline` shapes are stroked (NAV_GLYPH_STROKE, rounded joins); the active variant adds a
 * soft fill behind the stroke (duotone). `solid` shapes are always filled.
 */
export const NAV_GLYPH_STROKE = 1.75;

/** Corner radii in the order top-left, top-right, bottom-right, bottom-left. */
export type GlyphRadii = number | readonly [number, number, number, number];

export type GlyphShape =
  | { kind: 'box'; x: number; y: number; w: number; h: number; r: GlyphRadii; fill: 'outline' | 'solid' }
  | { kind: 'dot'; cx: number; cy: number; d: number }
  | { kind: 'drop'; cx: number; cy: number; r: number; fill: 'outline' | 'solid' };

export type NavGlyphName = 'pulse' | 'wander' | 'spark' | 'yap';

export const NAV_GLYPHS: Record<NavGlyphName, readonly GlyphShape[]> = {
  /** Pulse: three rounded bars in a rising and falling beat (what your people are up to now). */
  pulse: [
    { kind: 'box', x: 3, y: 9.5, w: 5, h: 10.5, r: 2.5, fill: 'outline' },
    { kind: 'box', x: 9.5, y: 4, w: 5, h: 11, r: 2.5, fill: 'outline' },
    { kind: 'box', x: 16, y: 10.5, w: 5, h: 6.5, r: 2.5, fill: 'outline' },
  ],
  /** Wander: a winding dotted trail that ends at a pin. */
  wander: [
    { kind: 'dot', cx: 4, cy: 20, d: 2.3 },
    { kind: 'dot', cx: 7.8, cy: 20, d: 2.3 },
    { kind: 'dot', cx: 11.2, cy: 18.4, d: 2.3 },
    { kind: 'dot', cx: 12.3, cy: 14.9, d: 2.3 },
    { kind: 'dot', cx: 15, cy: 12.6, d: 2.3 },
    { kind: 'drop', cx: 17.75, cy: 6, r: 3.5, fill: 'outline' },
  ],
  /** Spark: the three rounded blocks of the YAPILAPI mark (apps/web/public/mark.svg). */
  spark: [
    { kind: 'box', x: 3.4, y: 3.4, w: 7.2, h: 7.2, r: 2.4, fill: 'outline' },
    { kind: 'box', x: 13.4, y: 3.4, w: 7.2, h: 7.2, r: 2.4, fill: 'outline' },
    { kind: 'box', x: 8.4, y: 12.6, w: 7.2, h: 8.4, r: 2.4, fill: 'outline' },
  ],
  /** Yap: a soft speech shape (one tighter corner is its tail) with a sound wave inside. */
  yap: [
    { kind: 'box', x: 3, y: 4.25, w: 18, h: 14.5, r: [6.5, 6.5, 6.5, 1.75], fill: 'outline' },
    { kind: 'box', x: 7.375, y: 10, w: 1.75, h: 3.5, r: 0.875, fill: 'solid' },
    { kind: 'box', x: 11.125, y: 7.75, w: 1.75, h: 8, r: 0.875, fill: 'solid' },
    { kind: 'box', x: 14.875, y: 9.25, w: 1.75, h: 5, r: 0.875, fill: 'solid' },
  ],
};

/** Glyphs that follow the reading direction and mirror in right-to-left languages. */
export const NAV_GLYPH_DIRECTIONAL: ReadonlySet<NavGlyphName> = new Set(['wander', 'yap']);

export const radii = (r: GlyphRadii): readonly [number, number, number, number] => (typeof r === 'number' ? [r, r, r, r] : r);

const n = (v: number) => Math.round(v * 1000) / 1000;

/** SVG path data for a shape (a box with its own corner radii, or a drop). Dots are drawn as circles. */
export function glyphPath(shape: Exclude<GlyphShape, { kind: 'dot' }>): string {
  if (shape.kind === 'drop') {
    const { cx, cy, r } = shape;
    const a = r / Math.SQRT2;
    return `M${n(cx)} ${n(cy + r * Math.SQRT2)}L${n(cx - a)} ${n(cy + a)}A${n(r)} ${n(r)} 0 1 1 ${n(cx + a)} ${n(cy + a)}Z`;
  }
  const { x, y, w, h } = shape;
  const [tl, tr, br, bl] = radii(shape.r);
  return (
    `M${n(x + tl)} ${n(y)}H${n(x + w - tr)}A${n(tr)} ${n(tr)} 0 0 1 ${n(x + w)} ${n(y + tr)}` +
    `V${n(y + h - br)}A${n(br)} ${n(br)} 0 0 1 ${n(x + w - br)} ${n(y + h)}` +
    `H${n(x + bl)}A${n(bl)} ${n(bl)} 0 0 1 ${n(x)} ${n(y + h - bl)}` +
    `V${n(y + tl)}A${n(tl)} ${n(tl)} 0 0 1 ${n(x + tl)} ${n(y)}Z`
  );
}

/** The ink bounds of a shape, stroke included: [left, top, right, bottom]. */
export function glyphBounds(shape: GlyphShape): [number, number, number, number] {
  const s = NAV_GLYPH_STROKE / 2;
  if (shape.kind === 'dot') return [shape.cx - shape.d / 2, shape.cy - shape.d / 2, shape.cx + shape.d / 2, shape.cy + shape.d / 2];
  const pad = shape.fill === 'outline' ? s : 0;
  if (shape.kind === 'drop') return [shape.cx - shape.r - pad, shape.cy - shape.r - pad, shape.cx + shape.r + pad, shape.cy + shape.r * Math.SQRT2 + pad];
  return [shape.x - pad, shape.y - pad, shape.x + shape.w + pad, shape.y + shape.h + pad];
}
