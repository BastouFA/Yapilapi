/**
 * Chat wallpapers and bubble colours. Each chat has one of each, chosen by any member; everyone
 * in it sees the same. Every colour comes in a light and a dark version so the chat follows the
 * app's appearance, and the pairs are checked (chat-theme.test.ts) so text stays readable:
 * - your bubbles: the text colour on both ends of the bubble's gradient is at least 4.5:1 (AA);
 * - wallpapers: muted text (times, "Today", system lines) on every colour of the wallpaper is at
 *   least 4.5:1, and pattern marks stay faint.
 * The other person's bubbles keep the surface colour, so they read the same on any wallpaper.
 */

import { contrastRatio } from './profile-style.ts';

export const CHAT_WALLPAPERS = ['plain', 'dawn', 'lagoon', 'dusk', 'meadow', 'dots', 'grid', 'stripes'] as const;
export type ChatWallpaper = (typeof CHAT_WALLPAPERS)[number];

export const CHAT_ACCENTS = ['yapi', 'saffron', 'lagoon', 'ocean', 'violet', 'forest', 'graphite'] as const;
export type ChatAccent = (typeof CHAT_ACCENTS)[number];

export interface ChatTheme {
  wallpaper: ChatWallpaper;
  accent: ChatAccent;
}

export const DEFAULT_CHAT_THEME: ChatTheme = { wallpaper: 'plain', accent: 'yapi' };

type Mode = 'light' | 'dark';

/** A wallpaper in one appearance: a gradient from `from` to `to` (the same colour for a flat one), and the colour of pattern marks. */
export interface WallpaperColors {
  from: string;
  to: string;
  /** Dots, grid lines or stripes, drawn over the background. Absent for plain and gradient wallpapers. */
  mark?: string;
}

export interface WallpaperSpec {
  /** plain: the app's own background. gradient: a soft diagonal blend. pattern: a flat tint with small marks. */
  kind: 'plain' | 'gradient' | 'pattern';
  /** For patterns: what the marks are. */
  pattern?: 'dots' | 'grid' | 'stripes';
  light: WallpaperColors;
  dark: WallpaperColors;
}

// The app's ground colours (tokens.json), for "plain".
const GROUND = { light: '#F4F5FA', dark: '#0B0C14' };

export const WALLPAPERS: Record<ChatWallpaper, WallpaperSpec> = {
  plain: { kind: 'plain', light: { from: GROUND.light, to: GROUND.light }, dark: { from: GROUND.dark, to: GROUND.dark } },
  // Coral to saffron, the brand gradient at a whisper.
  dawn: { kind: 'gradient', light: { from: '#FFEBF0', to: '#FFF3D6' }, dark: { from: '#2A111B', to: '#2A200B' } },
  // Sea green to sky.
  lagoon: { kind: 'gradient', light: { from: '#E3F5EF', to: '#E4F0FB' }, dark: { from: '#0C2522', to: '#0C1A2A' } },
  // Lavender to rose.
  dusk: { kind: 'gradient', light: { from: '#EEEAFB', to: '#FBE8F1' }, dark: { from: '#1A1530', to: '#2A1224' } },
  // Leaf to lemon.
  meadow: { kind: 'gradient', light: { from: '#E8F5E4', to: '#FAF6DC' }, dark: { from: '#0F2214', to: '#23220C' } },
  dots: {
    kind: 'pattern',
    pattern: 'dots',
    light: { from: '#FFF6F8', to: '#FFF6F8', mark: '#F4CBD6' },
    dark: { from: '#141019', to: '#141019', mark: '#3A2230' },
  },
  grid: {
    kind: 'pattern',
    pattern: 'grid',
    light: { from: '#F3F6FC', to: '#F3F6FC', mark: '#DCE3F2' },
    dark: { from: '#0E1220', to: '#0E1220', mark: '#1E2640' },
  },
  stripes: {
    kind: 'pattern',
    pattern: 'stripes',
    light: { from: '#FFF8EC', to: '#FFF8EC', mark: '#F6E3BF' },
    dark: { from: '#16120A', to: '#16120A', mark: '#30261A' },
  },
};

/** Your bubbles in one appearance: a gradient from `from` to `to`, with text in `on`. */
export interface AccentColors {
  from: string;
  to: string;
  on: string;
}

export const ACCENTS: Record<ChatAccent, { light: AccentColors; dark: AccentColors }> = {
  // The brand gradient (tokens yapi to grad-end, text on-yapi).
  yapi: { light: { from: '#D21D4A', to: '#C2410C', on: '#FFFFFF' }, dark: { from: '#FF5C7A', to: '#FFBE3D', on: '#0B0C14' } },
  saffron: { light: { from: '#B45309', to: '#9A3412', on: '#FFFFFF' }, dark: { from: '#FFBE3D', to: '#FFD37A', on: '#0B0C14' } },
  lagoon: { light: { from: '#00735F', to: '#0E7490', on: '#FFFFFF' }, dark: { from: '#3DDBC2', to: '#67D4F0', on: '#0B0C14' } },
  ocean: { light: { from: '#1D4ED8', to: '#0B5CAD', on: '#FFFFFF' }, dark: { from: '#7AA7FF', to: '#67D4F0', on: '#0B0C14' } },
  violet: { light: { from: '#6D28D9', to: '#A21CAF', on: '#FFFFFF' }, dark: { from: '#C4B5FD', to: '#F0A6E0', on: '#0B0C14' } },
  forest: { light: { from: '#17703A', to: '#3F6212', on: '#FFFFFF' }, dark: { from: '#3CCB63', to: '#B5E655', on: '#0B0C14' } },
  graphite: { light: { from: '#2A2E45', to: '#0E1020', on: '#FFFFFF' }, dark: { from: '#E4E6F2', to: '#BFC4DA', on: '#0B0C14' } },
};

export function isChatWallpaper(v: unknown): v is ChatWallpaper {
  return typeof v === 'string' && (CHAT_WALLPAPERS as readonly string[]).includes(v);
}
export function isChatAccent(v: unknown): v is ChatAccent {
  return typeof v === 'string' && (CHAT_ACCENTS as readonly string[]).includes(v);
}

/** A stored theme with anything unknown (an older or newer app's name) replaced by the default. */
export function chatTheme(v: { wallpaper?: unknown; accent?: unknown } | null | undefined): ChatTheme {
  return {
    wallpaper: isChatWallpaper(v?.wallpaper) ? v.wallpaper : DEFAULT_CHAT_THEME.wallpaper,
    accent: isChatAccent(v?.accent) ? v.accent : DEFAULT_CHAT_THEME.accent,
  };
}

export const wallpaperColors = (w: ChatWallpaper, mode: Mode): WallpaperColors => WALLPAPERS[w][mode];
export const accentColors = (a: ChatAccent, mode: Mode): AccentColors => ACCENTS[a][mode];

// ── Contrast (WCAG 2), shared with profile colours ─────────────────────

/** The lowest contrast of your bubble's text against either end of its gradient. */
export function accentContrast(a: ChatAccent, mode: Mode): number {
  const c = ACCENTS[a][mode];
  return Math.min(contrastRatio(c.on, c.from), contrastRatio(c.on, c.to));
}
