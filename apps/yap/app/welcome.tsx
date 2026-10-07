import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Animated, Image, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useT } from '../../mobile/lib/i18n';
import { useReducedMotion } from '../../mobile/lib/motion';
import { radius, space } from '../../mobile/lib/theme';
import { Button, Icon, useColors, type IconName } from '../../mobile/lib/ui';

const logo = require('../assets/splash-icon.png');

/**
 * The first screen for someone who isn't signed in: Yap's mark, what it's for in three lines, then
 * Create account or Log in. It's a YAPILAPI account either way, so the sign-in screens are the
 * phone app's.
 */
export default function Welcome() {
  const c = useColors();
  const { t } = useT();
  const insets = useSafeAreaInsets();
  const reduce = useReducedMotion();
  const rise = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reduce) return rise.setValue(1);
    Animated.timing(rise, { toValue: 1, duration: 520, useNativeDriver: true }).start();
  }, [reduce, rise]);

  const lines: { icon: IconName; title: string; body: string }[] = [
    { icon: 'chatbubbles-outline', title: t('yapApp.tab.chats'), body: t('yapApp.welcome.chats') },
    { icon: 'call-outline', title: t('yapApp.tab.calls'), body: t('yapApp.welcome.calls') },
    { icon: 'person-circle-outline', title: t('yapApp.welcome.accountTitle'), body: t('yapApp.welcome.account') },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: c.ground }}>
      {/* A soft wash of the brand colour behind the mark. */}
      <LinearGradient
        colors={[c.yapiSoft, c.ground]}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={{ position: 'absolute', top: 0, start: 0, end: 0, height: 360 }}
        pointerEvents="none"
      />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          flexGrow: 1,
          paddingTop: insets.top + space[8],
          paddingBottom: insets.bottom + space[6],
          paddingHorizontal: space[6],
          gap: space[6],
          maxWidth: 520,
          width: '100%',
          alignSelf: 'center',
        }}
      >
        <Animated.View
          style={{
            alignItems: 'center',
            gap: space[3],
            opacity: rise,
            transform: [{ translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }],
          }}
        >
          <Image source={logo} accessibilityIgnoresInvertColors style={{ width: 88, height: 88 }} accessible={false} />
          <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 34, fontWeight: '800', letterSpacing: 1 }}>
            Yap
          </Text>
          <Text style={{ color: c.inkMuted, fontSize: 17, textAlign: 'center', lineHeight: 24 }}>{t('yapApp.tagline')}</Text>
        </Animated.View>

        <View style={{ gap: space[3] }}>
          {lines.map((l) => (
            <View
              key={l.icon}
              accessible
              accessibilityLabel={`${l.title}. ${l.body}`}
              style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], backgroundColor: c.surface, borderRadius: radius.lg, padding: space[3] }}
            >
              <View style={{ width: 44, height: 44, borderRadius: 15, backgroundColor: c.yapiSoft, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name={l.icon} color={c.yapi} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: c.ink, fontWeight: '800', fontSize: 15 }}>{l.title}</Text>
                <Text style={{ color: c.inkMuted, fontSize: 14, lineHeight: 19 }}>{l.body}</Text>
              </View>
            </View>
          ))}
        </View>

        <View style={{ flex: 1 }} />
        <View style={{ gap: space[3] }}>
          <Button label={t('m.welcome.create')} onPress={() => router.push('/signup')} />
          <Button label={t('m.welcome.login')} variant="secondary" onPress={() => router.push('/login')} />
        </View>
      </ScrollView>
    </View>
  );
}
