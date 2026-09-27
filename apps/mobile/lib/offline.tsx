import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Animated, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useT } from './i18n';
import { useReducedMotion } from './motion';
import { checkConnection, onBackOnline, useOnline } from './network';
import { elevation, radius, space } from './theme';
import { Icon, useColors } from './ui';

/**
 * A small bar at the top of every screen while YAPILAPI can't be reached, with Try again. It goes
 * away on its own when the connection is back (lib/network.ts keeps checking), and screen readers
 * hear both changes. It never covers more than its own strip, so the screen underneath still works.
 */
export function OfflineBanner() {
  const c = useColors();
  const { t } = useT();
  const insets = useSafeAreaInsets();
  const online = useOnline();
  const reduce = useReducedMotion();
  const [checking, setChecking] = useState(false);
  const shown = useRef(new Animated.Value(online ? 0 : 1)).current;
  const [visible, setVisible] = useState(!online);

  useEffect(() => {
    if (!online) {
      setVisible(true);
      AccessibilityInfo.announceForAccessibility(t('m.offline.title'));
    }
    const to = online ? 0 : 1;
    if (reduce) {
      shown.setValue(to);
      if (online) setVisible(false);
      return;
    }
    Animated.timing(shown, { toValue: to, duration: 220, useNativeDriver: true }).start(({ finished }) => {
      if (finished && online) setVisible(false);
    });
  }, [online, reduce, shown, t]);

  useEffect(() => onBackOnline(() => AccessibilityInfo.announceForAccessibility(t('m.offline.back'))), [t]);

  if (!visible) return null;
  return (
    <Animated.View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        top: insets.top + space[1],
        start: space[3],
        end: space[3],
        alignItems: 'center',
        zIndex: 60,
        opacity: shown,
        transform: [{ translateY: shown.interpolate({ inputRange: [0, 1], outputRange: [-12, 0] }) }],
      }}
    >
      <View
        accessibilityLiveRegion="polite"
        style={[
          {
            flexDirection: 'row',
            alignItems: 'center',
            gap: space[2],
            backgroundColor: c.ink,
            borderRadius: radius.full,
            paddingStart: space[4],
            paddingEnd: space[1],
            minHeight: 44,
            maxWidth: 460,
          },
          elevation(c, 'lg'),
        ]}
      >
        <Icon name="cloud-offline-outline" size={18} color={c.ground} />
        <Text style={{ color: c.ground, fontWeight: '600', fontSize: 14, flexShrink: 1 }} numberOfLines={2}>
          {t('m.offline.title')}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('m.offline.retry')}
          accessibilityState={{ busy: checking }}
          disabled={checking}
          hitSlop={4}
          onPress={async () => {
            setChecking(true);
            const ok = await checkConnection();
            setChecking(false);
            if (!ok) AccessibilityInfo.announceForAccessibility(t('m.offline.still'));
          }}
          style={({ pressed }) => ({
            minWidth: 44,
            height: 36,
            paddingHorizontal: space[3],
            borderRadius: radius.full,
            backgroundColor: c.ground,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: pressed ? 0.8 : 1,
          })}
        >
          {checking ? (
            <ActivityIndicator size="small" color={c.ink} />
          ) : (
            <Text style={{ color: c.ink, fontWeight: '700', fontSize: 13 }}>{t('m.offline.retry')}</Text>
          )}
        </Pressable>
      </View>
    </Animated.View>
  );
}
