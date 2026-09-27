import type { ReactNode } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { radius, space } from './theme';
import { Icon, useColors, userText, type IconName } from './ui';

/**
 * A rounded chip: a recent search, a tag, a filter. 36 high with 4 of slop all round, so the
 * touch target is 44. As a filter (`selected` given) screen readers hear it as a selected tab,
 * or, with `radio`, as one choice of several.
 */
export function Chip({
  label,
  onPress,
  onLongPress,
  selected,
  icon,
  meta,
  a11yLabel,
  a11yHint,
  radio,
}: {
  label: string;
  onPress: () => void;
  onLongPress?: () => void;
  selected?: boolean;
  icon?: IconName;
  meta?: string;
  a11yLabel?: string;
  a11yHint?: string;
  radio?: boolean;
}) {
  const c = useColors();
  const tab = selected !== undefined;
  return (
    <Pressable
      accessibilityRole={radio ? 'radio' : tab ? 'tab' : 'button'}
      accessibilityLabel={a11yLabel ?? (meta ? `${label}, ${meta}` : label)}
      accessibilityHint={a11yHint}
      accessibilityState={radio ? { checked: !!selected } : tab ? { selected } : undefined}
      onPress={onPress}
      onLongPress={onLongPress}
      hitSlop={4}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        height: 36,
        paddingHorizontal: space[3],
        borderRadius: radius.full,
        borderWidth: 1,
        borderColor: selected ? c.yapi : c.line,
        backgroundColor: selected ? c.yapiSoft : c.surface,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      {icon ? <Icon name={icon} size={16} color={selected ? c.yapi : c.inkMuted} /> : null}
      <Text style={[{ color: c.ink, fontWeight: selected ? '700' : '600', fontSize: 14 }, userText]} numberOfLines={1}>
        {label}
      </Text>
      {meta ? <Text style={{ color: c.inkMuted, fontSize: 13 }}>{meta}</Text> : null}
    </Pressable>
  );
}

/** Chips in a row: wrapping, or scrolling sideways (`scroll`) for filters that must stay on one line. */
export function ChipRow({
  children,
  scroll,
  label,
  tabs,
  radios,
}: {
  children: ReactNode;
  scroll?: boolean;
  label?: string;
  tabs?: boolean;
  radios?: boolean;
}) {
  const role = tabs ? 'tablist' : radios ? 'radiogroup' : undefined;
  if (scroll)
    return (
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        accessibilityRole={role}
        accessibilityLabel={label}
        contentContainerStyle={{ gap: space[2], paddingVertical: 4 }}
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </ScrollView>
    );
  return (
    <View accessibilityRole={role} accessibilityLabel={label} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
      {children}
    </View>
  );
}

/** A section heading with an optional small action at its end ("Clear", "See all"). */
export function SectionHeader({ title, action }: { title: string; action?: { label: string; onPress: () => void; a11yLabel?: string } }) {
  const c = useColors();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space[2], minHeight: 32 }}>
      <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 17, fontWeight: '800', letterSpacing: -0.2, flexShrink: 1 }}>
        {title}
      </Text>
      {action ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={action.a11yLabel ?? action.label}
          onPress={action.onPress}
          hitSlop={10}
          style={({ pressed }) => ({ minHeight: 32, justifyContent: 'center', opacity: pressed ? 0.7 : 1 })}
        >
          <Text style={{ color: c.yapi, fontWeight: '700', fontSize: 14 }}>{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
