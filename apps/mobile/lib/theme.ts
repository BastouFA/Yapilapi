// Mirrors packages/design-system/tokens.json so native screens use the same palette and scale.
import type { ViewStyle } from 'react-native';
import tokens from '../../../packages/design-system/tokens.json';

export type Theme = 'light' | 'dark';
const color = (name: string, theme: Theme): string => {
  const t = tokens.color.tokens.find((x) => x.name === name);
  if (!t) throw new Error(`unknown color token ${name}`);
  return typeof t.value === 'string' ? t.value : ((t.value as Record<string, string>)[theme] ?? (t.value as Record<string, string>).light!);
};

export function palette(theme: Theme) {
  return {
    theme,
    ground: color('ground', theme),
    surface: color('surface', theme),
    surfaceSunken: color('surface-sunken', theme),
    line: color('line', theme),
    lineStrong: color('line-strong', theme),
    ink: color('ink', theme),
    inkMuted: color('ink-muted', theme),
    yapi: color('yapi', theme),
    yapiStrong: color('yapi-strong', theme),
    onYapi: color('on-yapi', theme),
    yapiSoft: color('yapi-soft', theme),
    gradEnd: color('grad-end', theme),
    saffron: color('saffron', theme),
    saffronSoft: color('saffron-soft', theme),
    success: color('success', theme),
    closeFriends: color('close-friends', theme),
    onCloseFriends: color('on-close-friends', theme),
    danger: color('danger', theme),
    onDanger: color('on-danger', theme),
    dangerSoft: color('danger-soft', theme),
    overlay: color('overlay', theme),
  };
}
export type Palette = ReturnType<typeof palette>;

const px = (group: 'spacing' | 'radius', name: string) => parseInt(tokens[group].tokens.find((t) => t.name === name)!.value, 10);

export const space = {
  1: px('spacing', 'space-1'),
  2: px('spacing', 'space-2'),
  3: px('spacing', 'space-3'),
  4: px('spacing', 'space-4'),
  6: px('spacing', 'space-6'),
  8: px('spacing', 'space-8'),
} as const;
export const radius = { sm: px('radius', 'radius-sm'), md: px('radius', 'radius-md'), lg: px('radius', 'radius-lg'), full: 9999 } as const;

/** The brand gradient (135deg, yapi to grad-end), as expo-linear-gradient props. */
export const gradient = (c: Palette) => ({ colors: [c.yapi, c.gradEnd] as const, start: { x: 0, y: 0 }, end: { x: 1, y: 1 } });

/**
 * Soft layered shadows in light mode (tokens shadow-sm / shadow-lg). In dark mode depth
 * comes from surface tone and a faint border, as on the web.
 */
export function elevation(c: Palette, level: 'sm' | 'lg' = 'sm'): ViewStyle {
  if (c.theme === 'dark') return { borderWidth: 1, borderColor: c.line };
  return level === 'sm'
    ? { shadowColor: '#0E1020', shadowOpacity: 0.08, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 2 }
    : { shadowColor: '#0E1020', shadowOpacity: 0.18, shadowRadius: 22, shadowOffset: { width: 0, height: 12 }, elevation: 10 };
}
