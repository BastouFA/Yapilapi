import { router, useLocalSearchParams } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { MessageKey } from '../../../../packages/shared/src/i18n';
import {
  ECHO_BALANCE_DEFAULT,
  ECHO_BLOCK_KEYS,
  ECHO_CUT_MAX_MS,
  ECHO_CUT_MIN_MS,
  ECHO_LAYOUTS,
  echoFrame,
  echoShare,
  type EchoLayout,
  type EchoOptions,
  type EchoRender,
} from '../../../../packages/shared/src/echoes';
import { formatReelTime } from '../../../../packages/shared/src/reels';
import { client, errorMessage, isGone, mediaUrl } from '../../lib/api';
import { onEchoAsset, takeEchoAsset } from '../../lib/create-sheet';
import { Slider } from '../../lib/editor';
import { useT } from '../../lib/i18n';
import { pickOne, uploadPicked, type Picked } from '../../lib/media';
import { radius, space } from '../../lib/theme';
import { Avatar, Button, EmptyState, Field, KeyboardAvoid, Loading, Notice, ScreenError, Segmented, SwitchRow, useColors, userText } from '../../lib/ui';
import { noticeText } from '../../../../packages/shared/src/server-text';

const LAYOUT_KEYS: Record<EchoLayout, { label: MessageKey; hint: MessageKey }> = {
  side: { label: 'echo.layout.side', hint: 'echo.layout.sideHint' },
  stack: { label: 'echo.layout.stack', hint: 'echo.layout.stackHint' },
  corner: { label: 'echo.layout.corner', hint: 'echo.layout.cornerHint' },
};
const AUDIENCES = ['public', 'followers', 'friends', 'private'] as const;
type Audience = (typeof AUDIENCES)[number];

/** Where each video sits in a layout, as percentages of the frame (the same numbers the server uses). */
function place(layout: EchoLayout, who: 'theirs' | 'yours') {
  const f = echoFrame(layout);
  const r = echoShare(f[who], f);
  return {
    position: 'absolute' as const,
    left: `${r.left * 100}%` as const,
    top: `${r.top * 100}%` as const,
    width: `${r.width * 100}%` as const,
    height: `${r.height * 100}%` as const,
  };
}

/** A muted, looping preview of one of the two videos. */
function PreviewVideo({ uri, style, label }: { uri: string; style: object; label: string }) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = true;
    p.muted = true;
    p.play();
  });
  return (
    <View style={style} accessible accessibilityLabel={label}>
      <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="cover" nativeControls={false} pointerEvents="none" />
    </View>
  );
}

/** The finished echo, with the player's own controls so it can be watched with sound before posting. */
function ResultVideo({ uri, ratio, label }: { uri: string; ratio: number; label: string }) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = true;
  });
  return (
    <View
      style={{ width: '100%', maxWidth: 360, alignSelf: 'center', aspectRatio: ratio, borderRadius: radius.lg, overflow: 'hidden', backgroundColor: '#05060B' }}
    >
      <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="contain" nativeControls accessibilityLabel={label} />
    </View>
  );
}

/**
 * Echo: answer a reel with your own video. Record one in the camera or choose one, pick how the
 * two sit together, optionally a part of theirs to play first ("Echo after") and the balance of the
 * two sounds. The echo is made on the server, watched here, then posted as a reel linked to the original.
 */
