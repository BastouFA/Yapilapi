import Ionicons from '@expo/vector-icons/Ionicons';
import { LinearGradient } from 'expo-linear-gradient';
import { HeaderHeightContext, NavigationContext } from 'expo-router/react-navigation';
import { useCallback, useContext, useEffect, useId, useRef, useState, type ComponentProps, type ReactNode, type Ref } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  I18nManager,
  Image,
  InputAccessoryView,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  useColorScheme,
  View,
  type DimensionValue,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { smallAvatarUrl } from '../../../packages/shared/src/data-saver';
import { initialsOf } from '../../../packages/shared/src/initials';
import { mediaUrl } from './api';
import { useDataSaver } from './data-saver';
import { useT } from './i18n';
import { elevation, gradient, palette, radius, space } from './theme';

export type IconName = ComponentProps<typeof Ionicons>['name'];
/**
 * `directional` mirrors the glyph in right-to-left layouts: use it for icons that point along the
 * reading direction (back or forward arrows and chevrons, a send arrow pointing sideways). Icons
 * that point up or down, and symbols like a phone or a heart, stay as they are.
 */
export function Icon({ name, size = 22, color, directional }: { name: IconName; size?: number; color: string; directional?: boolean }) {
  return <Ionicons name={name} size={size} color={color} style={directional && I18nManager.isRTL ? { transform: [{ scaleX: -1 }] } : undefined} />;
}

/**
 * For text people wrote (posts, messages, names, bios): take the direction from the text itself,
 * so English inside the Arabic app, or Arabic inside the English app, reads in its own order.
 * iOS honours `writingDirection`; Android already picks the direction from the first strong
 * character of the text.
 */
export const userText = { writingDirection: 'auto' } as const satisfies TextStyle;

/** A profile's accent colours, as profileAccentColors gives them (text on each is AA). */
export type Tint = { accent: string; accentStrong: string; onAccent: string; soft: string; gradEnd: string };

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

/**
 * When `onPress` returns a promise (an async handler), the button stays disabled until it
 * settles, so a second tap can't send the same thing twice.
 */
