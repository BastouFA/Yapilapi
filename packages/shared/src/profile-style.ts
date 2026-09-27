/**
 * Profile customisation: an accent from a curated palette, a header style, which tabs show and in
 * what order, featured posts, links, pronouns and a city.
 *
 * No zod here: the mobile app imports this file directly. The request schema is in schemas.ts.
 *
 * Every accent is turned into a set of colours per theme by `profileAccentColors`, which checks
 * each text and background pair it produces and adjusts the colour until the text reaches WCAG AA
 * (4.5:1) in both light and dark. Nobody can pick a colour that makes their profile unreadable.
 */

/**
 * The accents people choose from: brand-harmonious hues, all tuned for text contrast by
 * profileAccentColors. `dark` is a brighter starting point for dark mode where the brand has one;
 * `turn` is how far (degrees of hue) the gradient travels, like the brand's crimson to orange.
 */
export const PROFILE_ACCENT_IDS = ['yapi', 'coral', 'saffron', 'leaf', 'teal', 'ocean', 'indigo', 'violet', 'orchid', 'graphite'] as const;
export type ProfileAccent = (typeof PROFILE_ACCENT_IDS)[number];
export const PROFILE_ACCENTS: readonly { id: ProfileAccent; hex: string; dark?: string; turn: number }[] = [
  { id: 'yapi', hex: '#D21D4A', dark: '#FF5C7A', turn: 28 },
  { id: 'coral', hex: '#E0592A', turn: 22 },
  { id: 'saffron', hex: '#E09A12', turn: -18 },
  { id: 'leaf', hex: '#2F9E44', turn: 40 },
  { id: 'teal', hex: '#0B9A8D', turn: 30 },
  { id: 'ocean', hex: '#1C7ED6', turn: 36 },
  { id: 'indigo', hex: '#4C5FD5', turn: 32 },
  { id: 'violet', hex: '#7A4BD6', turn: 36 },
  { id: 'orchid', hex: '#B83FB0', turn: -30 },
  { id: 'graphite', hex: '#5C6178', turn: 20 },
];
export const DEFAULT_PROFILE_ACCENT: ProfileAccent = 'yapi';

/** The band at the top: the cover photo (or a gradient when there is none), always the accent gradient, or none. */
export const PROFILE_HEADER_STYLES = ['cover', 'gradient', 'clean'] as const;
export type ProfileHeaderStyle = (typeof PROFILE_HEADER_STYLES)[number];

/** Tabs a profile can show, in their default order. At least one stays on. */
export const PROFILE_TABS = ['posts', 'reels', 'reposts', 'tagged', 'boards', 'chapters', 'shop'] as const;
export type ProfileTab = (typeof PROFILE_TABS)[number];

export const MAX_PROFILE_LINKS = 5;
export const PROFILE_LINK_LABEL_MAX = 40;
export const MAX_FEATURED_POSTS = 3;
export const PRONOUNS_MAX = 30;
export const CITY_MAX = 60;

/** How a profile looks, as the API gives it. */
export interface ProfileStyle {
  accent: ProfileAccent;
  header: ProfileHeaderStyle;
}

/** The saved tab list, cleaned: known tabs only, each once, never empty. */
export function profileTabs(saved: readonly string[] | null | undefined): ProfileTab[] {
  const known = new Set<string>(PROFILE_TABS);
  const out = [...new Set((saved ?? []).filter((t) => known.has(t)))] as ProfileTab[];
  return out.length ? out : [...PROFILE_TABS];
}

/** The saved accent, or the brand accent when it is missing or no longer offered. */
export const profileAccent = (saved: string | null | undefined): ProfileAccent =>
  (PROFILE_ACCENT_IDS as readonly string[]).includes(saved ?? '') ? (saved as ProfileAccent) : DEFAULT_PROFILE_ACCENT;

// ── Colour and contrast ─────────────────────────────────────────────────

type Rgb = [number, number, number];

