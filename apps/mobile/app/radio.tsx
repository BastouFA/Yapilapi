import { Redirect, router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, I18nManager, Pressable, ScrollView, Text, View, type GestureResponderEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { formatBytes } from '../../../packages/shared/src/data-saver';
import { RADIO_SLEEP_MINUTES, sleepClock, stationId, type RadioStationInfo } from '../../../packages/shared/src/radio';
import { resamplePeaks, seekMs, voiceClock } from '../../../packages/shared/src/voice';
import { client, errorMessage } from '../lib/api';
import { Chip, ChipRow, SectionHeader } from '../lib/chips';
import { useT } from '../lib/i18n';
import { stationTitle, useRadio, useRadioOn } from '../lib/radio';
import { useSession } from '../lib/session';
import { radius, space } from '../lib/theme';
import { TranslatableText, useTranslationSettings } from '../lib/translation';
import { Avatar, Button, EmptyState, ErrorState, Icon, Notice, SwitchRow, useColors, userText } from '../lib/ui';
import { TranscriptText } from '../lib/voice';

const BAR = 4;
const BAR_GAP = 2;
/** A screen reader's swipe up or down moves this far. */
const STEP_MS = 5000;

/**
 * Yap Radio, the full screen: the stations, the speaker and their line, the waveform filling as
 * it plays, the words following along, play, back and next, like, reply by voice, follow, the
 * speed, the sleep timer, "Listen in my language", what's next and the data used.
 */
export default function RadioScreen() {
  const c = useColors();
  const { t, number } = useT();
  const insets = useSafeAreaInsets();
  const { me } = useSession();
  const on = useRadioOn();
  const r = useRadio();
  const { voice } = useTranslationSettings();
  const [stations, setStations] = useState<RadioStationInfo[] | null>(null);
  const [stationsError, setStationsError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [followError, setFollowError] = useState<string | null>(null);
  const [followBusy, setFollowBusy] = useState(false);
  const [width, setWidth] = useState(0);
  const [heldMs, setHeldMs] = useState<number | null>(null);
  // The sleep timer's choice, and its time left once a second.
  const [sleepPick, setSleepPick] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!r.sleepUntil) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [r.sleepUntil]);

  useEffect(() => {
    let live = true;
    setStationsError(null);
    client()
      .then((api) => api.radio.stations())
      .then(
        (res) => live && setStations(res.stations),
        (e) => live && setStationsError(errorMessage(e)),
      );
    return () => {
      live = false;
    };
  }, [attempt]);

  const post = r.current;
  const clip = post?.voice ?? null;
  const currentId = r.station ? stationId(r.station) : null;
  const stationName = r.station ? stationTitle(r.station, t) : '';
  // A new Yap: screen readers hear who is speaking.
  useEffect(() => {
    if (post) AccessibilityInfo.announceForAccessibility(`${t('radio.nowPlaying', { station: stationName })}: ${post.author.displayName}`);
    setFollowError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [post?.id]);

  const atMs = heldMs ?? r.positionMs;
  const bars = useMemo(() => resamplePeaks(clip?.peaks ?? [], Math.max(8, Math.floor((width + BAR_GAP) / (BAR + BAR_GAP)))), [clip?.peaks, width]);
  const played = r.durationMs > 0 ? Math.round((atMs / r.durationMs) * bars.length) : 0;
  const fractionAt = (e: GestureResponderEvent) => {
    const x = width > 0 ? e.nativeEvent.locationX / width : 0;
    return I18nManager.isRTL ? 1 - x : x;
  };
  const seekTo = (ms: number) => {
    setHeldMs(null);
    r.seek(Math.max(0, Math.min(r.durationMs, ms)));
  };

  if (on === false) return <Redirect href="/" />;

  const own = !!post && post.author.id === me?.id;
  const followLabel = r.follow === 'following' ? t('profile.unfollow') : r.follow === 'requested' ? t('profile.requested') : t('profile.follow');
  const round = (size: number) => ({ width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center' }) as const;
  const upNext = r.queue.slice(r.index + 1, r.index + 4);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.ground }}
      contentContainerStyle={{ padding: space[4], gap: space[4], paddingBottom: insets.bottom + space[6] }}
    >
      <View style={{ gap: space[2] }}>
        <SectionHeader title={t('radio.stations')} />
        {stations ? (
          <ChipRow scroll radios label={t('radio.stations')}>
            {stations.map((st) => (
              <Chip
                key={stationId(st)}
                radio
                label={stationTitle(st, t)}
                selected={currentId === stationId(st)}
                onPress={() => void r.play(st, { ask: st.kind === 'near' })}
              />
            ))}
          </ChipRow>
        ) : stationsError ? (
          <ErrorState message={stationsError} onRetry={() => setAttempt((a) => a + 1)} />
        ) : (
          <ActivityIndicator color={c.yapi} accessibilityLabel={t('radio.stations')} />
        )}
      </View>

      {r.error ? <ErrorState message={r.error} onRetry={() => r.play(r.station ?? undefined)} /> : null}

      {r.loading && !post ? (
        <ActivityIndicator size="large" color={c.yapi} style={{ marginTop: space[6] }} accessibilityLabel={t('radio.title')} />
      ) : !post ? (
        r.empty ? (
          <EmptyState icon="radio-outline" title={stationName || t('radio.title')} body={r.needsPlace ? t('radio.nearNone') : t('radio.empty')} />
        ) : r.error ? null : (
          <EmptyState icon="radio-outline" title={t('radio.title')} action={{ label: t('voice.play'), icon: 'play', onPress: () => void r.play() }} />
        )
      ) : (
        <>
          <View style={{ alignItems: 'center', gap: space[2] }}>
            <Text accessibilityLiveRegion="polite" style={[{ color: c.inkMuted, fontSize: 13, fontWeight: '700' }, userText]}>
              {t('radio.nowPlaying', { station: stationName })}
            </Text>
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={post.author.displayName}
              onPress={() => router.push(`/u/${post.author.username}`)}
              style={{ alignItems: 'center', gap: space[2] }}
            >
              <Avatar name={post.author.displayName} url={post.author.avatarUrl} size={112} />
              <Text style={[{ color: c.ink, fontSize: 22, fontWeight: '800', textAlign: 'center' }, userText]}>{post.author.displayName}</Text>
            </Pressable>
            {post.body ? (
              <TranslatableText
                kind="post"
                id={post.id}
                text={post.body}
                lang={post.lang}
                own={own}
                style={{ color: c.ink, fontSize: 16, lineHeight: 23, textAlign: 'center' }}
              />
            ) : null}
          </View>

          {/* The waveform fills as it plays: tap or drag to move, or swipe up and down with a screen reader. */}
          <View style={{ gap: space[1] }}>
            <View
              accessible
              accessibilityRole="adjustable"
              accessibilityLabel={t('voice.seek')}
              accessibilityValue={{
                min: 0,
                max: Math.round(r.durationMs / 1000),
                now: Math.round(atMs / 1000),
                text: `${voiceClock(atMs)} / ${voiceClock(r.durationMs)}`,
              }}
              accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
              onAccessibilityAction={(e) => {
                if (e.nativeEvent.actionName === 'increment') seekTo(atMs + STEP_MS);
                else if (e.nativeEvent.actionName === 'decrement') seekTo(atMs - STEP_MS);
              }}
              onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
              onStartShouldSetResponder={() => r.durationMs > 0}
              onResponderGrant={(e) => setHeldMs(seekMs(fractionAt(e), r.durationMs))}
              onResponderMove={(e) => setHeldMs(seekMs(fractionAt(e), r.durationMs))}
              onResponderRelease={(e) => seekTo(seekMs(fractionAt(e), r.durationMs))}
              onResponderTerminate={() => setHeldMs(null)}
              style={{ height: 64, justifyContent: 'center' }}
            >
              <View pointerEvents="none" style={{ flexDirection: 'row', alignItems: 'center', gap: BAR_GAP, height: 56 }}>
                {bars.map((p, i) => (
                  <View
                    key={i}
                    style={{ width: BAR, height: Math.max(4, (p / 100) * 56), borderRadius: BAR, backgroundColor: i < played ? c.yapi : c.inkMuted }}
                  />
                ))}
              </View>
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              <Text style={{ color: c.inkMuted, fontSize: 12, fontVariant: ['tabular-nums'] }}>{voiceClock(atMs)}</Text>
              <Text style={{ color: c.inkMuted, fontSize: 12, fontVariant: ['tabular-nums'] }}>{voiceClock(r.durationMs)}</Text>
            </View>
          </View>

          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space[6] }}>
            {/* targets-ok: sized by round(), 44 pt or more */}
            <Pressable accessibilityRole="button" accessibilityLabel={t('radio.previous')} onPress={r.previous} style={round(52)}>
              <Icon name="play-skip-back" size={26} color={c.ink} directional />
            </Pressable>
            {/* targets-ok: sized by round(), 44 pt or more */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={r.playing ? t('voice.pause') : t('voice.play')}
              onPress={r.toggle}
              style={[round(76), { backgroundColor: c.yapi }]}
            >
              <Icon name={r.playing ? 'pause' : 'play'} size={34} color={c.onYapi} />
            </Pressable>
            {/* targets-ok: sized by round(), 44 pt or more */}
            <Pressable accessibilityRole="button" accessibilityLabel={t('radio.next')} onPress={r.next} style={round(52)}>
              <Icon name="play-skip-forward" size={26} color={c.ink} directional />
            </Pressable>
          </View>

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: space[2] }}>
            {/* targets-ok: sized by round(), 44 pt or more */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={post.viewer.liked ? t('post.unlike') : t('post.like')}
              accessibilityState={{ selected: post.viewer.liked }}
              onPress={() => void r.like()}
              style={[round(44), { backgroundColor: c.surface, borderWidth: 1, borderColor: c.line }]}
            >
              <Icon name={post.viewer.liked ? 'heart' : 'heart-outline'} size={20} color={post.viewer.liked ? c.yapi : c.ink} />
            </Pressable>
            {post.viewer.canComment !== false ? (
              // targets-ok: sized by round(), 44 pt or more
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('voice.reply')}
                onPress={() => router.push({ pathname: '/p/[id]', params: { id: post.id, reply: 'voice' } })}
                style={[round(44), { backgroundColor: c.surface, borderWidth: 1, borderColor: c.line }]}
              >
                <Icon name="mic-outline" size={20} color={c.ink} />
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('voice.speed', { rate: number(r.rate) })}
              onPress={r.cycleRate}
              style={{
                minWidth: 44,
                height: 44,
                paddingHorizontal: space[2],
                borderRadius: 22,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: c.surface,
                borderWidth: 1,
                borderColor: c.line,
              }}
            >
              <Text style={{ color: c.ink, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{`${number(r.rate)}×`}</Text>
            </Pressable>
            {own ? null : (
              <Button
                label={followLabel}
                accessibilityLabel={`${followLabel}, ${post.author.displayName}`}
                variant={r.follow === 'none' ? 'primary' : 'secondary'}
                size="sm"
                disabled={followBusy}
                onPress={async () => {
                  setFollowBusy(true);
                  setFollowError(null);
                  try {
                    await r.toggleFollow();
                  } catch (e) {
                    setFollowError(errorMessage(e));
                  } finally {
                    setFollowBusy(false);
                  }
                }}
              />
            )}
          </View>
          {followError ? (
            <Text accessibilityRole="alert" style={{ color: c.danger, textAlign: 'center' }}>
              {followError}
            </Text>
          ) : null}

          {/* The words, following the line being spoken (a translation read out has no timings). */}
          {clip ? (
            <View style={{ gap: space[2], backgroundColor: c.surfaceSunken, borderRadius: radius.md, padding: space[3] }}>
              <Text accessibilityRole="header" style={{ color: c.inkMuted, fontSize: 13, fontWeight: '700' }}>
                {t('voice.transcript')}
              </Text>
              {clip.transcript.status === 'ready' && clip.transcript.text ? (
                <TranscriptText
                  id={clip.id}
                  text={clip.transcript.text}
                  lang={clip.transcript.lang}
                  segments={clip.transcript.segments}
                  own={own}
                  atMs={r.spoken ? -1 : atMs}
                  onSeek={(ms) => (r.spoken ? undefined : seekTo(ms))}
                  listen={false}
                />
              ) : (
                <Text style={{ color: c.inkMuted, fontSize: 14, lineHeight: 20 }}>
                  {clip.transcript.status === 'pending' ? t('voice.transcript.pending') : t('voice.transcript.unavailable')}
                </Text>
              )}
            </View>
          ) : null}

          {r.empty ? (
            <Notice>
              <Text style={{ color: c.ink, lineHeight: 20 }}>{r.needsPlace ? t('radio.nearNone') : t('radio.empty')}</Text>
            </Notice>
          ) : null}

          {upNext.length ? (
            <View style={{ gap: space[1] }}>
              <SectionHeader title={t('watch.queue')} />
              {upNext.map((p, i) => (
                <Pressable
                  key={p.id}
                  accessibilityRole="button"
                  accessibilityLabel={[p.author.displayName, p.body.trim(), p.voice ? voiceClock(p.voice.durationMs) : ''].filter(Boolean).join(', ')}
                  onPress={() => r.playAt(r.index + 1 + i)}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: space[2], minHeight: 52 }}
                >
                  <Avatar name={p.author.displayName} url={p.author.avatarUrl} size={36} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text numberOfLines={1} style={[{ color: c.ink, fontWeight: '700' }, userText]}>
                      {p.author.displayName}
                    </Text>
                    {p.body.trim() ? (
                      <Text numberOfLines={1} style={[{ color: c.inkMuted, fontSize: 13 }, userText]}>
                        {p.body.trim()}
                      </Text>
                    ) : null}
                  </View>
                  {p.voice ? <Text style={{ color: c.inkMuted, fontSize: 12, fontVariant: ['tabular-nums'] }}>{voiceClock(p.voice.durationMs)}</Text> : null}
                </Pressable>
              ))}
            </View>
          ) : null}
        </>
      )}

      {/* How it plays: in my language, the sleep timer, the data used. */}
      <View style={{ gap: space[3] }}>
        {voice.listen ? <SwitchRow label={t('radio.myLanguage')} value={r.myLanguage} onValueChange={r.setMyLanguage} /> : null}
        <View style={{ gap: space[1] }}>
          <Text style={{ color: c.ink, fontSize: 15, fontWeight: '600' }}>{t('radio.sleep')}</Text>
          <ChipRow radios label={t('radio.sleep')}>
            <Chip radio label={t('dataSaver.off')} selected={!r.sleepUntil} onPress={() => r.setSleep(null)} />
            {RADIO_SLEEP_MINUTES.map((m) => (
              <Chip
                key={m}
                radio
                label={t('mixes.minutes', { n: number(m) })}
                selected={!!r.sleepUntil && sleepPick === m}
                onPress={() => {
                  setSleepPick(m);
                  r.setSleep(m);
                }}
              />
            ))}
          </ChipRow>
          {r.sleepUntil ? (
            <Text style={{ color: c.inkMuted, fontSize: 13, fontVariant: ['tabular-nums'] }}>
              {t('radio.sleepLeft', { time: sleepClock(r.sleepUntil - now) })}
            </Text>
          ) : null}
        </View>
        {r.bytes > 0 ? <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('radio.data', { size: formatBytes(r.bytes) })}</Text> : null}
        {post || r.station ? (
          <Button
            label={t('radio.stop')}
            icon="stop-circle-outline"
            variant="secondary"
            onPress={() => {
              r.stop();
              if (router.canGoBack()) router.back();
            }}
          />
        ) : null}
      </View>
    </ScrollView>
  );
}