export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  icon,
  disabled: disabledProp,
  style,
  tint,
}: {
  label: string;
  onPress: () => unknown;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  icon?: IconName;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  /** A profile's accent (profileAccentColors, already checked for contrast) in place of the brand colours. */
  tint?: Tint;
}) {
  const c = useColors();
  const [pending, setPending] = useState(false);
  // A ref as well as state: two quick taps can land before the button renders as disabled.
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const disabled = disabledProp || pending;
  const press = () => {
    if (running.current) return;
    const result = onPress();
    if (!result || typeof (result as Promise<unknown>).then !== 'function') return;
    running.current = true;
    setPending(true);
    const done = () => {
      running.current = false;
      if (mounted.current) setPending(false);
    };
    (result as Promise<unknown>).then(done, done);
  };
  const fg = variant === 'primary' ? (tint?.onAccent ?? c.onYapi) : variant === 'danger' ? c.onDanger : variant === 'ghost' ? (tint?.accent ?? c.yapi) : c.ink;
  const height = size === 'sm' ? 36 : 44;
  const content = (
    <>
      {icon ? <Icon name={icon} size={size === 'sm' ? 16 : 18} color={fg} /> : null}
      {/* Buttons are a fixed height: the label grows with the text size up to twice, which still fits (larger would be cut off). */}
      <Text maxFontSizeMultiplier={2} style={{ color: fg, fontWeight: '700', fontSize: size === 'sm' ? 13 : 15 }}>
        {label}
      </Text>
    </>
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy: pending }}
      disabled={disabled}
      onPress={press}
      // Small buttons are 36pt tall; the touch area still reaches 44pt.
      hitSlop={size === 'sm' ? 4 : undefined}
      style={({ pressed }) => [{ borderRadius: radius.full, opacity: disabled ? 0.45 : pressed ? 0.85 : 1, overflow: 'hidden' }, style]}
    >
      {variant === 'primary' ? (
        <LinearGradient {...gradient(c)} {...(tint ? { colors: [tint.accent, tint.accentStrong, tint.gradEnd] as const } : {})} style={[s.button, { height }]}>
          {content}
        </LinearGradient>
      ) : (
        <View
          style={[
            s.button,
            // Rounded here too, so the outline follows the curved ends instead of being clipped off.
            { height, borderRadius: height / 2 },
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

/**
 * A labelled text field. `hint` is a line under it (read out as the field's hint); `error` replaces
 * the hint in the danger colour and outlines the field. `end` puts a control inside the field at the
 * end (a show-password button, for example).
 */
export function Field({
  hint,
  error,
  end,
  ...props
}: TextInputProps & { label: string; hideLabel?: boolean; ref?: Ref<TextInput>; hint?: string; error?: string | null; end?: ReactNode }) {
  const c = useColors();
  const { t } = useT();
  const below = error || hint;
  // iPhone number keypads have no return key: a Done bar above them closes the keyboard.
  const accessoryId = `field-${useId()}`;
  const keypad = Platform.OS === 'ios' && ['number-pad', 'decimal-pad', 'numeric', 'phone-pad'].includes(String(props.keyboardType));
  const input = (
    <TextInput
      accessibilityLabel={props.label}
      accessibilityHint={below || undefined}
      placeholderTextColor={c.inkMuted}
      inputAccessoryViewID={keypad ? accessoryId : undefined}
      {...props}
      style={[
        s.input,
        userText,
        { borderColor: error ? c.danger : c.line, color: c.ink, backgroundColor: c.surface },
        end ? { paddingEnd: 48 } : null,
        props.style,
      ]}
    />
  );
  return (
    <View style={{ gap: space[1] }}>
      {props.hideLabel ? null : <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{props.label}</Text>}
      {end ? (
        <View style={{ justifyContent: 'center' }}>
          {input}
          <View style={{ position: 'absolute', end: 0, top: 0, bottom: 0, justifyContent: 'center' }}>{end}</View>
        </View>
      ) : (
        input
      )}
      {keypad ? (
        <InputAccessoryView nativeID={accessoryId}>
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', backgroundColor: c.surfaceSunken, borderTopWidth: 1, borderTopColor: c.line }}>
            <Pressable
              accessibilityRole="button"
              onPress={() => Keyboard.dismiss()}
              style={{ minHeight: 44, minWidth: 64, paddingHorizontal: space[4], alignItems: 'center', justifyContent: 'center' }}
            >
              <Text style={{ color: c.yapi, fontWeight: '700', fontSize: 16 }}>{t('m.common.done')}</Text>
            </Pressable>
          </View>
        </InputAccessoryView>
      ) : null}
      {below ? (
        <Text
          accessibilityElementsHidden
          importantForAccessibility="no"
          style={{ color: error ? c.danger : c.inkMuted, fontSize: 12, lineHeight: 16, fontWeight: error ? '600' : '400' }}
        >
          {below}
        </Text>
      ) : null}
    </View>
  );
}

export function Row({ title, subtitle, start, end, onPress }: { title: string; subtitle?: string; start?: ReactNode; end?: ReactNode; onPress?: () => void }) {
  const c = useColors();
  return (
    <Card onPress={onPress} label={onPress ? title : undefined} style={s.row}>
      {start}
      <View style={{ flex: 1 }}>
        <Text style={[{ color: c.ink, fontWeight: '600', fontSize: 15 }, userText]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={[{ color: c.inkMuted, fontSize: 13 }, userText]} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {end}
    </Card>
  );
}

/** Two taps on the same segment within this many milliseconds count as a double tap. */
const DOUBLE_PRESS_MS = 300;

/**
 * Pill segmented control, like the web Tabs. With `onDoublePress`, tapping a segment twice
 * quickly calls it (screen readers get it as a named action, `doublePressLabel`).
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  onDoublePress,
  doublePressLabel,
  tint,
}: {
  options: readonly { id: T; label: string; count?: number }[];
  value: T;
  onChange: (id: T) => void;
  label?: string;
  onDoublePress?: (id: T) => void;
  doublePressLabel?: string;
  /** A profile's accent: the selected segment takes it. */
  tint?: Tint;
}) {
  const c = useColors();
  const lastTap = useRef<{ id: T; at: number } | null>(null);
  const press = (id: T) => {
    const now = Date.now();
    const last = lastTap.current;
    if (onDoublePress && last && last.id === id && now - last.at < DOUBLE_PRESS_MS) {
      lastTap.current = null;
      return onDoublePress(id);
    }
    lastTap.current = { id, at: now };
    onChange(id);
  };
  // More than four, or labels too long to fit at full size (roughly 8pt a character at 14pt, plus
  // padding): a row that scrolls sideways, every label at full size, the chosen one kept in view.
  const [rowWidth, setRowWidth] = useState(0);
  const needed = options.reduce((sum, o) => sum + o.label.length * 8 + 28 + (o.count !== undefined ? 20 : 0), 0) + 4 * (options.length + 1);
  const scrolls = options.length > 4 || (rowWidth > 0 && needed > rowWidth);
  const row = useRef<ScrollView>(null);
  const spots = useRef(new Map<T, number>());
  useEffect(() => {
    const x = spots.current.get(value);
    if (scrolls && x !== undefined) row.current?.scrollTo({ x: Math.max(0, x - 48), animated: true });
  }, [scrolls, value]);
  const items = options.map((o) => {
    const on = o.id === value;
    return (
      <Pressable
        key={o.id}
        accessibilityRole="tab"
        accessibilityState={{ selected: on }}
        accessibilityActions={onDoublePress && doublePressLabel ? [{ name: 'doublePress', label: doublePressLabel }] : undefined}
        onAccessibilityAction={(e) => {
          if (e.nativeEvent.actionName === 'doublePress') onDoublePress?.(o.id);
        }}
        onPress={() => press(o.id)}
        onLayout={scrolls ? (e) => spots.current.set(o.id, e.nativeEvent.layout.x) : undefined}
        style={[s.segment, scrolls && { flex: 0, paddingHorizontal: space[3] + 2 }, on && [{ backgroundColor: tint?.accent ?? c.surface }, elevation(c)]]}
      >
        <Text
          style={{ color: on ? (tint?.onAccent ?? c.ink) : c.inkMuted, fontWeight: on ? '700' : '600', fontSize: 14 }}
          numberOfLines={1}
          // A few tabs on a narrow phone: shrink a little rather than cut words off ("Mem…").
          adjustsFontSizeToFit={!scrolls}
          minimumFontScale={0.75}
        >
          {o.label}
          {o.count !== undefined ? <Text style={{ color: on && tint ? tint.onAccent : c.inkMuted, fontWeight: '500' }}> {o.count}</Text> : null}
        </Text>
      </Pressable>
    );
  });
  if (scrolls)
    return (
      <View
        accessibilityRole="tablist"
        accessibilityLabel={label}
        onLayout={(e) => setRowWidth(e.nativeEvent.layout.width)}
        style={{ borderRadius: radius.full, overflow: 'hidden', backgroundColor: c.surfaceSunken }}
      >
        <ScrollView ref={row} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.segmented}>
          {items}
        </ScrollView>
      </View>
    );
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={label}
      onLayout={(e) => setRowWidth(e.nativeEvent.layout.width)}
      style={[s.segmented, { backgroundColor: c.surfaceSunken }]}
    >
      {items}
    </View>
  );
}

export function Avatar({ name, url, size = 40 }: { name: string; url?: string | null; size?: number }) {
  const c = useColors();
  // Data saver: the smallest processed size, or the original if there isn't one.
  const saver = useDataSaver().active;
  const [smallFailed, setSmallFailed] = useState<string | null>(null);
  const small = saver && url && smallFailed !== url ? smallAvatarUrl(mediaUrl(url)) : null;
  if (url)
    return (
      <Image
        source={{ uri: small ?? mediaUrl(url) }}
        onError={small && small !== mediaUrl(url) ? () => setSmallFailed(url) : undefined}
        accessibilityIgnoresInvertColors
        style={{ width: size, height: size, borderRadius: size / 2 }}
      />
    );
  const initials = initialsOf(name);
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
    // The whole row toggles, not only the small switch; screen readers get one switch with its label.
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ checked: value, disabled: !!disabled }}
      disabled={disabled}
      onPress={() => onValueChange(!value)}
      style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], opacity: disabled ? 0.5 : 1 }}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: c.ink, fontSize: 15, fontWeight: '600' }}>{label}</Text>
        {hint ? <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{hint}</Text> : null}
      </View>
      <Switch
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        value={value}
        disabled={disabled}
        onValueChange={onValueChange}
        trackColor={{ true: c.yapi, false: c.line }}
        thumbColor={c.theme === 'dark' ? c.ink : '#FFFFFF'}
        ios_backgroundColor={c.line}
      />
    </Pressable>
  );
}

