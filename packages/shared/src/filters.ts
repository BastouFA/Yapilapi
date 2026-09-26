import { z } from 'zod';

/**
 * Photo and video looks for the editor, shared by the web app, the phone app and the API.
 *
 * Every look and every colour adjustment is a chain of standard CSS filter functions
 * (brightness, contrast, saturate, sepia, grayscale, hue-rotate). The web previews the
 * chain as a CSS `filter`; the server folds the same chain into one colour matrix with the
 * formulas from the Filter Effects spec and applies it with sharp (recomb) for photos and
 * ffmpeg (colorchannelmixer + lutrgb) for videos, so what you see is what gets posted.
 * Vignette and sharpen are spatial, so they sit outside the chain: a radial gradient with
 * the same geometry everywhere, and a light unsharp mask.
 */

export const FILTER_IDS = ['original', 'warm', 'cool', 'vivid', 'fade', 'mono', 'noir', 'golden', 'lagos', 'sahara', 'ocean', 'vintage'] as const;
export type FilterId = (typeof FILTER_IDS)[number];

export const ADJUSTMENT_KEYS = ['brightness', 'contrast', 'saturation', 'warmth', 'fade', 'vignette', 'sharpen'] as const;
export type AdjustmentKey = (typeof ADJUSTMENT_KEYS)[number];
export type Adjustments = Record<AdjustmentKey, number>;

/** Slider ranges. Brightness, contrast, saturation and warmth are centred on 0. */
export const ADJUSTMENT_RANGES: Record<AdjustmentKey, { min: number; max: number }> = {
  brightness: { min: -100, max: 100 },
  contrast: { min: -100, max: 100 },
  saturation: { min: -100, max: 100 },
  warmth: { min: -100, max: 100 },
  fade: { min: 0, max: 100 },
  vignette: { min: 0, max: 100 },
  sharpen: { min: 0, max: 100 },
};

export const NEUTRAL_ADJUSTMENTS: Adjustments = { brightness: 0, contrast: 0, saturation: 0, warmth: 0, fade: 0, vignette: 0, sharpen: 0 };

/** One CSS filter function. hue-rotate is in degrees; the rest are CSS amounts (1 = unchanged for brightness, contrast, saturate). */
export type FilterOp = readonly ['brightness' | 'contrast' | 'saturate' | 'sepia' | 'grayscale' | 'hue-rotate', number];

export interface FilterPreset {
  id: FilterId;
  /** English name; apps translate it where they have a catalog. */
  name: string;
  ops: readonly FilterOp[];
  /** Adjustments the look adds under the person's own (a vignette, a little fade). */
  extra?: Partial<Adjustments>;
}

/** A cool cast: sepia applied in the opposite hue, then turned back, tints towards blue. */
const coolTint = (amount: number): FilterOp[] => [
  ['hue-rotate', 180],
  ['sepia', amount],
  ['hue-rotate', -180],
];

export const FILTERS: readonly FilterPreset[] = [
  { id: 'original', name: 'Original', ops: [] },
  {
    id: 'warm',
    name: 'Warm',
    ops: [
      ['sepia', 0.22],
      ['saturate', 1.2],
      ['brightness', 1.03],
    ],
  },
  { id: 'cool', name: 'Cool', ops: [...coolTint(0.22), ['saturate', 1.1], ['contrast', 1.03]] },
  {
    id: 'vivid',
    name: 'Vivid',
    ops: [
      ['saturate', 1.45],
      ['contrast', 1.12],
      ['brightness', 1.02],
    ],
  },
  {
    id: 'fade',
    name: 'Fade',
    ops: [
      ['contrast', 0.8],
      ['brightness', 1.1],
      ['saturate', 0.75],
    ],
  },
  {
    id: 'mono',
    name: 'Mono',
    ops: [
      ['grayscale', 1],
      ['contrast', 1.05],
    ],
  },
  {
    id: 'noir',
    name: 'Noir',
    ops: [
      ['grayscale', 1],
      ['contrast', 1.45],
      ['brightness', 0.92],
    ],
    extra: { vignette: 35 },
  },
  {
    id: 'golden',
    name: 'Golden',
    ops: [
      ['sepia', 0.35],
      ['saturate', 1.45],
      ['hue-rotate', -8],
      ['brightness', 1.05],
    ],
  },
  {
    id: 'lagos',
    name: 'Lagos',
    ops: [
      ['saturate', 1.35],
      ['contrast', 1.12],
      ['sepia', 0.15],
      ['hue-rotate', -5],
      ['brightness', 1.04],
    ],
  },
  {
    id: 'sahara',
    name: 'Sahara',
    ops: [
      ['sepia', 0.45],
      ['saturate', 1.15],
      ['contrast', 0.92],
      ['brightness', 1.08],
    ],
    extra: { fade: 15 },
  },
  { id: 'ocean', name: 'Ocean', ops: [...coolTint(0.3), ['saturate', 1.25], ['contrast', 1.06], ['hue-rotate', -10]] },
  {
    id: 'vintage',
    name: 'Vintage',
    ops: [
      ['sepia', 0.4],
      ['contrast', 0.88],
      ['brightness', 1.08],
      ['saturate', 0.85],
    ],
    extra: { fade: 20, vignette: 30 },
  },
];

