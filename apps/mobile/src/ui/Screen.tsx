import React from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';
import { useTheme } from '../theme';

/** Themed page container. `scroll` wraps the content in a keyboard-aware ScrollView (forms). */
export function Screen({
  children,
  scroll,
  edges = ['left', 'right', 'bottom'],
  padded = true,
  style,
}: {
  children: React.ReactNode;
  scroll?: boolean;
  edges?: Edge[];
  padded?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const th = useTheme();
  const pad = padded ? { paddingHorizontal: th.space[4], paddingTop: th.space[4] } : null;
  const body = scroll ? (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={[{ paddingBottom: th.space[8] }, pad]}
      style={{ flex: 1 }}
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[{ flex: 1 }, pad, style]}>{children}</View>
  );
  return (
    <SafeAreaView edges={edges} style={{ flex: 1, backgroundColor: th.colors.bg }}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {body}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export function Card({
  children,
  style,
  onPress,
  accessibilityLabel,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;
  accessibilityLabel?: string;
}) {
  const th = useTheme();
  const base: ViewStyle = {
    backgroundColor: th.colors.surface,
    borderColor: th.colors.border,
    borderWidth: 1,
    borderRadius: th.radius.md,
    padding: th.space[4],
  };
  if (onPress) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        onPress={onPress}
        style={({ pressed }) => [base, { opacity: pressed ? 0.9 : 1 }, style]}
      >
        {children}
      </Pressable>
    );
  }
  return <View style={[base, style]}>{children}</View>;
}

export const Divider = () => {
  const th = useTheme();
  return <View style={{ height: 1, backgroundColor: th.colors.border }} />;
};