export function Title({ children, sub }: { children: ReactNode; sub?: string }) {
  const c = useColors();
  return (
    <View style={{ gap: 2 }}>
      <Text accessibilityRole="header" style={[{ color: c.ink, fontSize: 20, fontWeight: '800', letterSpacing: -0.3 }, userText]}>
        {children}
      </Text>
      {sub ? <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{sub}</Text> : null}
    </View>
  );
}

/**
 * What a screen shows when it has nothing yet. With `action`, it points to the next useful thing
 * to do (a button); `secondary` adds a quieter second choice; `icon` sits in a soft circle on top.
 */
export function EmptyState({
  title,
  body,
  icon,
  action,
  secondary,
  children,
}: {
  title: string;
  body?: string;
  icon?: IconName;
  action?: { label: string; onPress: () => void; icon?: IconName };
  secondary?: { label: string; onPress: () => void; icon?: IconName };
  children?: ReactNode;
}) {
  const c = useColors();
  return (
    <View style={{ alignItems: 'center', padding: space[6], gap: space[2] }}>
      {icon ? (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{
            width: 64,
            height: 64,
            borderRadius: 22,
            backgroundColor: c.yapiSoft,
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: space[1],
          }}
        >
          <Icon name={icon} size={30} color={c.yapi} />
        </View>
      ) : null}
      <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 17, fontWeight: '700', textAlign: 'center' }}>
        {title}
      </Text>
      {body ? <Text style={{ color: c.inkMuted, textAlign: 'center', lineHeight: 20, maxWidth: 340 }}>{body}</Text> : null}
      {action || secondary ? (
        <View style={{ gap: space[2], marginTop: space[2], alignSelf: 'stretch', alignItems: 'center' }}>
          {action ? <Button label={action.label} icon={action.icon} onPress={action.onPress} style={{ minWidth: 220 }} /> : null}
          {secondary ? <Button label={secondary.label} icon={secondary.icon} variant="ghost" onPress={secondary.onPress} /> : null}
        </View>
      ) : null}
      {children}
    </View>
  );
}

