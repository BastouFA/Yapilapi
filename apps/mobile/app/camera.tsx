import { CameraView, useCameraPermissions, useMicrophonePermissions, type CameraType } from 'expo-camera';
import { File } from 'expo-file-system';
import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { createVideoPlayer } from 'expo-video';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Alert,
  Animated,
  AppState,
  Dimensions,
  Easing,
  I18nManager,
  Linking,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type AccessibilityActionEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { MessageKey } from '../../../packages/shared/src/i18n';
import { createModeFrom, deliverPendingAsset, type CreateMode } from '../lib/create-sheet';
import { useT } from '../lib/i18n';
import { CLIP_MAX_SECONDS, clock, pickOne, PLUS_REEL_MAX_SECONDS, REEL_MAX_SECONDS, type Picked } from '../lib/media';
import { useSession } from '../lib/session';
import { palette, radius, space } from '../lib/theme';
import { Button, Icon, type IconName } from '../lib/ui';

const MODES = [
  { id: 'post', label: 'm.create.mode.post' },
  { id: 'reel', label: 'm.create.mode.reel' },
  { id: 'story', label: 'm.create.mode.story' },
] as const satisfies readonly { id: CreateMode; label: MessageKey }[];

type Flash = 'off' | 'on' | 'auto';
const FLASH: Record<Flash, { icon: IconName; label: MessageKey }> = {
  off: { icon: 'flash-off', label: 'm.camera.flashOff' },
  on: { icon: 'flash', label: 'm.camera.flashOn' },
  auto: { icon: 'flash-outline', label: 'm.camera.flashAuto' },
};

/** 'hold': press and hold the shutter (Post, Story). 'toggle': tap to start, tap to stop (Reel). */
type Recording = 'hold' | 'toggle';

// The camera is always dark, whatever the phone's theme.
const c = palette('dark');
const WHITE = '#FFFFFF';
const SHUTTER = 84;
const RING = 5;
/** Width of one entry in the mode switcher. */
const MODE_WIDTH = 96;
/** Shorter recordings often come out empty: stopping waits until the video is at least this long. */
const MIN_RECORDING_MS = 700;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function fileSize(uri: string): number | undefined {
  try {
    return new File(uri).size || undefined;
  } catch {
    return undefined;
  }
}

/** A just-recorded video as a picked asset: its real length and upright size, read from the file. */
async function recordedVideo(uri: string, recordedMs: number): Promise<Picked> {
  let duration = recordedMs;
  let width = 0;
  let height = 0;
  const player = createVideoPlayer(uri);
  try {
    await new Promise<void>((resolve) => {
      let sub: { remove: () => void } | undefined;
      const done = () => {
        clearTimeout(timer);
        sub?.remove();
        resolve();
      };
      const timer = setTimeout(done, 3000);
      if (player.status === 'readyToPlay' || player.status === 'error') return done();
      sub = player.addListener('statusChange', ({ status }) => {
        if (status === 'readyToPlay' || status === 'error') done();
      });
    });
    if (player.duration > 0) duration = Math.round(player.duration * 1000);
    // A frame comes out the right way up, unlike the track's stored size.
    const [frame] = await player.generateThumbnailsAsync(0);
    if (frame) {
      width = frame.width;
      height = frame.height;
    }
  } catch {
    // Fall back to the recorded time and the screen's shape.
  } finally {
    player.release();
  }
  if (!width || !height) {
    const screen = Dimensions.get('window');
    width = 1080;
    height = Math.round((1080 * screen.height) / screen.width);
  }
  const mov = uri.toLowerCase().endsWith('.mov');
  return {
    uri,
    type: 'video',
    mimeType: mov ? 'video/quicktime' : 'video/mp4',
    fileName: mov ? 'video.mov' : 'video.mp4',
    width,
    height,
    duration,
    fileSize: fileSize(uri),
  };
}

/**
 * The in-app camera that "+" opens, like Instagram's: pick Post, Reel or Story at the bottom,
 * take a photo (tap) or a video (hold, or tap to start and stop in Reel), or choose from the
 * library. What is taken is handed to Create, which opens the editor.
 */
