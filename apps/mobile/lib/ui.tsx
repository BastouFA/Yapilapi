import Ionicons from '@expo/vector-icons/Ionicons';
import { LinearGradient } from 'expo-linear-gradient';
import type { ComponentProps, ReactNode } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  useColorScheme,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { mediaUrl } from './api';
import { elevation, gradient, palette, radius, space } from './theme';

export type IconName = ComponentProps<typeof Ionicons>['name'];
export function Icon({ name, size = 22, color }: { name: IconName; size?: number; color: string }) {
  return <Ionicons name={name} size={size} color={color} />;
}

export function useColors() {
  return palette(useColorScheme() === 'dark' ? 'dark' : 'light');
}

/** Height the floating tab bar covers at the bottom of tab screens. */
export function useTabBarSpace() {
  return useSafeAreaInsets().bottom + 104;
}

export function Screen({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const c = useColors();
  return <View style={[{ flex: 1, backgroundColor: c.ground, padding: space[4], gap: space[3] }, style]}>{children}</View>;
}

/** Rounded surface with a soft shadow (a faint border in dark mode). */
export function Card({ children, style, onPress, label }: { children: ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void; label?: string }) {
  const c = useColors();
  const base = [s.card, { backgroundColor: c.surface }, elevation(c), style];
  if (!onPress) return <View style={base}>{children}</View>;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => [...base, pressed && { opacity: 0.85 }]}>
      {children}
    </Pressable>
  );
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  icon,
  disabled,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  icon?: IconName;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useColors();
  const fg = variant === 'primary' ? c.onYapi : variant === 'danger' ? c.onDanger : variant === 'ghost' ? c.yapi : c.ink;
  const height = size === 'sm' ? 36 : 44;
  const content = (
    <>
      {icon ? <Icon name={icon} size={size === 'sm' ? 16 : 18} color={fg} /> : null}
      <Text style={{ color: fg, fontWeight: '700', fontSize: size === 'sm' ? 13 : 15 }}>{label}</Text>
    </>
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [{ borderRadius: radius.full, opacity: disabled ? 0.45 : pressed ? 0.85 : 1, overflow: 'hidden' }, style]}
    >
      {variant === 'primary' ? (
        <LinearGradient {...gradient(c)} style={[s.button, { height }]}>
          {content}
        </LinearGradient>
      ) : (
        <View
          style={[
            s.button,
            { height },
            variant === 'secondary' && { backgroundColor: c.surface, borderWidth: 1, borderColor: c.line },
            variant === 'danger' && { backgroundColor: c.danger },
          ]}
        >
          {content}
        </View>
      )}
    </Pressable>
  );
}

export function Field(props: TextInputProps & { label: string; hideLabel?: boolean }) {
  const c = useColors();
  return (
    <View style={{ gap: space[1] }}>
      {props.hideLabel ? null : <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{props.label}</Text>}
      <TextInput
        accessibilityLabel={props.label}
        placeholderTextColor={c.inkMuted}
        {...props}
        style={[s.input, { borderColor: c.line, color: c.ink, backgroundColor: c.surface }, props.style]}
      />
    </View>
  );
}

export function Row({ title, subtitle, start, end, onPress }: { title: string; subtitle?: string; start?: ReactNode; end?: ReactNode; onPress?: () => void }) {
  const c = useColors();
  return (
    <Card onPress={onPress} label={onPress ? title : undefined} style={s.row}>
      {start}
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
    </Card>
  );
}

