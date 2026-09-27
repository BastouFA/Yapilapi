import { Text, View } from 'react-native';
import type { NowStatusIcon } from '../../../packages/shared/src/constants';
import type { NowStatus } from '../../../packages/shared/src/types';
import { useT } from './i18n';
import { Icon, useColors, userText, type IconName } from './ui';

/** The design system's status icons, drawn with the matching Ionicons glyph (never emoji). */
export const NOW_ICON_GLYPHS: Record<NowStatusIcon, IconName> = {
  sparkle: 'sparkles-outline',
  music: 'musical-notes-outline',
  'map-pin': 'location-outline',
  calendar: 'calendar-outline',
  heart: 'heart-outline',
  globe: 'globe-outline',
  star: 'star-outline',
  mic: 'mic-outline',
};

/** A status still showing: the server drops them after 24 hours, and so does a screen left open. */
export const liveStatus = (s: NowStatus | null | undefined): NowStatus | null => (s && new Date(s.expiresAt).getTime() > Date.now() ? s : null);

/** One line: the status icon, then its text. `small` is for chat headers. */
export function NowStatusLine({ status, small, center }: { status: NowStatus; small?: boolean; center?: boolean }) {
  const c = useColors();
  const { t } = useT();
  return (
    <View
      accessible
      accessibilityLabel={t('m.now.a11y', { text: status.text })}
      style={{ flexDirection: 'row', alignItems: 'center', gap: small ? 4 : 6, justifyContent: center ? 'center' : 'flex-start', maxWidth: '100%' }}
    >
      {status.icon ? <Icon name={NOW_ICON_GLYPHS[status.icon]} size={small ? 12 : 16} color={small ? c.inkMuted : c.yapi} /> : null}
      <Text
        numberOfLines={1}
        style={[{ color: small ? c.inkMuted : c.ink, fontSize: small ? 12 : 14, flexShrink: 1, fontWeight: small ? '400' : '500' }, userText]}
      >
        {status.text}
      </Text>
    </View>
  );
}

type Listener = (status: NowStatus | null) => void;
const listeners = new Set<Listener>();

/** Tell open screens (your profile) that your status changed in the status sheet. */
export function statusChanged(status: NowStatus | null) {
  for (const l of listeners) l(status);
}

export function onStatusChanged(l: Listener) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
