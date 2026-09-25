// Mirrors packages/design-system/tokens.json so native screens use the same palette and scale.
import tokens from '../../../packages/design-system/tokens.json';

type Theme = 'light' | 'dark';
const color = (name: string, theme: Theme): string => {
  const t = tokens.color.tokens.find((x) => x.name === name);
  if (!t) throw new Error(`unknown color token ${name}`);
  return typeof t.value === 'string' ? t.value : ((t.value as Record<string, string>)[theme] ?? (t.value as Record<string, string>).light!);
};

export function palette(theme: Theme) {
  return {
    ground: color('ground', theme),
    surface: color('surface', theme),
    line: color('line', theme),
    ink: color('ink', theme),
    inkMuted: color('ink-muted', theme),
    yapi: color('yapi', theme),
    onYapi: color('on-yapi', theme),
    yapiSoft: color('yapi-soft', theme),
    danger: color('danger', theme),
  };
}

export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32 } as const;
export const radius = { sm: 4, md: 8, full: 9999 } as const;