/** Pill segmented control, like the web Tabs. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly { id: T; label: string; count?: number }[];
  value: T;
  onChange: (id: T) => void;
  label?: string;
}) {
  const c = useColors();
  return (
    <View accessibilityRole="tablist" accessibilityLabel={label} style={[s.segmented, { backgroundColor: c.surfaceSunken }]}>
      {options.map((o) => {
        const on = o.id === value;
        return (
          <Pressable
            key={o.id}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(o.id)}
            style={[s.segment, on && [{ backgroundColor: c.surface }, elevation(c)]]}
          >
            <Text style={{ color: on ? c.ink : c.inkMuted, fontWeight: on ? '700' : '600', fontSize: 14 }} numberOfLines={1}>
              {o.label}
              {o.count !== undefined ? <Text style={{ color: c.inkMuted, fontWeight: '500' }}> {o.count}</Text> : null}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Avatar({ name, url, size = 40 }: { name: string; url?: string | null; size?: number }) {
  const c = useColors();
  if (url) return <Image source={{ uri: mediaUrl(url) }} accessibilityIgnoresInvertColors style={{ width: size, height: size, borderRadius: size / 2 }} />;
  const initials =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join('') || '?';
  return (
    <LinearGradient {...gradient(c)} style={{ width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: c.onYapi, fontWeight: '700', fontSize: size * 0.38 }}>{initials}</Text>
    </LinearGradient>
  );
}

export function Notice({ children, tone = 'info', title }: { children: ReactNode; tone?: 'info' | 'danger' | 'warn'; title?: string }) {
  const c = useColors();
  const bg = tone === 'danger' ? c.dangerSoft : tone === 'warn' ? c.saffronSoft : c.yapiSoft;
  return (
    <View
      accessibilityRole={tone === 'danger' ? 'alert' : undefined}
      style={{ backgroundColor: bg, borderRadius: radius.md, padding: space[3], gap: space[1] }}
    >
      {title ? <Text style={{ color: c.ink, fontWeight: '700' }}>{title}</Text> : null}
      {typeof children === 'string' ? <Text style={{ color: c.ink, lineHeight: 20 }}>{children}</Text> : children}
    </View>
  );
}

export function SwitchRow({
  label,
  hint,
  value,
  onValueChange,
  disabled,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  const c = useColors();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: c.ink, fontSize: 15, fontWeight: '600' }}>{label}</Text>
        {hint ? <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{hint}</Text> : null}
      </View>
      <Switch
        accessibilityLabel={label}
        value={value}
        disabled={disabled}
        onValueChange={onValueChange}
        trackColor={{ true: c.yapi, false: c.line }}
        thumbColor={c.theme === 'dark' ? c.ink : '#FFFFFF'}
        ios_backgroundColor={c.line}
      />
    </View>
  );
}

export function Title({ children, sub }: { children: ReactNode; sub?: string }) {
  const c = useColors();
  return (
    <View style={{ gap: 2 }}>
      <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 20, fontWeight: '800', letterSpacing: -0.3 }}>
        {children}
      </Text>
      {sub ? <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{sub}</Text> : null}
    </View>
  );
}

export function EmptyState({ title, body }: { title: string; body?: string }) {
  const c = useColors();
  return (
    <View style={{ alignItems: 'center', padding: space[6], gap: space[2] }}>
      <Text style={{ color: c.ink, fontSize: 17, fontWeight: '700', textAlign: 'center' }}>{title}</Text>
      {body ? <Text style={{ color: c.inkMuted, textAlign: 'center', lineHeight: 20 }}>{body}</Text> : null}
    </View>
  );
}

export function Loading() {
  const c = useColors();
  return <ActivityIndicator style={{ flex: 1, backgroundColor: c.ground }} color={c.yapi} />;
}

const s = StyleSheet.create({
  card: { borderRadius: radius.lg, padding: space[4] },
  button: { flexDirection: 'row', gap: space[2], alignItems: 'center', justifyContent: 'center', paddingHorizontal: space[4] + 2 },
  input: { minHeight: 44, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space[3], fontSize: 15 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space[3], padding: space[3], borderRadius: radius.md },
  segmented: { flexDirection: 'row', borderRadius: radius.full, padding: 4, gap: 4 },
  segment: { flex: 1, height: 36, borderRadius: radius.full, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space[2] },
});
