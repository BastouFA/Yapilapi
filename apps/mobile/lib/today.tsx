// Yapilapi Today on the phone (docs/product/yapilapi-today.md): the morning briefing at the top
// of Pulse, its player, and its settings card.
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Pressable, Text, View } from 'react-native';
import { TODAY_HOURS, type TodayBriefing, type TodaySegment, type TodaySettings } from '../../../packages/shared/src/today';
import { client, errorMessage, mediaUrl } from './api';
import { AiPanel } from './ai-helpers';
import { Chip, ChipRow } from './chips';
import { useFlag } from './flags';
import { useT } from './i18n';
import { space } from './theme';
import { pauseVoice } from './voice';
import { Button, Card, Notice, SwitchRow, Title, useColors, userText } from './ui';

/**
 * This morning's Today: Play reads it segment by segment (a plain synthetic voice, when listening
 * is set up; otherwise each segment plays its first original Yap, or waits on its text). Each
 * segment links to its posts, can play the original Yap ("Hear @ada") and can be put away with
 * "Not interested in this". Nothing plays by itself.
 */
export function TodayCard() {
  const c = useColors();
  const { t } = useT();
  const on = useFlag('TODAY');
  const [today, setToday] = useState<TodayBriefing | null>(null);
  const [at, setAt] = useState(0);
  const [open, setOpen] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const player = useAudioPlayer(null, { updateInterval: 250 });
  const status = useAudioPlayerStatus(player);
  // What to do when the clip playing now ends (the next segment, while the briefing plays on its own).
  const then = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!on) return;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    client()
      .then((api) => api.today.get(tz))
      .then(
        (r) => setToday(r.today),
        () => {},
      );
  }, [on]);

  useEffect(() => {
    if (!status.didJustFinish) return;
    setPlaying(null);
    const next = then.current;
    then.current = null;
    next?.();
  }, [status.didJustFinish]);

  if (!today || !today.segments.length) return null;
  const segments = today.segments;
  const index = Math.min(at, segments.length - 1);
  const seg = segments[index]!;

  const stop = () => {
    then.current = null;
    setPlaying(null);
    try {
      player.pause();
    } catch {
      // Released.
    }
  };

  const play = (url: string, what: string, after?: () => void) => {
    pauseVoice();
    then.current = after ?? null;
    try {
      player.replace({ uri: mediaUrl(url) });
      void setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false }).catch(() => {});
      player.play();
      setPlaying(what);
    } catch {
      setPlaying(null);
    }
  };

  const playSegment = (i: number) => {
    const s = segments[i];
    setAt(i);
    if (!s) return stop();
    AccessibilityInfo.announceForAccessibility(t('today.segment', { n: i + 1, count: segments.length }));
    const url = s.audioUrl ?? s.sources.find((x) => x.voice)?.voice?.url;
    // Text only: it waits on this segment for Next.
    if (!url) return stop();
    play(url, 'segment', i + 1 < segments.length ? () => playSegment(i + 1) : undefined);
  };

  const go = (i: number) => (playing ? playSegment(i) : setAt(i));

  const notInterested = async (s: TodaySegment) => {
    stop();
    setError(null);
    try {
      const r = await (await client()).today.notInterested(today.id, s.index);
      setToday(r.today);
      setAt((n) => Math.min(n, Math.max(0, (r.today?.segments.length ?? 1) - 1)));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const hide = () => {
    stop();
    const id = today.id;
    setToday(null);
    void client().then((api) => api.today.dismiss(id).catch(() => {}));
  };

  const reading = playing === 'segment';
  return (
    <AiPanel
      title={t('today.title')}
      notice={t('today.note')}
      actions={
        <>
          <Button
            label={reading ? t('voice.pause') : open ? t('voice.play') : t('today.play')}
            icon={reading ? 'pause' : 'play'}
            size="sm"
            onPress={() => {
              if (reading) return stop();
              setOpen(true);
              playSegment(index);
            }}
          />
          <Button label={t('catchUp.hide')} size="sm" variant="ghost" onPress={hide} />
        </>
      }
    >
      {!open ? (
        <Text style={{ color: c.ink, fontSize: 15, lineHeight: 22 }}>{t('today.intro')}</Text>
      ) : (
        <View style={{ gap: space[2] }}>
          <Text style={{ color: c.inkMuted, fontSize: 13, fontWeight: '700' }} accessibilityLiveRegion="polite">
            {t('today.segment', { n: index + 1, count: segments.length })}
          </Text>
          <Text style={[{ color: c.ink, fontSize: 16, lineHeight: 24 }, userText]}>{seg.text}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2], alignItems: 'center' }}>
            {seg.sources.map((s) => (
              <View key={s.postId} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2], alignItems: 'center' }}>
                {s.voice ? (
                  <Button
                    label={t('today.hear', { username: s.username })}
                    icon={playing === s.postId ? 'pause' : 'volume-high-outline'}
                    size="sm"
                    variant="secondary"
                    onPress={() => (playing === s.postId ? stop() : play(s.voice!.url, s.postId))}
                  />
                ) : null}
                <Pressable
                  accessibilityRole="link"
                  onPress={() => router.push(`/p/${s.postId}`)}
                  hitSlop={12}
                  style={{ minHeight: 44, justifyContent: 'center' }}
                >
                  <Text style={[{ color: c.yapi, fontWeight: '600', fontSize: 14 }, userText]}>{t('catchUp.openPost', { name: s.displayName })}</Text>
                </Pressable>
              </View>
            ))}
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
            <Button label={t('story.previous')} icon="play-skip-back" size="sm" variant="ghost" disabled={index === 0} onPress={() => go(index - 1)} />
            <Button
              label={t('story.next')}
              icon="play-skip-forward"
              size="sm"
              variant="ghost"
              disabled={index >= segments.length - 1}
              onPress={() => go(index + 1)}
            />
            <Button label={t('today.notInterested')} icon="close" size="sm" variant="ghost" onPress={() => notInterested(seg)} />
          </View>
          {error ? <Notice tone="danger">{error}</Notice> : null}
        </View>
      )}
    </AiPanel>
  );
}