/**
 * A grey placeholder the shape of what is loading, softly pulsing (still, with Reduce Motion).
 * Hidden from screen readers: the list around it says "Loading" once.
 */
export function Skeleton({
  width,
  height,
  radius: r = radius.sm,
  style,
}: {
  width?: number | `${number}%`;
  height: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useColors();
  const pulse = useSkeletonPulse();
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[{ width: width ?? '100%', height, borderRadius: r, backgroundColor: c.surfaceSunken, opacity: pulse }, style]}
    />
  );
}

// One shared animation for every placeholder on screen, so they pulse together.
let sharedPulse: Animated.Value | null = null;
let pulseUsers = 0;
let pulseLoop: Animated.CompositeAnimation | null = null;
function useSkeletonPulse() {
  const [value] = useState(() => (sharedPulse ??= new Animated.Value(1)));
  useEffect(() => {
    let cancelled = false;
    pulseUsers++;
    void AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
      if (cancelled || reduce || pulseLoop) return;
      pulseLoop = Animated.loop(
        Animated.sequence([
          Animated.timing(value, { toValue: 0.45, duration: 700, useNativeDriver: true }),
          Animated.timing(value, { toValue: 1, duration: 700, useNativeDriver: true }),
        ]),
      );
      pulseLoop.start();
    });
    return () => {
      cancelled = true;
      if (--pulseUsers === 0) {
        pulseLoop?.stop();
        pulseLoop = null;
        value.setValue(1);
      }
    };
  }, [value]);
  return value;
}