export default function EchoScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();
  const { t } = useT();
  const [options, setOptions] = useState<EchoOptions | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  // Why it couldn't load, when that isn't because the reel is gone or private.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [asset, setAsset] = useState<Picked | null>(null);
  const [uploaded, setUploaded] = useState<{ id: string; uri: string } | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [layout, setLayout] = useState<EchoLayout>('side');
  const [after, setAfter] = useState(false);
  const [cut, setCut] = useState({ startMs: 0, endMs: 5000 });
  const [balance, setBalance] = useState(ECHO_BALANCE_DEFAULT);
  const [muteTheirs, setMuteTheirs] = useState(false);
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<Audience>('public');
  const [making, setMaking] = useState(false);
  const [render, setRender] = useState<EchoRender | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const alive = useRef(true);

  const loadOptions = useCallback(async () => {
    setLoadError(null);
    try {
      const o = await (await client()).posts.echoOptions(id);
      if (!alive.current) return;
      setOptions(o);
      if (o.original.durationMs) setCut({ startMs: 0, endMs: Math.min(o.original.durationMs, 5000) });
    } catch (e) {
      if (!alive.current) return;
      if (isGone(e)) setMissing(errorMessage(e));
      else setLoadError(errorMessage(e));
    }
  }, [id]);

  useEffect(() => {
    alive.current = true;
    void loadOptions();
    // A video recorded with the camera for this echo (now, or when the camera closes).
    const take = () => {
      const a = takeEchoAsset(id);
      if (a) choose(a);
    };
    take();
    const off = onEchoAsset(take);
    return () => {
      alive.current = false;
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  function choose(a: Picked) {
    setAsset(a);
    setRender(null);
    setFailed(null);
  }

  async function pick() {
    const a = await pickOne(['videos']).catch(() => null);
    if (a === 'denied')
      return Alert.alert(t('m.create.photosPermission'), undefined, [
        { text: t('m.create.cancel'), style: 'cancel' },
        { text: t('m.common.openSettings'), onPress: () => void Linking.openSettings() },
      ]);
    if (a) choose(a);
  }

  if (missing) return <EmptyState title={t('echo.block.unavailable')} body={missing} />;
  if (!options) return loadError ? <ScreenError message={loadError} onRetry={loadOptions} /> : <Loading />;

  const name = options.original.author.username;
  const theirMedia = options.original.media;
  const theirUri = theirMedia ? mediaUrl(theirMedia.variants?.mp4 ?? theirMedia.url) : null;
  const durationMs = options.original.durationMs ?? 0;
  const frame = echoFrame(layout);

  const setStart = (ms: number) =>
    setCut((cur) => {
      const startMs = Math.max(0, Math.min(ms, Math.max(0, durationMs - ECHO_CUT_MIN_MS)));
      const len = Math.min(Math.max(cur.endMs - cur.startMs, ECHO_CUT_MIN_MS), ECHO_CUT_MAX_MS);
      return { startMs, endMs: Math.min(durationMs, startMs + len) };
    });
  const setEnd = (ms: number) =>
    setCut((cur) => ({ startMs: cur.startMs, endMs: Math.max(cur.startMs + ECHO_CUT_MIN_MS, Math.min(ms, cur.startMs + ECHO_CUT_MAX_MS, durationMs)) }));

  async function make() {
    if (!asset) return;
    setFailed(null);
    setMaking(true);
    try {
      let mediaId = uploaded?.uri === asset.uri ? uploaded.id : null;
      if (!mediaId) {
        setProgress(0);
        const u = await uploadPicked(asset, (f) => alive.current && setProgress(f)).finally(() => alive.current && setProgress(null));
        mediaId = u.id;
        setUploaded({ id: u.id, uri: asset.uri });
      }
      const api = await client();
      const { echo } = await api.posts.echo(id, { mediaId, layout, cut: after ? cut : null, balance, muteTheirs });
      if (!alive.current) return;
      setRender(echo);
      const done = await api.echoes.waitUntilReady(echo.id);
      if (alive.current) setRender(done);
    } catch (e) {
      if (alive.current) setFailed(errorMessage(e));
    } finally {
      if (alive.current) setMaking(false);
    }
  }

  async function post() {
    if (!render?.media) return;
    try {
      const { post: created, moderation } = await (
        await client()
      ).posts.create({
        format: 'reel',
        body,
        visibility,
        media: [{ id: render.media.id, url: render.media.url, kind: 'video' }],
        echo: render.id,
      });
      Alert.alert(noticeText(moderation, t) ?? t('echo.posted'));
      router.replace({ pathname: '/reels', params: { start: created.id } });
    } catch (e) {
      Alert.alert(errorMessage(e));
    }
  }

  const ready = render?.status === 'ready' && render.media ? render.media : null;
  const audioNote =
    options.theirAudio === 'song' && options.song
      ? t('echo.audio.song', { title: options.song.title })
      : options.theirAudio === 'dropped'
        ? t('echo.audio.dropped')
        : options.theirAudio === 'none'
          ? t('echo.audio.none')
          : null;
  const label = (text: string) => <Text style={{ color: c.ink, fontWeight: '700', fontSize: 16 }}>{text}</Text>;

  return (
    // The caption is typed near the end: the keyboard makes room for it and the buttons under it.
    <KeyboardAvoid style={{ backgroundColor: c.ground }}>
      <ScrollView
        style={{ flex: 1, backgroundColor: c.ground }}
        contentContainerStyle={{ padding: space[4], gap: space[4], paddingBottom: space[8] }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ gap: space[1] }}>
          <Text accessibilityRole="header" style={[{ color: c.ink, fontSize: 22, fontWeight: '800' }, userText]}>
            {t('echo.heading', { name })}
          </Text>
          <Text style={{ color: c.inkMuted, fontSize: 14, lineHeight: 20 }}>{t('echo.intro', { name })}</Text>
        </View>
        <Pressable
          accessibilityRole="link"
          onPress={() => router.push({ pathname: '/reels', params: { start: options.original.id } })}
          style={[s.original, { backgroundColor: c.surfaceSunken }]}
        >
          <Avatar name={options.original.author.displayName} url={options.original.author.avatarUrl} size={32} />
          <View style={{ flex: 1 }}>
            <Text style={[{ color: c.ink, fontWeight: '700' }, userText]} numberOfLines={1}>
              {t('echo.theirReel', { name: options.original.author.displayName })}
            </Text>
            {options.original.body ? (
              <Text style={[{ color: c.inkMuted, fontSize: 13 }, userText]} numberOfLines={1}>
                {options.original.body}
              </Text>
            ) : null}
          </View>
        </Pressable>

        {!options.canEcho && options.reason ? (
          <Notice tone="warn">{t(ECHO_BLOCK_KEYS[options.reason])}</Notice>
        ) : ready ? (
          <View style={{ gap: space[3] }}>
            <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '800', fontSize: 18 }}>
              {t('echo.preview')}
            </Text>
            <Text style={{ color: c.inkMuted, fontSize: 14 }}>{t('echo.ready')}</Text>
            <ResultVideo uri={mediaUrl(ready.url)} ratio={(ready.width ?? 9) / (ready.height ?? 16)} label={t('echo.preview')} />
            {render?.theirAudio === 'dropped' ? <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('echo.audioDropped')}</Text> : null}
            <Field label={t('echo.caption')} value={body} onChangeText={setBody} placeholder={t('echo.captionPlaceholder')} multiline maxLength={5000} />
            <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{t('create.visibility')}</Text>
            <Segmented
              label={t('create.visibility')}
              value={visibility}
              onChange={setVisibility}
              options={AUDIENCES.map((a) => ({ id: a, label: t(`visibility.${a}`) }))}
            />
            <Button label={t('echo.post')} icon="paper-plane-outline" onPress={post} />
            <Button label={t('echo.startOver')} variant="ghost" onPress={() => setRender(null)} />
          </View>
        ) : (
          <>
            {/* The preview: their reel and yours in the chosen layout. */}
            <View style={[s.stage, { aspectRatio: frame.width / frame.height }]} accessible={false}>
              {theirUri ? (
                <PreviewVideo
                  uri={theirUri}
                  label={t('echo.theirReel', { name: options.original.author.displayName })}
                  style={[place(layout, 'theirs'), layout === 'corner' && { zIndex: 1, borderWidth: 3, borderColor: '#FFFFFF' }]}
                />
              ) : null}
              {asset ? (
                <PreviewVideo key={asset.uri} uri={asset.uri} label={t('echo.yourVideo')} style={place(layout, 'yours')} />
              ) : (
                <View style={[place(layout, 'yours'), s.slot]}>
                  <Text style={{ color: '#FFFFFF', fontSize: 13, textAlign: 'center' }}>{t('echo.noVideo')}</Text>
                </View>
              )}
              <View style={s.credit} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
                <Text style={{ color: '#FFFFFF', fontSize: 11, fontWeight: '700' }}>{t('echo.of', { name })}</Text>
              </View>
            </View>

            <View style={{ gap: space[2] }}>
              {label(t('echo.yourVideo'))}
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
                <Button
                  label={t('echo.record')}
                  icon="videocam-outline"
                  variant="secondary"
                  onPress={() => router.push({ pathname: '/camera', params: { mode: 'reel', echo: id } })}
                />
                <Button label={asset ? t('echo.replace') : t('echo.pick')} icon="images-outline" variant="secondary" onPress={pick} />
              </View>
            </View>

            <View style={{ gap: space[2] }} accessibilityRole="radiogroup" accessibilityLabel={t('echo.layout')}>
              {label(t('echo.layout'))}
              {ECHO_LAYOUTS.map((l) => {
                const on = l === layout;
                const f = echoFrame(l);
                return (
                  <Pressable
                    key={l}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: on }}
                    accessibilityLabel={t(LAYOUT_KEYS[l].label)}
                    accessibilityHint={t(LAYOUT_KEYS[l].hint)}
                    onPress={() => setLayout(l)}
                    style={[s.layout, { borderColor: on ? c.yapi : c.line, backgroundColor: c.surface }, on && { borderWidth: 2 }]}
                  >
                    <View style={[s.glyph, { aspectRatio: f.width / f.height, backgroundColor: c.surfaceSunken, borderColor: c.line }]}>
                      <View style={[place(l, 'yours'), { backgroundColor: c.yapiSoft, borderWidth: 1, borderColor: c.yapi }]} />
                      <View style={[place(l, 'theirs'), { backgroundColor: c.inkMuted }]} />
                    </View>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={{ color: c.ink, fontWeight: '700', fontSize: 15 }}>{t(LAYOUT_KEYS[l].label)}</Text>
                      <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t(LAYOUT_KEYS[l].hint)}</Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>

            {durationMs >= ECHO_CUT_MIN_MS ? (
              <View style={{ gap: space[2] }}>
                {label(t('echo.after'))}
                <SwitchRow label={t('echo.afterHint')} value={after} onValueChange={setAfter} />
                {after ? (
                  <>
                    <Slider
                      label={t('echo.after.start')}
                      value={cut.startMs}
                      min={0}
                      max={Math.max(0, durationMs - ECHO_CUT_MIN_MS)}
                      step={100}
                      onChange={setStart}
                      format={formatReelTime}
                    />
                    <Slider
                      label={t('echo.after.end')}
                      value={cut.endMs}
                      min={ECHO_CUT_MIN_MS}
                      max={durationMs}
                      step={100}
                      onChange={setEnd}
                      format={formatReelTime}
                    />
                    <Text accessibilityLiveRegion="polite" style={{ color: c.inkMuted, fontSize: 13 }}>
                      {t('echo.after.summary', { start: formatReelTime(cut.startMs), end: formatReelTime(cut.endMs) })}
                    </Text>
                  </>
                ) : null}
              </View>
            ) : null}

            <View style={{ gap: space[2] }}>
              {label(t('echo.sound'))}
              {options.theirAudio === 'mixed' ? (
                <>
                  {muteTheirs ? null : (
                    <Slider
                      label={t('echo.balance')}
                      value={balance}
                      min={0}
                      max={100}
                      step={5}
                      onChange={setBalance}
                      format={(v) => t('echo.balance.value', { theirs: 100 - v, yours: v })}
                    />
                  )}
                  <SwitchRow label={t('echo.muteTheirs')} value={muteTheirs} onValueChange={setMuteTheirs} />
                </>
              ) : (
                <>
                  {audioNote ? <Text style={{ color: c.inkMuted, fontSize: 14, lineHeight: 20 }}>{audioNote}</Text> : null}
                  {options.theirAudio === 'song' ? <SwitchRow label={t('echo.muteTheirs')} value={muteTheirs} onValueChange={setMuteTheirs} /> : null}
                </>
              )}
              {theirMedia?.captions?.length ? <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('echo.captionsNote')}</Text> : null}
            </View>

            {failed ? <Notice tone="danger">{failed}</Notice> : null}
            {making ? (
              <Text accessibilityLiveRegion="polite" style={{ color: c.inkMuted, fontSize: 14 }}>
                {progress !== null ? t('echo.uploading') : t('echo.making')}
              </Text>
            ) : null}
            <Button label={t('echo.make')} icon="git-compare-outline" onPress={make} disabled={!asset || making} />
          </>
        )}
      </ScrollView>
    </KeyboardAvoid>
  );
}

const s = StyleSheet.create({
  original: { flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: 44, padding: space[3], borderRadius: radius.lg },
  stage: { width: '100%', maxWidth: 360, alignSelf: 'center', borderRadius: radius.lg, overflow: 'hidden', backgroundColor: '#05060B', direction: 'ltr' },
  slot: { alignItems: 'center', justifyContent: 'center', padding: space[3], borderWidth: 2, borderStyle: 'dashed', borderColor: 'rgba(255,255,255,0.4)' },
  credit: {
    position: 'absolute',
    zIndex: 2,
    top: '9%',
    left: '4%',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.63)',
  },
  layout: { flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: 64, padding: space[3], borderRadius: radius.md, borderWidth: 1 },
  glyph: { width: 36, borderRadius: 4, overflow: 'hidden', borderWidth: 1, direction: 'ltr' },
});