// ── Settings ────────────────────────────────────────────────────────────

/** Settings > Notifications: Yapilapi Today on or off, from which hour, with my city, and "Your Today is ready". */
export function TodaySettingsCard() {
  const c = useColors();
  const { t, locale } = useT();
  const on = useFlag('TODAY');
  const [settings, setSettings] = useState<TodaySettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!on) return;
    void client()
      .then((api) => api.today.settings())
      .then(
        (r) => setSettings(r.settings),
        (e) => setError(errorMessage(e)),
      );
  }, [on]);
  if (!on) return null;
  async function save(patch: Partial<Pick<TodaySettings, 'enabled' | 'hour' | 'city' | 'notify'>>) {
    if (!settings) return;
    const before = settings;
    setSettings({ ...settings, ...patch });
    setError(null);
    try {
      setSettings((await (await client()).today.updateSettings(patch)).settings);
    } catch (e) {
      setSettings(before);
      setError(errorMessage(e));
    }
  }
  const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' });
  return (
    <Card style={{ gap: space[3] }}>
      <Title sub={t('today.settings.desc')}>{t('today.title')}</Title>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {settings ? (
        <>
          <SwitchRow label={t('today.settings.enabled')} value={settings.enabled} onValueChange={(v) => void save({ enabled: v })} />
          <Text style={{ color: c.ink, fontSize: 15, fontWeight: '600' }}>{t('today.settings.hour')}</Text>
          <ChipRow radios label={t('today.settings.hour')}>
            {TODAY_HOURS.map((h) => (
              <Chip
                key={h}
                radio
                label={time.format(new Date(2026, 0, 1, h, 0))}
                selected={settings.hour === h}
                disabled={!settings.enabled}
                onPress={() => void save({ hour: h })}
              />
            ))}
          </ChipRow>
          <SwitchRow
            label={t('today.settings.city')}
            value={settings.enabled && settings.city}
            disabled={!settings.enabled}
            onValueChange={(v) => void save({ city: v })}
          />
          <SwitchRow
            label={t('today.settings.notify')}
            value={settings.enabled && settings.notify}
            disabled={!settings.enabled}
            onValueChange={(v) => void save({ notify: v })}
          />
          <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('wrap.settings.timezone', { zone: settings.timezone })}</Text>
        </>
      ) : null}
    </Card>
  );
}