export const filterPreset = (id: FilterId | string | null | undefined): FilterPreset => FILTERS.find((f) => f.id === id) ?? FILTERS[0]!;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** The person's adjustments plus the look's own extras, each kept in range. */
export function effectiveAdjustments(filter: FilterId | string, adjustments: Partial<Adjustments> = {}): Adjustments {
  const extra = filterPreset(filter).extra ?? {};
  const out = { ...NEUTRAL_ADJUSTMENTS };
  for (const k of ADJUSTMENT_KEYS) out[k] = clamp((adjustments[k] ?? 0) + (extra[k] ?? 0), ADJUSTMENT_RANGES[k].min, ADJUSTMENT_RANGES[k].max);
  return out;
}

/** The colour adjustments as CSS filter functions (vignette and sharpen are not colour). */
function adjustmentOps(a: Adjustments): FilterOp[] {
  const ops: FilterOp[] = [];
  if (a.brightness) ops.push(['brightness', 1 + (a.brightness / 100) * 0.4]);
  if (a.contrast) ops.push(['contrast', 1 + (a.contrast / 100) * 0.5]);
  if (a.saturation) ops.push(['saturate', 1 + a.saturation / 100]);
  if (a.warmth > 0) ops.push(['sepia', (a.warmth / 100) * 0.3], ['saturate', 1 + (a.warmth / 100) * 0.2]);
  if (a.warmth < 0) ops.push(...coolTint((-a.warmth / 100) * 0.3), ['saturate', 1 + (-a.warmth / 100) * 0.2]);
  if (a.fade) {
    // Lift the blacks and keep the whites: contrast, then the brightness that puts white back at 1.
    const c = 1 - (a.fade / 100) * 0.4;
    ops.push(['contrast', c], ['brightness', 2 / (1 + c)], ['saturate', 1 - (a.fade / 100) * 0.25]);
  }
  return ops;
}

/** The whole colour chain for a look plus adjustments. */
export function filterOps(filter: FilterId | string, adjustments: Partial<Adjustments> = {}): FilterOp[] {
  return [...filterPreset(filter).ops, ...adjustmentOps(effectiveAdjustments(filter, adjustments))];
}

const cssOp = ([name, v]: FilterOp) => (name === 'hue-rotate' ? `hue-rotate(${round3(v)}deg)` : `${name}(${round3(v)})`);

/** A CSS `filter` value for live previews on the web. "none" when nothing changes. */
export function cssFilter(filter: FilterId | string, adjustments: Partial<Adjustments> = {}): string {
  const ops = filterOps(filter, adjustments);
  return ops.length ? ops.map(cssOp).join(' ') : 'none';
}

/** A 3×3 colour matrix (row major) and an offset per channel, on 0–1 sRGB values: out = m·rgb + o. */
export interface ColorMatrix {
  m: [number, number, number, number, number, number, number, number, number];
  o: [number, number, number];
}

export const IDENTITY_MATRIX: ColorMatrix = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], o: [0, 0, 0] };

