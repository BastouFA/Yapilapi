import { Pressable, Text, View } from 'react-native';
import { CIRCLE_KINDS, type CircleKind } from '../../../packages/shared/src/constants';
import { useT } from './i18n';
import { radius, space } from './theme';
import { Icon, useColors, userText, type IconName } from './ui';

/** Name length the API accepts for a circle. */
export const CIRCLE_NAME_MAX = 40;

/**
 * A wrapping row of pill choices (radio buttons). Pressing the chosen one again clears it when
 * `clearable` is set.
 */
export function Chips<T extends string>({
  label,
  options,
  value,
  onChange,
  clearable,
}: {
  label: string;
  options: readonly { id: T; label: string; icon?: IconName }[];
  value: T | null;
  onChange: (id: T | null) => void;
  clearable?: boolean;
}) {
  const c = useColors();
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
      {options.map((o) => {
        const on = o.id === value;
        return (
          <Pressable
            key={o.id}
            accessibilityRole="radio"
            accessibilityLabel={o.label}
            accessibilityState={{ selected: on, checked: on }}
            onPress={() => onChange(on && clearable ? null : o.id)}
            // 36pt tall, 8pt apart: the touch area reaches 44 without overlapping the next line's.
            hitSlop={4}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              minHeight: 36,
              paddingHorizontal: space[3],
              borderRadius: radius.full,
              borderWidth: 1,
              borderColor: on ? c.yapi : c.line,
              backgroundColor: on ? c.yapiSoft : c.surface,
              opacity: pressed ? 0.8 : 1,
              maxWidth: '100%',
            })}
          >
            {o.icon ? <Icon name={o.icon} size={15} color={on ? c.yapi : c.inkMuted} /> : null}
            <Text style={[{ color: c.ink, fontWeight: on ? '700' : '500', fontSize: 14, flexShrink: 1 }, userText]} numberOfLines={1}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** The optional kind of a circle (family, work…). Tap the chosen kind again to clear it. */
export function KindPicker({ value, onChange }: { value: CircleKind | null; onChange: (k: CircleKind | null) => void }) {
  const c = useColors();
  const { t } = useT();
  return (
    <View style={{ gap: space[1] }}>
      <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{t('m.circles.kind')}</Text>
      <Chips
        label={t('m.circles.kind')}
        options={CIRCLE_KINDS.map((k) => ({ id: k, label: t(`m.circles.kind.${k}`) }))}
        value={value}
        onChange={onChange}
        clearable
      />
    </View>
  );
}
