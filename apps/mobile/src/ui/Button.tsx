import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../theme';
import { useT } from '../i18n';
import { AppText } from './Text';
import { Icon, type IconName } from './Icon';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends Omit<PressableProps, 'style' | 'children'> {
  label: string;
  variant?: ButtonVariant;
  loading?: boolean;
  icon?: IconName;
  /** Fill the row (default for primary form buttons). */
  block?: boolean;
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function Button({
  label,
  variant = 'primary',
  loading,
  disabled,
  icon,
  block,
  compact,
  style,
  accessibilityLabel,
  accessibilityHint,
  ...rest
}: ButtonProps) {
  const th = useTheme();
  const t = useT();
  const off = Boolean(disabled || loading);
  const palette = {
    primary: { bg: th.colors.primary, fg: th.colors.onPrimary, border: th.colors.primary },
    secondary: { bg: th.colors.surface, fg: th.colors.text, border: th.colors.borderStrong },
    ghost: { bg: 'transparent', fg: th.colors.primaryText, border: 'transparent' },
    danger: { bg: th.colors.dangerSoft, fg: th.colors.danger, border: th.colors.danger },
  }[variant];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: off, busy: loading === true }}
      disabled={off}
      hitSlop={compact ? 6 : 0}
      style={({ pressed }) => [
        styles.base,
        {
          backgroundColor: palette.bg,
          borderColor: palette.border,
          minHeight: compact ? 36 : th.targetMin,
          borderRadius: th.radius.md,
          paddingHorizontal: compact ? th.space[3] : th.space[5],
          opacity: off ? 0.55 : pressed ? 0.85 : 1,
        },
        block && styles.block,
        style,
      ]}
      {...rest}
    >
      <View style={styles.row}>
        {loading ? (
          <ActivityIndicator color={palette.fg} accessibilityLabel={t('a11y.loadingIndicator')} />
        ) : icon ? (
          <Icon name={icon} size={18} color={palette.fg} />
        ) : null}
        <AppText
          variant="bodyStrong"
          style={{ color: palette.fg, marginStart: loading || icon ? th.space[2] : 0 }}
          numberOfLines={1}
        >
          {label}
        </AppText>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  block: { alignSelf: 'stretch' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
});
