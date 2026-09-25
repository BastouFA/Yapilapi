import React, { createContext, useContext, useMemo } from 'react';
import { useColorScheme, type TextStyle } from 'react-native';
import { resolveTheme } from '@yapilapi/design-system';
import { tokens } from './tokens.generated';
import { usePrefs } from '../prefs';

export type ThemeColors = { [K in keyof typeof tokens.colors.light]: string };
export interface Theme {
  scheme: 'light' | 'dark';
  colors: ThemeColors;
  space: typeof tokens.space;
  radius: typeof tokens.radius;
  fontSize: typeof tokens.fontSize;
  targetMin: number;
  shadow: { color: string };
}

export function buildTheme(scheme: 'light' | 'dark'): Theme {
  return {
    scheme,
    colors: tokens.colors[scheme] as ThemeColors,
    space: tokens.space,
    radius: tokens.radius,
    fontSize: tokens.fontSize,
    targetMin: tokens.targetMin,
    shadow: { color: '#4a2e14' },
  };
}

const ThemeContext = createContext<Theme>(buildTheme('light'));

/** Resolves the user's theme preference (system/light/dark) with the shared design-system rule. */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const { prefs } = usePrefs();
  const system = useColorScheme();
  const scheme = resolveTheme(prefs.theme, system === 'dark');
  const theme = useMemo(() => buildTheme(scheme), [scheme]);
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);

/** The tokens use variable-font weights (450, 550); React Native's system fonts snap to the nearest standard weight. */
export const weight: {
  regular: TextStyle['fontWeight'];
  medium: TextStyle['fontWeight'];
  bold: TextStyle['fontWeight'];
  black: TextStyle['fontWeight'];
} = { regular: '400', medium: '500', bold: '700', black: '800' };
export { tokens };