/** Placeholders for a list while it loads: posts (Pulse, profiles) or rows (chats, notifications). */
export function SkeletonList({ kind = 'row', count = kind === 'post' ? 3 : 6 }: { kind?: 'post' | 'row'; count?: number }) {
  const c = useColors();
  const { t } = useT();
  return (
    <View accessible accessibilityRole="progressbar" accessibilityLabel={t('common.loading')} style={{ gap: space[3] }}>
      {Array.from({ length: count }, (_, i) =>
        kind === 'post' ? (
          <View key={i} style={[s.card, { backgroundColor: c.surface, gap: space[3] }, elevation(c)]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
              <Skeleton width={40} height={40} radius={20} />
              <View style={{ flex: 1, gap: 6 }}>
                <Skeleton width="45%" height={12} />
                <Skeleton width="25%" height={10} />
              </View>
            </View>
            <Skeleton width="92%" height={12} />
            <Skeleton width="70%" height={12} />
            {i % 2 === 0 ? <Skeleton height={180} radius={radius.md} /> : null}
          </View>
        ) : (
          <View key={i} style={[s.row, { backgroundColor: c.surface }, elevation(c)]}>
            <Skeleton width={44} height={44} radius={22} />
            <View style={{ flex: 1, gap: 6 }}>
              <Skeleton width={`${50 + ((i * 17) % 30)}%`} height={12} />
              <Skeleton width={`${30 + ((i * 23) % 40)}%`} height={10} />
            </View>
          </View>
        ),
      )}
    </View>
  );
}

export function Loading() {
  const c = useColors();
  const { t } = useT();
  return <ActivityIndicator accessibilityLabel={t('common.loading')} style={{ flex: 1, backgroundColor: c.ground }} color={c.yapi} />;
}

const s = StyleSheet.create({
  card: { borderRadius: radius.lg, padding: space[4] },
  button: { flexDirection: 'row', gap: space[2], alignItems: 'center', justifyContent: 'center', paddingHorizontal: space[4] + 2 },
  input: { minHeight: 44, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space[3], fontSize: 15 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space[3], padding: space[3], borderRadius: radius.md },
  segmented: { flexDirection: 'row', borderRadius: radius.full, padding: 4, gap: 4 },
  segment: { flex: 1, height: 36, borderRadius: radius.full, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space[2] },
});

/** The small Plus mark next to a member's name. */
export function PlusBadge() {
  const c = useColors();
  const { t } = useT();
  return (
    <View
      accessible
      accessibilityLabel={t('plus.badge.label')}
      style={{ backgroundColor: c.saffronSoft, borderRadius: 999, paddingHorizontal: 6, paddingVertical: 1, alignSelf: 'center' }}
    >
      <Text style={{ color: c.ink, fontSize: 10, fontWeight: '800' }}>{t('plus.short')}</Text>
    </View>
  );
}

/** A small label: "Closed", "Scheduled", or (tone live) "Live". */
export function Pill({ text, tone = 'neutral' }: { text: string; tone?: 'neutral' | 'live' }) {
  const c = useColors();
  return (
    <View style={{ backgroundColor: tone === 'live' ? c.danger : c.surfaceSunken, borderRadius: radius.full, paddingHorizontal: space[2], paddingVertical: 2 }}>
      <Text style={{ color: tone === 'live' ? c.onDanger : c.inkMuted, fontSize: 12, fontWeight: '700' }}>{text}</Text>
    </View>
  );
}

/**
 * For long lists of posts: render a few cards first and keep a modest window around the screen.
 * Android also detaches cards scrolled far off screen (on iOS that can blank out rows).
 */
export const feedListProps = {
  removeClippedSubviews: Platform.OS === 'android',
  initialNumToRender: 4,
  maxToRenderPerBatch: 4,
  windowSize: 7,
} as const;

/** Whether the on-screen keyboard is showing, for layouts that make room while you type. */
export function useKeyboardVisible() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => setVisible(true));
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return visible;
}

/**
 * Keeps its content above the keyboard on iOS and Android. Android draws edge to edge, so the
 * window no longer shrinks for the keyboard there either: both platforms pad the bottom. On a
 * screen with a navigation header the offset is the header's height; inside a modal pass
 * `offset={0}`.
 */
export function KeyboardAvoid({ children, style, offset }: { children: ReactNode; style?: StyleProp<ViewStyle>; offset?: number }) {
  const header = useContext(HeaderHeightContext) ?? 0;
  return (
    <KeyboardAvoidingView style={[{ flex: 1 }, style]} behavior="padding" keyboardVerticalOffset={offset ?? header}>
      {children}
    </KeyboardAvoidingView>
  );
}

/**
 * Pull to refresh for a list: `refreshControl={useRefresh(load)}`. The spinner shows until `load`
 * settles, whether it worked or not (the list shows its own error).
 */
export function useRefresh(load: () => unknown) {
  const c = useColors();
  const [refreshing, setRefreshing] = useState(false);
  const latest = useRef(load);
  latest.current = load;
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await latest.current();
    } catch {
      // The screen shows its own error.
    } finally {
      setRefreshing(false);
    }
  }, []);
  return <RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={c.yapi} colors={[c.yapi]} progressBackgroundColor={c.surface} />;
}