/** "#RGB", "#RRGGBB" or "#RRGGBBAA" (alpha ignored) to 0–255 channels; null when it isn't a hex colour. */
export function parseHex(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const toHex = ([r, g, b]: Rgb) =>
  `#${[r, g, b]
    .map((v) =>
      Math.round(Math.min(255, Math.max(0, v)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')
    .toUpperCase()}`;

/** WCAG relative luminance (0 for black, 1 for white). */
export function luminance(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function toHsl([r, g, b]: Rgb): [number, number, number] {
  const [rr, gg, bb] = [r / 255, g / 255, b / 255];
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rr ? (gg - bb) / d + (gg < bb ? 6 : 0) : max === gg ? (bb - rr) / d + 2 : (rr - gg) / d + 4;
  return [h * 60, s, l];
}

function fromHsl(h: number, s: number, l: number): Rgb {
  const hue = (((h % 360) + 360) % 360) / 360;
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    const x = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [f(hue + 1 / 3) * 255, f(hue) * 255, f(hue - 1 / 3) * 255];
}

/** `a` mixed with `b`: `amount` 0 is all `a`, 1 is all `b`. */
export function mixHex(a: string, b: string, amount: number): string {
  const x = parseHex(a) ?? [0, 0, 0];
  const y = parseHex(b) ?? [0, 0, 0];
  const t = clamp01(amount);
  return toHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

/** Change lightness (-1 to 1) and turn the hue (degrees), keeping saturation. */
function adjust(hex: string, o: { lighten?: number; hue?: number }): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const [h, s, l] = toHsl(rgb);
  return toHex(fromHsl(h + (o.hue ?? 0), s, clamp01(l + (o.lighten ?? 0))));
}

/**
 * `fg`, made darker (on light backgrounds) or lighter (on dark ones) in small steps until it
 * reaches `min` contrast with every one of `backgrounds`. Keeps the hue; falls back to black or
 * white if no shade of it gets there. The backgrounds must all be light or all be dark.
 */
export function ensureContrast(fg: string, backgrounds: readonly string[], min = 4.5): string {
  const start = parseHex(fg) ? toHex(parseHex(fg)!) : '#000000';
  const passes = (c: string) => backgrounds.every((b) => contrastRatio(c, b) >= min);
  if (passes(start)) return start;
  const light = backgrounds.reduce((n, b) => n + luminance(b), 0) / Math.max(1, backgrounds.length) > 0.18;
  const [h, s, l0] = toHsl(parseHex(start)!);
  for (let i = 1; i <= 100; i++) {
    const l = clamp01(l0 + (light ? -i : i) * 0.01);
    const c = toHex(fromHsl(h, s, l));
    if (passes(c)) return c;
    if (l === 0 || l === 1) break;
  }
  return light ? '#000000' : '#FFFFFF';
}

/** The page colours each theme draws on (mirrors packages/design-system/tokens.json; a test keeps them in step). */
export const THEME_SURFACES = {
  light: { ground: '#F4F5FA', surface: '#FFFFFF', sunken: '#ECEEF5', ink: '#0E1020' },
  dark: { ground: '#0B0C14', surface: '#151726', sunken: '#10121E', ink: '#F2F3FA' },
} as const;
export type ThemeName = keyof typeof THEME_SURFACES;

/** One accent's colours in one theme. Same roles as the design tokens yapi, yapi-strong, on-yapi, yapi-soft and grad-end. */
export interface ProfileAccentColors {
  /** Buttons, the selected tab, links. Readable as text on the page and under `onAccent`. */
  accent: string;
  /** Text on `soft` and pressed states. */
  accentStrong: string;
  /** Text and icons on `accent`, `accentStrong` and `gradEnd` (primary buttons are a gradient of the three). */
  onAccent: string;
  /** A tint for chips and selected rows. */
  soft: string;
  /** The far end of the accent gradient. */
  gradEnd: string;
}

const cache = new Map<string, ProfileAccentColors>();

/**
 * The colours for an accent in a theme, each checked and adjusted for AA contrast:
 * `accent` and `accentStrong` as text on the page (ground and surface), `onAccent` on `accent`,
 * `accentStrong` and `gradEnd`, and `accentStrong` on `soft`.
 */
export function profileAccentColors(id: string | null | undefined, theme: ThemeName): ProfileAccentColors {
  const key = `${profileAccent(id)}:${theme}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const def = PROFILE_ACCENTS.find((a) => a.id === profileAccent(id))!;
  const s = THEME_SURFACES[theme];
  const dark = theme === 'dark';
  const base = dark ? (def.dark ?? def.hex) : def.hex;
  // Light: white text on a deep accent. Dark: the page's near-black on a bright accent.
  const onAccent = dark ? s.ground : '#FFFFFF';
  const page = [onAccent, s.ground, s.surface];
  const accent = ensureContrast(base, page);
  const soft = mixHex(base, s.surface, dark ? 0.78 : 0.88);
  const accentStrong = ensureContrast(adjust(accent, { lighten: dark ? 0.08 : -0.08 }), [...page, soft]);
  const gradEnd = ensureContrast(adjust(accent, { hue: def.turn, lighten: dark ? 0.04 : 0 }), [onAccent]);
  const out = { accent, accentStrong, onAccent, soft, gradEnd };
  cache.set(key, out);
  return out;
}

/** Dark modules for a profile's QR code on its white card: the accent, deep enough (7:1) for any camera to read. */
export const profileQrInk = (id: string | null | undefined) => ensureContrast(profileAccentColors(id, 'light').accent, ['#FFFFFF'], 7);

/** The host a link points to, lower case, without "www." (for the favicon and the small label under a link). */
export function linkHost(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname.toLowerCase().replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}