export default function Camera() {
  const { t } = useT();
  const { me } = useSession();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ mode?: string }>();
  const [mode, setMode] = useState<CreateMode>(createModeFrom(params.mode) ?? 'post');
  const [facing, setFacing] = useState<CameraType>('back');
  const [flash, setFlash] = useState<Flash>('off');
  // Post and Story take photos; the camera switches to video only while holding the shutter.
  const [videoMode, setVideoMode] = useState(false);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState(false);
  const [camPerm, requestCam, getCam] = useCameraPermissions();
  const [micPerm, requestMic, getMic] = useMicrophonePermissions();

  const camera = useRef<CameraView>(null);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const holding = useRef(false);
  const recordingRef = useRef<Recording | null>(null);
  const startedAt = useRef(0);
  const readyWaiters = useRef<(() => void)[]>([]);
  const progress = useRef(new Animated.Value(0)).current;
  const modeX = useRef(new Animated.Value(0)).current;
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const reelMax = me?.plus ? PLUS_REEL_MAX_SECONDS : REEL_MAX_SECONDS;
  const maxSeconds = mode === 'reel' ? reelMax : CLIP_MAX_SECONDS;
  const granted = !!camPerm?.granted;
  const shownFlash: Flash = mode === 'reel' && flash === 'auto' ? 'off' : flash;
  const back = facing === 'back';

  useEffect(
    () => () => {
      mounted.current = false;
      if (recordingRef.current) camera.current?.stopRecording();
    },
    [],
  );

  // Ask for the camera once when the screen opens, and for the microphone once Reel is chosen.
  const askedCam = useRef(false);
  useEffect(() => {
    if (!camPerm || camPerm.granted || !camPerm.canAskAgain || askedCam.current) return;
    askedCam.current = true;
    void requestCam();
  }, [camPerm, requestCam]);
  const askedMic = useRef(false);
  useEffect(() => {
    if (mode !== 'reel' || !granted || !micPerm || micPerm.granted || !micPerm.canAskAgain || askedMic.current) return;
    askedMic.current = true;
    void requestMic();
  }, [mode, granted, micPerm, requestMic]);
  // Coming back from Settings: pick up what changed there.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      void getCam();
      void getMic();
    });
    return () => sub.remove();
  }, [getCam, getMic]);

  // The selected mode sits in the middle of the switcher.
  const modeIndex = MODES.findIndex((m) => m.id === mode);
  useEffect(() => {
    const position = I18nManager.isRTL ? MODES.length - 1 - modeIndex : modeIndex;
    Animated.spring(modeX, { toValue: (1 - position) * MODE_WIDTH, useNativeDriver: true, speed: 18, bounciness: 4 }).start();
  }, [modeIndex, modeX]);

  // The timer, and a backstop for the length limit.
  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => {
      const s = (Date.now() - startedAt.current) / 1000;
      setElapsed(s);
      if (s > maxSeconds + 0.5) camera.current?.stopRecording();
    }, 250);
    return () => clearInterval(id);
  }, [recording, maxSeconds]);

  function choose(next: CreateMode) {
    if (recordingRef.current || busyRef.current) return;
    setMode(next);
    setVideoMode(false);
  }

  /** Swipe left or right anywhere on the preview (or the switcher) to change mode. */
  const swipe = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 16 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
        onMoveShouldSetPanResponderCapture: (_, g) => Math.abs(g.dx) > 16 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
        onPanResponderTerminationRequest: () => true,
        onPanResponderRelease: (_, g) => {
          if (Math.abs(g.dx) < 40) return;
          // Swiping left brings the entry on the right to the middle; the order is mirrored in RTL.
          const step = (g.dx < 0 ? 1 : -1) * (I18nManager.isRTL ? -1 : 1);
          const i = MODES.findIndex((m) => m.id === modeRef.current) + step;
          const next = MODES[i];
          if (next) choose(next.id);
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  function close() {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }

  /** Hand the photo or video to Create, which opens the editor, and put Create in the camera's place. */
  function handOff(asset: Picked) {
    deliverPendingAsset(asset, mode);
    // Back to the tabs already underneath (a plain replace would stack a second copy of them).
    router.dismissTo({ pathname: '/create', params: mode === 'post' ? {} : { mode } });
  }

  function writeInstead() {
    router.dismissTo({ pathname: '/create', params: { mode } });
  }

  async function openGallery() {
    if (busyRef.current || recordingRef.current) return;
    const asset = await pickOne(mode === 'reel' ? ['videos'] : ['images', 'videos'], reelMax).catch(() => null);
    if (asset === 'denied')
      return Alert.alert(t('m.create.photosPermission'), undefined, [
        { text: t('m.create.cancel'), style: 'cancel' },
        { text: t('m.common.openSettings'), onPress: () => void Linking.openSettings() },
      ]);
    if (asset && mounted.current) handOff(asset);
  }

  async function takePhoto() {
    if (busyRef.current || recordingRef.current || !camera.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const photo = await camera.current.takePictureAsync({ quality: 0.9, exif: false });
      if (!photo?.uri) throw new Error('no photo');
      const png = photo.format === 'png';
      if (!mounted.current) return;
      handOff({
        uri: photo.uri,
        type: 'image',
        mimeType: png ? 'image/png' : 'image/jpeg',
        fileName: png ? 'photo.png' : 'photo.jpg',
        width: photo.width,
        height: photo.height,
        fileSize: fileSize(photo.uri),
      });
    } catch {
      if (mounted.current) Alert.alert(t('m.camera.photoFailed'));
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  function askForMicrophone() {
    Alert.alert(t('m.camera.micPermission'), undefined, [
      { text: t('m.create.cancel'), style: 'cancel' },
      { text: t('m.common.openSettings'), onPress: () => void Linking.openSettings() },
    ]);
  }

  /** Resolves when the camera says it is ready again (Android, after switching to video), or after `ms`. */
  function cameraReady(ms: number) {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        readyWaiters.current = readyWaiters.current.filter((w) => w !== done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      readyWaiters.current.push(done);
    });
  }

  async function startRecording(kind: Recording) {
    if (busyRef.current || recordingRef.current || !camera.current) return;
    busyRef.current = true;
    setBusy(true);
    const clip = modeRef.current !== 'reel';
    let started = false;
    try {
      if (!micPerm?.granted) {
        const asked = micPerm?.canAskAgain === false ? null : await requestMic();
        if (!asked?.granted) return askForMicrophone();
        // The permission prompt ended the press: hold again to record.
        if (kind === 'hold') return;
        await sleep(400);
      }
      if (clip) {
        setVideoMode(true);
        // iOS keeps its session and only adds the video output; Android rebinds the camera.
        await (Platform.OS === 'ios' ? sleep(450) : Promise.all([cameraReady(2500), sleep(600)]));
      }
      if ((kind === 'hold' && !holding.current) || !mounted.current || !camera.current) return;
      started = true;
      recordingRef.current = kind;
      startedAt.current = Date.now();
      setElapsed(0);
      setRecording(kind);
      busyRef.current = false;
      setBusy(false);
      progress.setValue(0);
      Animated.timing(progress, { toValue: 1, duration: maxSeconds * 1000, easing: Easing.linear, useNativeDriver: true }).start();

      let uri: string | undefined;
      try {
        uri = (await camera.current.recordAsync({ maxDuration: maxSeconds }))?.uri;
      } catch {
        // Very short takes can fail on their own; only longer ones are worth a message.
        if (mounted.current && Date.now() - startedAt.current > 1500) Alert.alert(t('m.camera.videoFailed'));
      }
      const ms = Date.now() - startedAt.current;
      recordingRef.current = null;
      progress.stopAnimation();
      progress.setValue(0);
      if (!mounted.current) return;
      setRecording(null);
      if (uri) {
        setBusy(true);
        busyRef.current = true;
        const asset = await recordedVideo(uri, ms);
        if (mounted.current) handOff(asset);
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) {
        setBusy(false);
        if (clip && !started) setVideoMode(false);
        else if (clip) setTimeout(() => mounted.current && setVideoMode(false), 800);
      }
    }
  }

  function stopRecording() {
    if (!recordingRef.current) return;
    const wait = MIN_RECORDING_MS - (Date.now() - startedAt.current);
    if (wait > 0) setTimeout(() => camera.current?.stopRecording(), wait);
    else camera.current?.stopRecording();
  }

  function onShutter() {
    if (recordingRef.current) return stopRecording();
    if (mode === 'reel') void startRecording('toggle');
    else void takePhoto();
  }

  function onShutterAction(e: AccessibilityActionEvent) {
    if (e.nativeEvent.actionName === 'record') void startRecording('toggle');
  }

  function cycleFlash() {
    const order: Flash[] = mode === 'reel' ? ['off', 'on'] : ['off', 'on', 'auto'];
    setFlash(order[(order.indexOf(shownFlash) + 1) % order.length]!);
  }

  const clipMode = mode !== 'reel';
  const shutterLabel = recording ? t('m.camera.stopRecording') : clipMode ? t('m.camera.takePhoto') : t('m.camera.startRecording');
  const torch = back && shownFlash === 'on' && (mode === 'reel' || !!recording);
  const writeLabel = mode === 'post' ? t('m.create.textOnly') : mode === 'story' ? t('m.camera.writeStory') : null;

  return (
    <View style={s.root}>
      <StatusBar hidden />
      {granted ? (
        <CameraView
          ref={camera}
          style={StyleSheet.absoluteFill}
          facing={facing}
          mode={mode === 'reel' || videoMode ? 'video' : 'picture'}
          flash={back ? shownFlash : 'off'}
          enableTorch={torch}
          mute={!micPerm?.granted}
          onCameraReady={() => readyWaiters.current.slice().forEach((w) => w())}
        />
      ) : null}

      {/* Swipe surface over the preview. */}
      <View style={StyleSheet.absoluteFill} {...swipe.panHandlers} />

      {camPerm && !granted ? (
        <View style={[StyleSheet.absoluteFill, s.center]} pointerEvents="box-none">
          <View style={s.permission}>
            <Icon name="camera-outline" size={40} color={WHITE} />
            <Text style={s.permissionText}>{camPerm.canAskAgain ? t('m.camera.permission') : t('m.camera.denied')}</Text>
            {camPerm.canAskAgain ? (
              <Button label={t('m.real.allowCamera')} onPress={() => void requestCam()} />
            ) : (
              <Button label={t('m.common.openSettings')} onPress={() => void Linking.openSettings()} />
            )}
          </View>
        </View>
      ) : null}

      {/* Top: close, flash, write instead; the timer while recording. */}
      <View style={[s.top, { top: insets.top + space[2] }]} pointerEvents="box-none">
        {recording ? (
          <View style={s.timer} accessible accessibilityLabel={t('m.camera.recording', { time: clock(elapsed) })}>
            <View style={s.dot} />
            <Text style={s.timerText}>
              {clock(elapsed)} / {clock(maxSeconds)}
            </Text>
          </View>
        ) : (
          <>
            <RoundButton icon="close" label={t('m.camera.close')} onPress={close} />
            {granted && back ? <RoundButton icon={FLASH[shownFlash].icon} label={t(FLASH[shownFlash].label)} onPress={cycleFlash} /> : <View style={s.slot} />}
            {writeLabel ? (
              <RoundButton label={writeLabel} onPress={writeInstead}>
                <Text style={s.aa}>Aa</Text>
              </RoundButton>
            ) : (
              <View style={s.slot} />
            )}
          </>
        )}
      </View>

      {/* Bottom: gallery, shutter, flip; the mode switcher under them. */}
      <View style={[s.bottom, { paddingBottom: insets.bottom + space[3] }]} pointerEvents="box-none">
        <View style={s.controls}>
          {recording ? (
            <View style={s.slot} />
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('m.create.library')}
              onPress={() => void openGallery()}
              hitSlop={8}
              style={({ pressed }) => [s.gallery, pressed && { opacity: 0.7 }]}
            >
              <Icon name="images-outline" size={24} color={WHITE} />
            </Pressable>
          )}

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={shutterLabel}
            accessibilityHint={clipMode && !recording ? t('m.camera.holdHint') : undefined}
            accessibilityState={{ disabled: !granted || (busy && !recording) }}
            accessibilityActions={clipMode && !recording ? [{ name: 'record', label: t('m.camera.startRecording') }] : undefined}
            onAccessibilityAction={onShutterAction}
            disabled={!granted}
            onPressIn={() => {
              holding.current = true;
            }}
            onPressOut={() => {
              holding.current = false;
              if (recordingRef.current === 'hold') stopRecording();
            }}
            onPress={onShutter}
            onLongPress={clipMode ? () => void startRecording('hold') : undefined}
            delayLongPress={250}
            style={[s.shutter, !granted && { opacity: 0.35 }]}
          >
            <ProgressRing progress={progress} active={!!recording} />
            <View
              style={[
                s.shutterInner,
                clipMode && !recording && { backgroundColor: WHITE },
                (mode === 'reel' || recording) && { backgroundColor: c.danger },
                recording === 'toggle' && s.shutterStop,
                recording === 'hold' && s.shutterHold,
                busy && !recording && { opacity: 0.6 },
              ]}
            />
          </Pressable>

          {recording || !granted ? (
            <View style={s.slot} />
          ) : (
            <RoundButton icon="camera-reverse-outline" label={t('m.camera.flip')} onPress={() => setFacing((f) => (f === 'back' ? 'front' : 'back'))} />
          )}
        </View>

        <View
          accessibilityRole="tablist"
          accessibilityLabel={t('m.camera.modes')}
          style={[s.modes, recording && { opacity: 0 }]}
          pointerEvents={recording ? 'none' : 'auto'}
          importantForAccessibility={recording ? 'no-hide-descendants' : 'auto'}
          accessibilityElementsHidden={!!recording}
          {...swipe.panHandlers}
        >
          <Animated.View style={[s.modeRow, { transform: [{ translateX: modeX }] }]}>
            {MODES.map((m) => {
              const on = m.id === mode;
              return (
                <Pressable
                  key={m.id}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: on, disabled: !!recording }}
                  onPress={() => choose(m.id)}
                  style={s.mode}
                >
                  <Text style={[s.modeText, on && s.modeTextOn]} numberOfLines={1} adjustsFontSizeToFit>
                    {t(m.label)}
                  </Text>
                </Pressable>
              );
            })}
          </Animated.View>
        </View>
      </View>
    </View>
  );
}

