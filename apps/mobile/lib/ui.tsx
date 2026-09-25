import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, useColorScheme, View, type TextInputProps } from 'react-native';
import { palette, radius, space } from './theme';

export function useColors() {
  return palette(useColorScheme() === 'dark' ? 'dark' : 'light');
}

export function Screen({ children }: { children: ReactNode }) {
  const c = useColors();
  return <View style={{ flex: 1, backgroundColor: c.ground, padding: space[4], gap: space[3] }}>{children}</View>;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary';
  disabled?: boolean;
}) {
  const c = useColors();
  const primary = variant === 'primary';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[s.button, { backgroundColor: primary ? c.yapi : c.surface, borderColor: primary ? c.yapi : c.line, opacity: disabled ? 0.45 : 1 }]}
    >
      <Text style={{ color: primary ? c.onYapi : c.ink, fontWeight: '600', fontSize: 15 }}>{label}</Text>
    </Pressable>
  );
}

export function Field(props: TextInputProps & { label: string }) {
  const c = useColors();
  return (
    <View style={{ gap: space[1] }}>
      <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{props.label}</Text>
      <TextInput
        accessibilityLabel={props.label}
        placeholderTextColor={c.inkMuted}
        {...props}
        style={[s.input, { borderColor: c.line, color: c.ink, backgroundColor: c.surface }, props.style]}
      />
    </View>
  );
}

export function Row({ title, subtitle, end, onPress }: { title: string; subtitle?: string; end?: ReactNode; onPress?: () => void }) {
  const c = useColors();
  return (
    <Pressable accessibilityRole={onPress ? 'button' : undefined} onPress={onPress} style={[s.row, { backgroundColor: c.surface, borderColor: c.line }]}>
      <View style={{ flex: 1 }}>
        <Text style={{ color: c.ink, fontWeight: '600', fontSize: 15 }} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={{ color: c.inkMuted, fontSize: 13 }} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {end}
    </Pressable>
  );
}

export function Loading() {
  const c = useColors();
  return <ActivityIndicator style={{ flex: 1, backgroundColor: c.ground }} color={c.yapi} />;
}

const s = StyleSheet.create({
  button: { height: 44, borderRadius: radius.md, borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space[4] },
  input: { minHeight: 44, borderWidth: 1, borderRadius: radius.sm, paddingHorizontal: space[3], fontSize: 15 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space[3], padding: space[3], borderWidth: 1, borderRadius: radius.md },
});