/** The Filter Effects spec's matrix for one CSS filter function. */
function opMatrix([name, v]: FilterOp): ColorMatrix {
  switch (name) {
    case 'brightness':
      return { m: [v, 0, 0, 0, v, 0, 0, 0, v], o: [0, 0, 0] };
    case 'contrast': {
      const o = 0.5 - 0.5 * v;
      return { m: [v, 0, 0, 0, v, 0, 0, 0, v], o: [o, o, o] };
    }
    case 'saturate':
      return {
        m: [
          0.213 + 0.787 * v,
          0.715 - 0.715 * v,
          0.072 - 0.072 * v,
          0.213 - 0.213 * v,
          0.715 + 0.285 * v,
          0.072 - 0.072 * v,
          0.213 - 0.213 * v,
          0.715 - 0.715 * v,
          0.072 + 0.928 * v,
        ],
        o: [0, 0, 0],
      };
    case 'grayscale': {
      const a = 1 - clamp(v, 0, 1);
      return {
        m: [
          0.2126 + 0.7874 * a,
          0.7152 - 0.7152 * a,
          0.0722 - 0.0722 * a,
          0.2126 - 0.2126 * a,
          0.7152 + 0.2848 * a,
          0.0722 - 0.0722 * a,
          0.2126 - 0.2126 * a,
          0.7152 - 0.7152 * a,
          0.0722 + 0.9278 * a,
        ],
        o: [0, 0, 0],
      };
    }
    case 'sepia': {
      const a = 1 - clamp(v, 0, 1);
      return {
        m: [
          0.393 + 0.607 * a,
          0.769 - 0.769 * a,
          0.189 - 0.189 * a,
          0.349 - 0.349 * a,
          0.686 + 0.314 * a,
          0.168 - 0.168 * a,
          0.272 - 0.272 * a,
          0.534 - 0.534 * a,
          0.131 + 0.869 * a,
        ],
        o: [0, 0, 0],
      };
    }
    case 'hue-rotate': {
      const r = (v * Math.PI) / 180;
      const c = Math.cos(r);
      const s = Math.sin(r);
      return {
        m: [
          0.213 + c * 0.787 - s * 0.213,
          0.715 - c * 0.715 - s * 0.715,
          0.072 - c * 0.072 + s * 0.928,
          0.213 - c * 0.213 + s * 0.143,
          0.715 + c * 0.285 + s * 0.14,
          0.072 - c * 0.072 - s * 0.283,
          0.213 - c * 0.213 - s * 0.787,
          0.715 - c * 0.715 + s * 0.715,
          0.072 + c * 0.928 + s * 0.072,
        ],
        o: [0, 0, 0],
      };
    }
  }
}

/** Apply `next` after `prev`. */
function compose(prev: ColorMatrix, next: ColorMatrix): ColorMatrix {
  const a = next.m;
  const b = prev.m;
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0] as ColorMatrix['m'];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) m[r * 3 + c] = a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!;
  const o = [0, 1, 2].map((r) => a[r * 3]! * prev.o[0] + a[r * 3 + 1]! * prev.o[1] + a[r * 3 + 2]! * prev.o[2] + next.o[r]!) as ColorMatrix['o'];
  return { m, o };
}

/** The colour chain folded into one matrix, for sharp, ffmpeg and canvas. */
export function colorMatrix(filter: FilterId | string, adjustments: Partial<Adjustments> = {}): ColorMatrix {
  return filterOps(filter, adjustments).reduce((acc, op) => compose(acc, opMatrix(op)), IDENTITY_MATRIX);
}

export function isIdentityMatrix(cm: ColorMatrix, eps = 1e-4): boolean {
  return cm.m.every((v, i) => Math.abs(v - IDENTITY_MATRIX.m[i]!) < eps) && cm.o.every((v) => Math.abs(v) < eps);
}

/** Apply a colour matrix to RGBA pixels in place (canvas ImageData). */
export function applyColorMatrix(data: Uint8ClampedArray | Uint8Array, cm: ColorMatrix, channels = 4): void {
  const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = cm.m;
  const o0 = cm.o[0] * 255;
  const o1 = cm.o[1] * 255;
  const o2 = cm.o[2] * 255;
  const clip = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v + 0.5) | 0;
  for (let i = 0; i < data.length; i += channels) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    data[i] = clip(m0 * r + m1 * g + m2 * b + o0);
    data[i + 1] = clip(m3 * r + m4 * g + m5 * b + o1);
    data[i + 2] = clip(m6 * r + m7 * g + m8 * b + o2);
  }
}

/**
 * The vignette as a radial gradient: an ellipse through the corners, clear up to
 * VIGNETTE_INNER of the way out, then darkening to `alpha` black at the corners.
 * CSS: radial-gradient(ellipse farthest-corner at center, transparent 45%, rgba(0,0,0,alpha) 100%).
 */
export const VIGNETTE_INNER = 0.45;
export const vignetteAlpha = (a: Adjustments) => round3((a.vignette / 100) * 0.65);
export const vignetteCss = (alpha: number) =>
  alpha > 0 ? `radial-gradient(ellipse farthest-corner at center, rgba(0,0,0,0) ${VIGNETTE_INNER * 100}%, rgba(0,0,0,${alpha}) 100%)` : 'none';

