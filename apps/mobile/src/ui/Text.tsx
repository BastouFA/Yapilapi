import React from 'react';
import { Text as RNText, type TextProps, type TextStyle } from 'react-native';
import { useTheme, weight, type ThemeColors } from '../theme';

export type TextVariant =
  'display' | 'title' | 'heading' | 'body' | 'bodyStrong' | 'caption' | 'label';
export type TextTone =
  | 'default'
  | 'muted'
  | 'subtle'
  | 'primary'
  | 'danger'
  | 'success'
  | 'warning'
  | 'inverse'
  | 'onPrimary';

const TONE: Record<TextTone, keyof ThemeColors> = {
  default: 'text',
  muted: 'textMuted',
  subtle: 'textSubtle',
  primary: 'primaryText',
  danger: 'danger',
  success: 'success',
  warning: 'warning',
  inverse: 'textInverse',
  onPrimary: 'onPrimary',
};

export interface AppTextProps extends TextProps {
  variant?: TextVariant;
  tone?: TextTone;
  /** Mark a screen heading so screen readers can jump between headings. */
  header?: boolean;
}

/** Themed text. Scales with the user's system font size (allowFontScaling stays on) and never sets a fixed text direction. */
export function AppText({
  variant = 'body',
  tone = 'default',
  header,
  style,
  ...rest
}: AppTextProps) {
  const th = useTheme();
  const v: Record<TextVariant, TextStyle> = {
    display: {
      fontSize: th.fontSize['4xl'],
      fontWeight: weight.black,
      lineHeight: th.fontSize['4xl'] * 1.2,
    },
    title: {
      fontSize: th.fontSize['2xl'],
      fontWeight: weight.bold,
      lineHeight: th.fontSize['2xl'] * 1.25,
    },
    heading: {
      fontSize: th.fontSize.lg,
      fontWeight: weight.bold,
      lineHeight: th.fontSize.lg * 1.3,
    },
    body: {
      fontSize: th.fontSize.md,
      fontWeight: weight.regular,
      lineHeight: th.fontSize.md * 1.45,
    },
    bodyStrong: {
      fontSize: th.fontSize.md,
      fontWeight: weight.bold,
      lineHeight: th.fontSize.md * 1.45,
    },
    caption: {
      fontSize: th.fontSize.sm,
      fontWeight: weight.regular,
      lineHeight: th.fontSize.sm * 1.4,
    },
    label: {
      fontSize: th.fontSize.sm,
      fontWeight: weight.medium,
      lineHeight: th.fontSize.sm * 1.4,
    },
  };
  return (
    <RNText
      accessibilityRole={header ? 'header' : undefined}
      {...rest}
      style={[{ color: th.colors[TONE[tone]] }, v[variant], style]}
    />
  );
}
