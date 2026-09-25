import React, { forwardRef, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View, type TextInputProps } from 'react-native';
import { useTheme } from '../theme';
import { useT } from '../i18n';
import { AppText } from './Text';

export interface TextFieldProps extends Omit<TextInputProps, 'style'> {
  label: string;
  error?: string | null | undefined;
  hint?: string | undefined;
  /** Shows a show/hide toggle for passwords. */
  password?: boolean;
  required?: boolean;
  multilineHeight?: number;
}

/** Labelled input: the label is always visible (never placeholder-only), errors are announced and linked by role. */
export const TextField = forwardRef<TextInput, TextFieldProps>(function TextField(
  {
    label,
    error,
    hint,
    password,
    required,
    multiline,
    multilineHeight = 120,
    accessibilityLabel,
    ...rest
  },
  ref,
) {
  const th = useTheme();
  const t = useT();
  const [visible, setVisible] = useState(false);
  const [focused, setFocused] = useState(false);
  const borderColor = error ? th.colors.danger : focused ? th.colors.focus : th.colors.borderStrong;
  return (
    <View style={{ marginBottom: th.space[4] }}>
      <AppText variant="label" tone="muted" style={{ marginBottom: th.space[1] }}>
        {required ? `${label} *` : label}
      </AppText>
      <View
        style={[
          styles.box,
          {
            borderColor,
            backgroundColor: th.colors.surface,
            borderRadius: th.radius.sm,
            borderWidth: focused ? 2 : 1,
          },
        ]}
      >
        <TextInput
          ref={ref}
          accessibilityLabel={accessibilityLabel ?? label}
          accessibilityHint={hint}
          accessibilityState={{ disabled: rest.editable === false }}
          aria-invalid={error ? true : undefined}
          aria-required={required}
          placeholderTextColor={th.colors.textSubtle}
          secureTextEntry={password && !visible}
          multiline={multiline}
          textAlignVertical={multiline ? 'top' : 'center'}
          onFocus={(e) => {
            setFocused(true);
            rest.onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            rest.onBlur?.(e);
          }}
          {...rest}
          style={[
            styles.input,
            {
              color: th.colors.text,
              fontSize: th.fontSize.md,
              minHeight: multiline ? multilineHeight : th.targetMin,
              paddingHorizontal: th.space[3],
            },
          ]}
        />
        {password ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={visible ? t('common.hidePassword') : t('common.showPassword')}
            onPress={() => setVisible((v) => !v)}
            style={{
              minHeight: th.targetMin,
              justifyContent: 'center',
              paddingHorizontal: th.space[3],
            }}
          >
            <AppText variant="label" tone="primary">
              {visible ? t('common.hidePassword') : t('common.showPassword')}
            </AppText>
          </Pressable>
        ) : null}
      </View>
      {error ? (
        <AppText
          variant="caption"
          tone="danger"
          accessibilityLiveRegion="polite"
          accessibilityRole="alert"
          style={{ marginTop: th.space[1] }}
        >
          {error}
        </AppText>
      ) : hint ? (
        <AppText variant="caption" tone="subtle" style={{ marginTop: th.space[1] }}>
          {hint}
        </AppText>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  box: { flexDirection: 'row', alignItems: 'center' },
  input: { flex: 1 },
});