/** Sharpen strength, 0–1: the amount of a light unsharp mask. */
export const sharpenAmount = (a: Adjustments) => round3(a.sharpen / 100);

// ─── Text on photos and videos ─────────────────────────────────────────

export const TEXT_FONTS = ['clean', 'bold', 'mono'] as const;
export type TextFont = (typeof TEXT_FONTS)[number];
/** CSS for each font. The API draws videos and phone photos with the same families (Inter and JetBrains Mono, bundled). */
export const TEXT_FONT_CSS: Record<TextFont, { family: string; weight: number; name: string }> = {
  clean: { family: "Inter, 'Figtree', system-ui, sans-serif", weight: 400, name: 'Clean' },
  bold: { family: "Inter, 'Figtree', system-ui, sans-serif", weight: 700, name: 'Bold' },
  mono: { family: "'JetBrains Mono', ui-monospace, monospace", weight: 400, name: 'Typewriter' },
};

export const TEXT_COLORS = ['#FFFFFF', '#111111', '#FFD60A', '#FF5A5F', '#3FA9F5', '#34C759'] as const;
export const TEXT_COLOR_NAMES: Record<(typeof TEXT_COLORS)[number], string> = {
  '#FFFFFF': 'White',
  '#111111': 'Black',
  '#FFD60A': 'Yellow',
  '#FF5A5F': 'Coral',
  '#3FA9F5': 'Blue',
  '#34C759': 'Green',
};
/** The box behind text, when on: dark behind light text, light behind black text. */
export const textBoxColor = (color: string) => (color === '#111111' ? 'rgba(255,255,255,0.75)' : 'rgba(0,0,0,0.55)');
export const MAX_TEXT_LENGTH = 100;

// ─── Edit request ──────────────────────────────────────────────────────

const unit = z.number().finite().min(0).max(1);
const signed = z.number().finite().min(-100).max(100);
const positive = z.number().finite().min(0).max(100);

export const textOverlaySchema = z.object({
  value: z
    .string()
    .transform((s) => s.replace(/[\r\n\t]+/g, ' ').trim())
    .pipe(z.string().min(1, 'Add some text, or remove the text.').max(MAX_TEXT_LENGTH, `Text can be up to ${MAX_TEXT_LENGTH} characters.`)),
  font: z.enum(TEXT_FONTS).default('bold'),
  color: z.enum(TEXT_COLORS).default('#FFFFFF'),
  /** Where the middle of the text sits, as a fraction of the width and height. */
  x: unit.default(0.5),
  y: unit.default(0.5),
  /** Font size as a fraction of the width. */
  size: z.number().finite().min(0.02).max(0.25).default(0.07),
  background: z.boolean().default(false),
});
export type TextOverlay = z.infer<typeof textOverlaySchema>;

export const cropSchema = z
  .object({ x: unit, y: unit, w: z.number().finite().min(0.02).max(1), h: z.number().finite().min(0.02).max(1) })
  .refine((c) => c.x + c.w <= 1.0001 && c.y + c.h <= 1.0001, 'The crop must stay inside the picture.');

/** POST /v1/media/:id/edit. Trim, mute and cover apply to videos only. */
export const mediaEditSchema = z
  .object({
    filter: z.enum(FILTER_IDS).default('original'),
    adjustments: z
      .object({
        brightness: signed.optional(),
        contrast: signed.optional(),
        saturation: signed.optional(),
        warmth: signed.optional(),
        fade: positive.optional(),
        vignette: positive.optional(),
        sharpen: positive.optional(),
      })
      .strict()
      .default({}),
    /** Turns are applied first, then flips, then the crop (in the turned picture's coordinates). */
    rotate: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0),
    flipH: z.boolean().default(false),
    flipV: z.boolean().default(false),
    crop: cropSchema.optional(),
    trim: z
      .object({ startMs: z.number().int().min(0), endMs: z.number().int().positive() })
      .refine((t) => t.endMs - t.startMs >= 1000, { message: 'Keep at least 1 second.', path: ['endMs'] })
      .optional(),
    muted: z.boolean().default(false),
    coverMs: z.number().int().min(0).optional(),
    text: textOverlaySchema.optional(),
  })
  .strict();
export type EditorParamsInput = z.input<typeof mediaEditSchema>;
export type EditorParams = z.infer<typeof mediaEditSchema>;