/** What a list shows when it could not load: the reason, and a button to try again. */
export function ErrorState({ message, onRetry, style }: { message: string; onRetry: () => unknown; style?: StyleProp<ViewStyle> }) {
  const c = useColors();
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const retry = async () => {
    setBusy(true);
    try {
      await onRetry();
    } catch {
      // The screen shows the new error.
    } finally {
      setBusy(false);
    }
  };
  return (
    <View accessibilityRole="alert" style={[{ backgroundColor: c.dangerSoft, borderRadius: radius.md, padding: space[3], gap: space[2] }, style]}>
      <Text style={{ color: c.ink, lineHeight: 20 }}>{message}</Text>
      <Button
        label={t('m.common.retry')}
        icon="refresh"
        size="sm"
        variant="secondary"
        disabled={busy}
        onPress={() => retry()}
        style={{ alignSelf: 'flex-start' }}
      />
    </View>
  );
}

/** A whole screen that could not load (not one that is gone): the reason and a button to try again. */
export function ScreenError({ message, onRetry }: { message: string; onRetry: () => unknown }) {
  const c = useColors();
  return (
    <View style={{ flex: 1, backgroundColor: c.ground, padding: space[4] }}>
      <ErrorState message={message} onRetry={onRetry} />
    </View>
  );
}

/**
 * Whether this screen is the one in front; true outside a navigator (the root layout). A modal a
 * screen shows (a sheet, a viewer) hides while another screen is on top, or that screen opens behind it.
 */
export function useScreenFocused() {
  const navigation = useContext(NavigationContext);
  const [focused, setFocused] = useState(() => navigation?.isFocused() ?? true);
  useEffect(() => {
    if (!navigation) return;
    setFocused(navigation.isFocused());
    const on = navigation.addListener('focus', () => setFocused(true));
    const off = navigation.addListener('blur', () => setFocused(false));
    return () => {
      on();
      off();
    };
  }, [navigation]);
  return focused;
}

/**
 * A panel that slides up from the bottom over a dimmed screen. Tapping outside or the Android
 * back button closes it; it stays above the keyboard, and taps on its buttons land the first
 * time even while the keyboard is open. `done` adds a Done button next to the title; with
 * `scroll={false}` the content manages its own scrolling (a list inside, for example).
 */
export function BottomSheet({
  visible,
  title,
  subtitle,
  onClose,
  onDismiss,
  children,
  done,
  closeButton = true,
  scroll = true,
  maxHeight = '85%',
  gap = space[3],
}: {
  visible: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  /** After the closing animation (iOS), for opening something else. */
  onDismiss?: () => void;
  children: ReactNode;
  done?: boolean;
  /** The small close button in the corner; off for menus that end with their own Cancel. */
  closeButton?: boolean;
  scroll?: boolean;
  maxHeight?: DimensionValue;
  gap?: number;
}) {
  const c = useColors();
  const { t } = useT();
  const insets = useSafeAreaInsets();
  const focused = useScreenFocused();
  return (
    // A sheet belongs to its screen: when another screen comes on top (a link, a notification), it
    // steps aside and comes back with its screen.
    <Modal visible={visible && focused} transparent animationType="slide" onRequestClose={onClose} onDismiss={onDismiss}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
        <View style={{ flex: 1, backgroundColor: c.overlay, justifyContent: 'flex-end' }}>
          <Pressable accessibilityRole="button" accessibilityLabel={t('m.common.close')} style={{ flex: 1 }} onPress={onClose} />
          <View
            accessibilityViewIsModal
            style={{
              backgroundColor: c.surface,
              borderTopLeftRadius: radius.lg,
              borderTopRightRadius: radius.lg,
              paddingTop: space[4],
              paddingBottom: Math.max(insets.bottom, space[4]),
              maxHeight,
              gap,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: space[4], gap: space[2] }}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text accessibilityRole="header" style={[{ color: c.ink, fontSize: 17, fontWeight: '800' }, userText]}>
                  {title}
                </Text>
                {subtitle ? <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{subtitle}</Text> : null}
              </View>
              {done ? (
                <Button label={t('m.common.done')} size="sm" variant="ghost" onPress={onClose} />
              ) : closeButton ? (
                // Always a visible way out, not only tapping outside or swiping.
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t('m.common.close')}
                  hitSlop={10}
                  onPress={onClose}
                  style={{ width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: c.surfaceSunken }}
                >
                  <Icon name="close" size={18} color={c.inkMuted} />
                </Pressable>
              ) : null}
            </View>
            {scroll ? (
              <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ gap, paddingHorizontal: space[4] }} keyboardShouldPersistTaps="handled">
                {children}
              </ScrollView>
            ) : (
              <View style={{ gap, paddingHorizontal: space[4], flexShrink: 1 }}>{children}</View>
            )}
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** One line in a sheet: an icon, a label, 48 high. `danger` for destructive actions. */
export function SheetItem({
  icon,
  label,
  hint,
  onPress,
  danger,
  disabled,
  selected,
  ref,
}: {
  icon: IconName;
  label: string;
  hint?: string;
  onPress: () => void;
  danger?: boolean;
  disabled?: boolean;
  selected?: boolean;
  ref?: Ref<View>;
}) {
  const c = useColors();
  const color = danger ? c.danger : selected ? c.yapi : c.ink;
  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={selected === undefined ? { disabled: !!disabled } : { disabled: !!disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: space[3],
        minHeight: 48,
        paddingHorizontal: space[2],
        borderRadius: radius.md,
        backgroundColor: pressed ? c.surfaceSunken : selected ? c.yapiSoft : 'transparent',
        opacity: disabled ? 0.5 : 1,
      })}
    >
      <Icon name={icon} size={20} color={color} />
      <Text style={{ color, fontSize: 15, fontWeight: '600', flex: 1 }}>{label}</Text>
    </Pressable>
  );
}

