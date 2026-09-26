import { createAudioPlayer, setAudioModeAsync, type AudioPlayer, type AudioStatus } from 'expo-audio';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Animated, AppState, Easing, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { YapEvent } from '../../../packages/shared/src/types';
import { mediaUrl } from './api';
import { useT } from './i18n';
import { useRealtime, useSession } from './session';
import { elevation, radius, space } from './theme';
import { Icon, useColors, userText } from './ui';

/** A yap is up to 60 seconds: recording stops there and sends. */
export const YAP_MAX_MS = 60_000;
/** Shorter than this is a slip of the finger: not sent. */
export const YAP_MIN_MS = 400;

/**
 * Plays incoming yaps out loud, one after another, while the app is in the foreground and
 * the server said this person allows it (`autoplay`). Shows "Yap from Name" with a moving
 * waveform; tap it to open the chat. Yaps that don't autoplay arrive silently in the chat.
 */
export function YapPlayer() {
  const { me } = useSession();
  const { t } = useT();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queue = useRef<YapEvent[]>([]);
  const player = useRef<AudioPlayer | null>(null);
  const [now, setNow] = useState<YapEvent | null>(null);

  const stop = () => {
    const p = player.current;
    player.current = null;
    if (p) {
      try {
        p.pause();
        p.remove();
      } catch {
        // Already released.
      }
    }
  };

  const next = async () => {
    if (player.current) return;
    const e = queue.current.shift();
    if (!e) {
      setNow(null);
      return;
    }
    const url = e.message.attachments[0]?.url;
    if (!url) return void next();
    await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false }).catch(() => {});
    const p = createAudioPlayer(mediaUrl(url));
    player.current = p;
    setNow(e);
    // AudioPlayer is a SharedObject with events; its base type doesn't resolve in this install, so it's spelled out.
    const events = p as unknown as { addListener(event: 'playbackStatusUpdate', fn: (s: AudioStatus) => void): { remove(): void } };
    events.addListener('playbackStatusUpdate', (s) => {
      if (!s.didJustFinish || player.current !== p) return;
      stop();
      void next();
    });
    p.play();
  };

  const skip = () => {
    stop();
    void next();
  };

  useRealtime((e) => {
    if (e.type !== 'yap' || !me) return;
    const y = e.data as YapEvent;
    // Only while the app is open in front of you; otherwise it waits in the chat.
    if (!y.autoplay || y.message.sender.id === me.id || AppState.currentState !== 'active') return;
    queue.current.push(y);
    void next();
  });

  // Going to the background stops playback and drops what was queued.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') return;
      queue.current = [];
      stop();
      setNow(null);
    });
    return () => {
      sub.remove();
      stop();
    };
  }, []);

  if (!now) return null;
  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', top: insets.top + space[2], start: 0, end: 0, alignItems: 'center', zIndex: 50 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('m.yap.from', { name: now.message.sender.displayName })}
        accessibilityHint={t('m.yap.openChat')}
        onPress={() => router.push(`/chat/${now.conversationId}`)}
        style={[
          {
            flexDirection: 'row',
            alignItems: 'center',
            gap: space[2],
            paddingStart: space[4],
            paddingEnd: space[2],
            paddingVertical: space[2],
            borderRadius: radius.full,
            backgroundColor: c.surface,
            maxWidth: '92%',
          },
          elevation(c, 'lg'),
        ]}
      >
        <Icon name="volume-high" size={18} color={c.yapi} />
        <Text numberOfLines={1} style={[{ color: c.ink, fontWeight: '700', fontSize: 14, flexShrink: 1 }, userText]}>
          {t('m.yap.from', { name: now.message.sender.displayName })}
        </Text>
        <Waveform color={c.yapi} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('m.yap.stop')}
          hitSlop={8}
          onPress={skip}
          style={{ width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: c.surfaceSunken }}
        >
          <Icon name="stop" size={14} color={c.ink} />
        </Pressable>
      </Pressable>
    </View>
  );
}

/** Bars that move while a yap plays. */
export function Waveform({ color, bars = 9, height = 20 }: { color: string; bars?: number; height?: number }) {
  const values = useRef(Array.from({ length: bars }, () => new Animated.Value(0.3))).current;
  useEffect(() => {
    const loops = values.map((v, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.timing(v, { toValue: 1, duration: 260 + ((i * 97) % 220), easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
          Animated.timing(v, { toValue: 0.25, duration: 240 + ((i * 53) % 200), easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        ]),
      ),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [values]);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, height }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {values.map((v, i) => (
        <Animated.View key={i} style={{ width: 3, height, borderRadius: 2, backgroundColor: color, transform: [{ scaleY: v }] }} />
      ))}
    </View>
  );
}
