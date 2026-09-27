import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Chip, ChipRow } from './chips';
import { useT } from './i18n';
import { radius, space } from './theme';
import { Field, Icon, useColors, userText } from './ui';

/** A community's address from its name, like the web form: lower case letters, numbers and hyphens. */
export const autoSlug = (v: string) =>
  v
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 40);

/** Rules typed one per line. */
export const splitRules = (text: string) =>
  text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 20);

/** An online event's link: kept in its location, shown to people who can see the event. */
export const isWebLink = (s: string) => /^https?:\/\/\S+\.\S+/i.test(s.trim());

/** A field's own error under it, read out when it appears. */
export function FieldError({ text }: { text?: string | null }) {
  const c = useColors();
  if (!text) return null;
  return (
    <Text accessibilityLiveRegion="polite" style={{ color: c.danger, fontSize: 13 }}>
      {text}
    </Text>
  );
}

/** A form's label with the choices under it as radio chips (one of several). */
export function ChoiceField<T extends string>({
  label,
  hint,
  value,
  options,
  onChange,
}: {
  label: string;
  hint?: string;
  value: T;
  options: readonly { id: T; label: string; icon?: Parameters<typeof Chip>[0]['icon'] }[];
  onChange: (v: T) => void;
}) {
  const c = useColors();
  return (
    <View style={{ gap: space[2] }}>
      <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{label}</Text>
      <ChipRow radios label={label}>
        {options.map((o) => (
          <Chip key={o.id} radio label={o.label} icon={o.icon} selected={o.id === value} onPress={() => onChange(o.id)} />
        ))}
      </ChipRow>
      {hint ? <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{hint}</Text> : null}
    </View>
  );
}

const normalizeTopic = (s: string) => s.trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, '-').slice(0, 40);

/**
 * Topics as chips: type one and add it (or type a comma), tap a chip to remove it. At most `max`,
 * lower case, without repeats, like the web form.
 */
export function TopicsField({
  label,
  hint,
  value,
  onChange,
  max = 5,
}: {
  label: string;
  hint?: string;
  value: string[];
  onChange: (v: string[]) => void;
  max?: number;
}) {
  const c = useColors();
  const { t } = useT();
  const [draft, setDraft] = useState('');
  const add = (raw: string) => {
    const next = [...value];
    for (const part of raw.split(/[,\n]+/)) {
      const topic = normalizeTopic(part);
      if (topic && !next.includes(topic) && next.length < max) next.push(topic);
    }
    onChange(next);
    setDraft('');
  };
  const full = value.length >= max;
  return (
    <View style={{ gap: space[2] }}>
      <Field
        label={label}
        value={draft}
        editable={!full}
        placeholder={full ? t('m.form.topicsFull', { max }) : t('m.form.topicsPlaceholder')}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="done"
        maxLength={60}
        onChangeText={(v) => (/[,\n]/.test(v) ? add(v) : setDraft(v))}
        onSubmitEditing={() => draft.trim() && add(draft)}
        submitBehavior="submit"
      />
      {hint ? <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{hint}</Text> : null}
      {value.length ? (
        <ChipRow label={label}>
          {value.map((topic) => (
            <Chip
              key={topic}
              label={`#${topic}`}
              icon="close"
              a11yLabel={t('m.form.removeTopic', { topic })}
              onPress={() => onChange(value.filter((x) => x !== topic))}
            />
          ))}
        </ChipRow>
      ) : null}
    </View>
  );
}

/** A number with minus and plus buttons, read by screen readers as one adjustable value. */
export function Stepper({
  label,
  value,
  min,
  max,
  onChange,
  format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
}) {
  const c = useColors();
  const { t } = useT();
  const text = format ? format(value) : String(value);
  const btn = (icon: 'remove' | 'add', enabled: boolean, go: () => void, a11y: string) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityState={{ disabled: !enabled }}
      disabled={!enabled}
      onPress={go}
      hitSlop={4}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        borderRadius: radius.full,
        borderWidth: 1,
        borderColor: c.line,
        backgroundColor: c.surface,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: !enabled ? 0.4 : pressed ? 0.8 : 1,
      })}
    >
      <Icon name={icon} size={20} color={c.ink} />
    </Pressable>
  );
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
      <Text style={{ flex: 1, color: c.ink, fontWeight: '600', fontSize: 15 }}>{label}</Text>
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        accessibilityValue={{ text }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(e) => {
          if (e.nativeEvent.actionName === 'increment' && value < max) onChange(value + 1);
          if (e.nativeEvent.actionName === 'decrement' && value > min) onChange(value - 1);
        }}
        style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}
      >
        {btn('remove', value > min, () => onChange(value - 1), t('m.form.less'))}
        <Text style={{ color: c.ink, fontSize: 18, fontWeight: '800', minWidth: 36, textAlign: 'center', fontVariant: ['tabular-nums'] }}>{text}</Text>
        {btn('add', value < max, () => onChange(value + 1), t('m.form.more'))}
      </View>
    </View>
  );
}

/** Stars shown for a rating (not tappable): read out as "4 out of 5". */
export function Stars({ rating, size = 16 }: { rating: number; size?: number }) {
  const c = useColors();
  const { t } = useT();
  const whole = Math.round(rating);
  return (
    <View accessible accessibilityLabel={t('m.place.stars', { rating: String(rating) })} style={{ flexDirection: 'row', gap: 2 }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Icon key={n} name={n <= whole ? 'star' : 'star-outline'} size={size} color={n <= whole ? c.saffron : c.inkMuted} />
      ))}
    </View>
  );
}

/** Choosing a rating: five 44-point stars in a radio group. */
export function StarPicker({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  const c = useColors();
  const { t } = useT();
  return (
    <View style={{ gap: space[1] }}>
      <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{label}</Text>
      <View accessibilityRole="radiogroup" accessibilityLabel={label} style={{ flexDirection: 'row', gap: 2 }}>
        {[1, 2, 3, 4, 5].map((n) => (
          <Pressable
            key={n}
            accessibilityRole="radio"
            accessibilityLabel={t('m.place.stars', { rating: String(n) })}
            accessibilityState={{ checked: value === n }}
            onPress={() => onChange(n)}
            style={({ pressed }) => ({ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.7 : 1 })}
          >
            <Icon name={n <= value ? 'star' : 'star-outline'} size={30} color={n <= value ? c.saffron : c.inkMuted} />
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/** A small label in a pill: a role, a booking's status. */
export function Pill({ text, tone = 'neutral' }: { text: string; tone?: 'neutral' | 'good' | 'warn' | 'bad' }) {
  const c = useColors();
  const bg = tone === 'good' ? c.yapiSoft : tone === 'warn' ? c.saffronSoft : tone === 'bad' ? c.dangerSoft : c.surfaceSunken;
  return (
    <View style={{ backgroundColor: bg, borderRadius: radius.full, paddingHorizontal: space[2], paddingVertical: 2, alignSelf: 'flex-start' }}>
      <Text style={[{ color: c.ink, fontSize: 12, fontWeight: '700' }, userText]}>{text}</Text>
    </View>
  );
}

/** A labelled action at the end of a screen's header ("New"), 44 points tall. */
export function HeaderAction({ label, icon, onPress }: { label: string; icon: Parameters<typeof Icon>[0]['name']; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44, paddingHorizontal: space[1], opacity: pressed ? 0.7 : 1 })}
    >
      <Icon name={icon} size={20} color={c.yapi} />
      <Text style={{ color: c.yapi, fontWeight: '700', fontSize: 15 }}>{label}</Text>
    </Pressable>
  );
}