export interface ActionSheetAction {
  label: string;
  icon: IconName;
  onPress: () => void;
  /** Shown in the danger colour: delete, remove, leave, block, report. */
  destructive?: boolean;
  disabled?: boolean;
  hint?: string;
}

export interface ActionSheetMenu {
  title: string;
  message?: string;
  actions: ActionSheetAction[];
}

/**
 * A menu of actions that slides up from the bottom, with Cancel at the end. Use it instead of an
 * Alert with several buttons: Android shows at most three buttons in an alert. The chosen
 * action runs once the sheet has gone, so it can open another sheet or an alert.
 * Screen readers start on the first action; the rest of the screen is hidden from them.
 */
export function ActionSheet({
  visible,
  title,
  message,
  actions,
  onClose,
  header,
}: ActionSheetMenu & { visible: boolean; onClose: () => void; /** Above the actions (quick reactions, for example). */ header?: ReactNode }) {
  const { t } = useT();
  const first = useRef<View>(null);
  const pending = useRef<(() => void) | null>(null);

  const run = useCallback(() => {
    const fn = pending.current;
    pending.current = null;
    fn?.();
  }, []);

  const choose = (a: ActionSheetAction) => {
    pending.current = a.onPress;
    onClose();
    // iOS runs it from onDismiss, once the sheet has gone (it can't show an alert or another
    // sheet over one that is closing); the timer is a fallback. Android has no such limit.
    setTimeout(run, Platform.OS === 'ios' ? 600 : 0);
  };

  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => {
      if (first.current) AccessibilityInfo.sendAccessibilityEvent(first.current, 'focus');
    }, 400);
    return () => clearTimeout(timer);
  }, [visible]);

  return (
    <BottomSheet visible={visible} title={title} subtitle={message} onClose={onClose} onDismiss={run} gap={2} closeButton={false}>
      {header}
      {actions.map((a, i) => (
        <SheetItem
          key={`${i}-${a.label}`}
          ref={i === 0 ? first : undefined}
          icon={a.icon}
          label={a.label}
          hint={a.hint}
          danger={a.destructive}
          disabled={a.disabled}
          onPress={() => choose(a)}
        />
      ))}
      <SheetItem ref={actions.length ? undefined : first} icon="close" label={t('common.cancel')} onPress={onClose} />
    </BottomSheet>
  );
}

/**
 * `const menu = useActionSheet()`, then `menu.show({ title, actions })` from a press and
 * `{menu.sheet}` somewhere in what the component renders.
 */
export function useActionSheet() {
  const [menu, setMenu] = useState<ActionSheetMenu | null>(null);
  const [open, setOpen] = useState(false);
  const show = useCallback((m: ActionSheetMenu) => {
    setMenu(m);
    setOpen(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);
  // The last menu stays rendered while it slides away.
  const sheet = menu ? <ActionSheet visible={open} {...menu} onClose={close} /> : null;
  return { show, close, sheet };
}