function RoundButton({ icon, label, onPress, children }: { icon?: IconName; label: string; onPress: () => void; children?: ReactNode }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [s.round, pressed && { opacity: 0.7 }]}
    >
      {icon ? <Icon name={icon} size={24} color={WHITE} /> : children}
    </Pressable>
  );
}

/**
 * The ring around the shutter filling up while recording, without SVG: each half of the circle
 * is clipped, and a half-ring turns into view inside it.
 */
function ProgressRing({ progress, active }: { progress: Animated.Value; active: boolean }) {
  const half = SHUTTER / 2;
  const right = progress.interpolate({ inputRange: [0, 0.5], outputRange: ['-135deg', '45deg'], extrapolate: 'clamp' });
  const left = progress.interpolate({ inputRange: [0.5, 1], outputRange: ['45deg', '225deg'], extrapolate: 'clamp' });
  const arc = { borderTopColor: c.danger, borderRightColor: c.danger };
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <View style={[s.ring, { borderColor: active ? 'rgba(255,255,255,0.35)' : WHITE }]} />
      {active ? (
        <>
          <View style={[s.clip, { left: half }]}>
            <Animated.View style={[s.ring, s.arc, arc, { left: -half, transform: [{ rotate: right }] }]} />
          </View>
          <View style={[s.clip, { left: 0 }]}>
            <Animated.View style={[s.ring, s.arc, arc, { left: 0, transform: [{ rotate: left }] }]} />
          </View>
        </>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  center: { alignItems: 'center', justifyContent: 'center', padding: space[6] },
  permission: { alignItems: 'center', gap: space[3], maxWidth: 320 },
  permissionText: { color: WHITE, fontSize: 16, lineHeight: 22, textAlign: 'center' },
  top: { position: 'absolute', start: space[4], end: space[4], flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  round: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.35)' },
  slot: { width: 44, height: 44 },
  aa: { color: WHITE, fontSize: 17, fontWeight: '700' },
  timer: {
    flex: 1,
    flexDirection: 'row',
    alignSelf: 'center',
    justifyContent: 'center',
    alignItems: 'center',
    gap: space[2],
    height: 44,
  },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: c.danger },
  timerText: { color: WHITE, fontSize: 16, fontWeight: '700', fontVariant: ['tabular-nums'] },
  bottom: { position: 'absolute', start: 0, end: 0, bottom: 0, gap: space[3] },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space[6] },
  gallery: {
    width: 44,
    height: 44,
    borderRadius: radius.sm,
    borderWidth: 2,
    borderColor: WHITE,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  shutter: { width: SHUTTER, height: SHUTTER, alignItems: 'center', justifyContent: 'center' },
  shutterInner: { width: SHUTTER - 18, height: SHUTTER - 18, borderRadius: (SHUTTER - 18) / 2 },
  shutterStop: { width: 30, height: 30, borderRadius: 6 },
  shutterHold: { width: SHUTTER - 30, height: SHUTTER - 30, borderRadius: (SHUTTER - 30) / 2 },
  ring: { position: 'absolute', top: 0, width: SHUTTER, height: SHUTTER, borderRadius: SHUTTER / 2, borderWidth: RING },
  arc: { borderColor: 'transparent' },
  clip: { position: 'absolute', top: 0, width: SHUTTER / 2, height: SHUTTER, overflow: 'hidden' },
  modes: { height: 40, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  modeRow: { flexDirection: 'row' },
  mode: { width: MODE_WIDTH, height: 40, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space[1] },
  modeText: { color: 'rgba(255,255,255,0.6)', fontSize: 14, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase' },
  modeTextOn: { color: WHITE },
});
