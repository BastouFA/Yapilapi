import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { radius, space } from '../../mobile/lib/theme';
import { Avatar, Icon, useColors, userText } from '../../mobile/lib/ui';

/**
 * A row in Yap's lists, flat like a messenger's: avatar, a name and a line under it, and whatever
 * goes at the end (the time and unread count, a call button). Tall enough to tap anywhere on it.
 */
export function ListRow({
  name,
  avatarUrl,
  start,
  title,
  subtitle,
  subtitleStart,
  end,
  onPress,
  label,
  emphasis,
}: {
  name: string;
  avatarUrl?: string | null;
  /** Instead of the avatar (an icon, for a row like New group). */
  start?: ReactNode;
  title: string;
  subtitle?: string;
  /** Before the line under the name (a call's direction). */
  subtitleStart?: ReactNode;
  end?: ReactNode;
  onPress: () => void;
  /** What a screen reader says for the whole row, when the parts don't say it well on their own. */
  label?: string;
  /** Bold the line under the name (unread). */
  emphasis?: boolean;
}) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label ?? [title, subtitle].filter(Boolean).join(', ')}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: space[3],
        minHeight: 72,
        paddingVertical: space[2],
        paddingHorizontal: space[4],
        backgroundColor: pressed ? c.surfaceSunken : 'transparent',
      })}
    >
      {start ?? <Avatar name={name} url={avatarUrl} size={50} />}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[{ color: c.ink, fontWeight: '700', fontSize: 16 }, userText]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            {subtitleStart}
            <Text style={[{ flex: 1, color: emphasis ? c.ink : c.inkMuted, fontSize: 14, fontWeight: emphasis ? '600' : '400' }, userText]} numberOfLines={1}>
              {subtitle}
            </Text>
          </View>
        ) : null}
      </View>
      {end}
    </Pressable>
  );
}

/** The unread count on a chat, as `text` (in the reader's digits), and what a screen reader says. */
export function UnreadBadge({ text, label }: { text: string; label: string }) {
  const c = useColors();
  return (
    <View
      accessibilityLabel={label}
      style={{
        minWidth: 22,
        height: 22,
        borderRadius: radius.full,
        backgroundColor: c.yapi,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 6,
      }}
    >
      <Text style={{ color: c.onYapi, fontWeight: '700', fontSize: 12 }}>{text}</Text>
    </View>
  );
}

/** A round icon button in a header or at the end of a row: 44 points to tap. */
export function RoundButton({ icon, label, onPress }: { icon: Parameters<typeof Icon>[0]['name']; label: string; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        borderRadius: radius.full,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: pressed ? c.surfaceSunken : 'transparent',
      })}
    >
      <Icon name={icon} size={24} color={c.yapi} />
    </Pressable>
  );
}

/** An icon in a soft circle the size of an avatar, at the start of a row. */
export function RowIcon({ icon }: { icon: Parameters<typeof Icon>[0]['name'] }) {
  const c = useColors();
  return (
    <View style={{ width: 50, height: 50, borderRadius: radius.full, backgroundColor: c.yapiSoft, alignItems: 'center', justifyContent: 'center' }}>
      <Icon name={icon} size={24} color={c.yapi} />
    </View>
  );
}

/** A thin line between rows, lined up with the text (not the avatar). */
export function RowLine() {
  const c = useColors();
  return <View style={{ height: 1, backgroundColor: c.line, marginStart: space[4] + 50 + space[3] }} />;
}
