import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Animated, Image, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NavGlyphName } from '../../../packages/shared/src/nav-glyphs';
import { useT } from '../lib/i18n';
import { useReducedMotion } from '../lib/motion';
import { NavGlyph } from '../lib/nav-glyphs';
import { radius, space } from '../lib/theme';
import { Button, useColors } from '../lib/ui';

const logo = require('../assets/splash-icon.png');

/**
 * The first screen for someone who isn't signed in: the brand, what the app is for in three
 * lines (Pulse, Wander, Yap, with their own symbols), then Create account or Log in.
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

  const lines: { glyph: NavGlyphName; title: string; body: string }[] = [
    { glyph: 'pulse', title: t('nav.home'), body: t('m.welcome.pulse') },
    { glyph: 'wander', title: t('nav.discover'), body: t('m.welcome.wander') },
    { glyph: 'yap', title: t('nav.inbox'), body: t('m.welcome.yap') },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: c.ground }}>
      {/* A soft wash of the brand colour behind the logo. */}
      <LinearGradient
        colors={[c.yapiSoft, c.ground]}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={{ position: 'absolute', top: 0, start: 0, end: 0, height: 360 }}
        pointerEvents="none"
      />
      <ScrollView
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
            YAPILAPI
          </Text>
          <Text style={{ color: c.inkMuted, fontSize: 17, textAlign: 'center', lineHeight: 24 }}>{t('app.tagline')}</Text>
        </Animated.View>

        <View style={{ gap: space[3] }}>
          {lines.map((l) => (
            <View
              key={l.glyph}
              accessible
              accessibilityLabel={`${l.title}. ${l.body}`}
              style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], backgroundColor: c.surface, borderRadius: radius.lg, padding: space[3] }}
            >
              <View style={{ width: 44, height: 44, borderRadius: 15, backgroundColor: c.yapiSoft, alignItems: 'center', justifyContent: 'center' }}>
                <NavGlyph name={l.glyph} color={c.yapi} tone="duo" />
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
