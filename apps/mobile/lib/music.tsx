import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { router } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Image, Modal, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { formatList } from '../../../packages/shared/src/feed-reasons';
import type { MessageKey } from '../../../packages/shared/src/i18n';
import {
  MUSIC_CLIP_DEFAULT_MS,
  MUSIC_CLIP_MIN_MS,
  waveformBars,
  type MusicSourceInfo,
  type MusicTab,
  type MusicTrack,
  type PostMusic,
} from '../../../packages/shared/src/music';
import { STORY_MUSIC_MAX_MS, storyMusicPart, type StoryMusic, type StoryMusicInput, type StoryMusicStyle } from '../../../packages/shared/src/stories';
import type { Sound } from '../../../packages/shared/src/types';
import { client, errorMessage, mediaUrl } from './api';
import { Slider } from './editor';
import { useT } from './i18n';
import { clock } from './media';
import { useSession } from './session';
import { Placed } from './story-stickers';
import { radius, space } from './theme';
import { Button, Field, Icon, Notice, Segmented, slop, useColors, userText, useScreenFocused } from './ui';

const INK = '#14151F';
const CARD = '#FFFFFF';

/** Where music is being added: the longest part and what the field says depend on it. */
export type MusicUse = 'post' | 'reel' | 'story';

/** Music chosen in Create that isn't posted yet: a song or a sound, the part that plays, and (stories) its sticker. */
export interface DraftMusic {
  track: MusicTrack;
  startMs: number;
  durationMs: number;
  style: StoryMusicStyle;
  x: number;
  y: number;
}

/** The longest part a song may play here: its licence, and 15 seconds on stories. */
export const clipMax = (track: Pick<MusicTrack, 'maxClipMs'>, use: MusicUse) =>
  use === 'story' ? Math.min(track.maxClipMs, STORY_MUSIC_MAX_MS) : track.maxClipMs;

export const draftMusic = (track: MusicTrack, use: MusicUse, part?: { startMs: number; durationMs: number }): DraftMusic => ({
  track,
  startMs: part?.startMs ?? 0,
  durationMs: Math.max(MUSIC_CLIP_MIN_MS, Math.min(part?.durationMs ?? MUSIC_CLIP_DEFAULT_MS, clipMax(track, use))),
  style: 'compact',
  x: 0.5,
  y: 0.78,
});

/** What the API takes for a story: a sound or a song, the part and its sticker. */
export const musicInput = (m: DraftMusic): StoryMusicInput => ({
  ...(m.track.source === 'library' ? { soundId: m.track.id } : { trackId: m.track.id }),
  startMs: m.startMs,
  durationMs: m.durationMs,
  style: m.style,
  x: m.x,
  y: m.y,
});

/** A sound from the library as a picker track (for "Use this sound" links). */
export function soundAsTrack(s: Sound): MusicTrack {
  return {
    source: 'library',
    id: s.id,
    title: s.title,
    artist: s.owner.displayName,
    album: null,
    durationMs: s.durationMs,
    coverUrl: s.coverUrl,
    previewUrl: s.audioUrl,
    licence: {
      name: 'Original sound',
      url: null,
      commercialUse: true,
      regions: null,
      excludedRegions: [],
      maxClipSeconds: 30,
      attribution: null,
      expiresAt: null,
      cacheAllowed: true,
    },
    attribution: `${s.title} by ${s.owner.displayName} · Original sound`,
    maxClipMs: 30_000,
    uses: s.reels + s.stories + (s.posts ?? 0),
    saved: !!s.saved,
    canUse: s.canUse,
  };
}

/** Open a song's page (catalogue) or a sound's page. */
export const openMusic = (m: { source?: string; id: string }) =>
  router.push(!m.source || m.source === 'library' ? `/sounds/${m.id}` : { pathname: '/music/[id]', params: { id: m.id } });

/** "Music: Title by Artist · CC BY 4.0" (and a partner's own credit), or "Original sound by Ada" for sounds. */
export function useMusicCredit() {
  const { t } = useT();
  return (m: { source?: string; title: string; artist: string; licenceName?: string | null; attribution?: string | null }) => {
    if (!m.source || m.source === 'library') return t('music.originalCredit', { artist: m.artist });
    const line = t('music.credit', { title: m.title, artist: m.artist, licence: m.licenceName ?? '' });
    return m.attribution && !m.attribution.startsWith(m.title) ? `${line} · ${m.attribution}` : line;
  };
}

const MUSIC_KEY = 'ypl_story_music';

/** Whether story music plays out loud (on unless turned off; the choice is kept on this phone). The silent switch still applies. */
export function useMusicOn(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(true);
  useEffect(() => {
    void SecureStore.getItemAsync(MUSIC_KEY)
      .then((v) => setOn(v !== 'off'))
      .catch(() => {});
  }, []);
  return [
    on,
    (next) => {
      setOn(next);
      void SecureStore.setItemAsync(MUSIC_KEY, next ? 'on' : 'off').catch(() => {});
    },
  ];
}

/** Play a part of a song in a loop while `playing`. Nothing loads without a song. */
export function useMusicLoop(music: { sound: { audioUrl: string | null }; startMs: number; durationMs: number } | null, playing: boolean) {
  const url = music?.sound.audioUrl ? mediaUrl(music.sound.audioUrl) : null;
  const player = useAudioPlayer(url ? { uri: url } : null, { updateInterval: 250 });
  const status = useAudioPlayerStatus(player);
  const start = (music?.startMs ?? 0) / 1000;
  const end = start + (music?.durationMs ?? 0) / 1000;

  useEffect(() => {
    if (!url) return;
    if (!playing) {
      player.pause();
      return;
    }
    if (player.currentTime < start - 0.5 || player.currentTime >= end - 0.05) void player.seekTo(start);
    player.play();
    return () => {
      // The player may already be released when the screen goes (or reloads); nothing left to stop then.
      try {
        player.pause();
      } catch {
        /* already gone */
      }
    };
  }, [url, playing, start, end, player]);

  // Back to the start of the part when it reaches its end (or the song ends).
  useEffect(() => {
    if (!url || !playing) return;
    if (status.didJustFinish || status.currentTime >= end - 0.05) void player.seekTo(start).then(() => player.play());
  }, [status.currentTime, status.didJustFinish, url, playing, start, end, player]);
}

/**
 * The music sticker on a story: the title and who made it, as a small pill or a card with the cover,
 * with the credit a catalogue song's licence asks for. Tapping it opens the song or sound's page.
 */
export function MusicSticker({ music, onOpen }: { music: StoryMusic; onOpen: () => void }) {
  const { t } = useT();
  const credit = useMusicCredit();
  const card = music.style === 'card';
  const catalogue = !!music.sound.source && music.sound.source !== 'library';
  const note = music.sound.unavailable ? t(`music.unavailable.${music.sound.unavailable}` as MessageKey) : catalogue ? credit(music.sound) : null;
  return (
    <Placed x={music.x} y={music.y}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('m.music.sticker', { title: music.sound.title, artist: music.sound.artist })}
        // The compact sticker is about 33 tall; the touch area reaches 44.
        hitSlop={6}
        onPress={onOpen}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: card ? 10 : 6,
          backgroundColor: CARD,
          borderRadius: card ? 14 : radius.full,
          paddingHorizontal: card ? 8 : 12,
          paddingVertical: 8,
          maxWidth: 260,
          opacity: pressed ? 0.85 : 1,
        })}
      >
        {card ? (
          <View
            style={{ width: 44, height: 44, borderRadius: 8, overflow: 'hidden', backgroundColor: '#E7E8F2', alignItems: 'center', justifyContent: 'center' }}
          >
            {music.sound.coverUrl ? (
              <Image source={{ uri: mediaUrl(music.sound.coverUrl) }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
            ) : (
              <Icon name="musical-notes" size={20} color={INK} />
            )}
          </View>
        ) : (
          <Icon name="musical-notes" size={16} color={INK} />
        )}
        <View style={{ flexShrink: 1 }}>
          <View style={{ flexDirection: card ? 'column' : 'row', gap: card ? 0 : 6 }}>
            <Text style={[{ color: INK, fontWeight: '700', fontSize: 13, flexShrink: 1 }, userText]} numberOfLines={1}>
              {music.sound.title}
            </Text>
            <Text style={[{ color: INK, opacity: 0.7, fontSize: 12, flexShrink: 1 }, userText]} numberOfLines={1}>
              {music.sound.artist}
            </Text>
          </View>
          {note ? (
            <Text style={{ color: INK, opacity: 0.7, fontSize: 10 }} numberOfLines={2}>
              {note}
            </Text>
          ) : null}
        </View>
      </Pressable>
    </Placed>
  );
}

/**
 * Music on a post: the title and artist (opening the song's page), a button that plays the part, and
 * the credit its licence asks for. Silent until tapped, so nothing downloads before (Data saver or not).
 * A song that can't play here says why, quietly.
 */
export function PostMusicChip({ music }: { music: PostMusic }) {
  const c = useColors();
  const { t } = useT();
  const credit = useMusicCredit();
  const [playing, setPlaying] = useState(false);
  // Nothing loads until the first tap.
  const [started, setStarted] = useState(false);
  useMusicLoop(started && music.audioUrl ? { sound: { audioUrl: music.audioUrl }, startMs: music.startMs, durationMs: music.durationMs } : null, playing);
  const names = { title: music.title, artist: music.artist };
  return (
    <View style={{ gap: 2, paddingHorizontal: space[1] }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: space[2],
          alignSelf: 'flex-start',
          maxWidth: '100%',
          backgroundColor: c.surfaceSunken,
          borderRadius: radius.full,
          paddingVertical: 4,
          paddingLeft: 4,
          paddingRight: 12,
        }}
      >
        {music.audioUrl ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={playing ? t('music.pauseOn', names) : t('music.playOn', names)}
            onPress={() => {
              setStarted(true);
              setPlaying((p) => !p);
            }}
            // 30pt circle; 44 × 44 reaching down over the credit line, not up (the post's sound link is just above).
            hitSlop={{ top: 2, bottom: 12, left: 7, right: 7 }}
            style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: c.yapi, alignItems: 'center', justifyContent: 'center' }}
          >
            <Icon name={playing ? 'pause' : 'play'} size={14} color="#fff" />
          </Pressable>
        ) : (
          <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="volume-mute-outline" size={14} color={c.inkMuted} />
          </View>
        )}
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={t('music.open', { title: music.title })}
          // One text line: 44 tall reaching down over the credit line, like the play button.
          hitSlop={{ top: 8, bottom: 19 }}
          onPress={() => openMusic(music)}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 }}
        >
          <Icon name="musical-notes" size={14} color={c.ink} />
          <Text style={[{ color: c.ink, fontWeight: '700', fontSize: 13, flexShrink: 1 }, userText]} numberOfLines={1}>
            {music.title}
          </Text>
          <Text style={[{ color: c.inkMuted, fontSize: 13, flexShrink: 1 }, userText]} numberOfLines={1}>
            {music.artist}
          </Text>
        </Pressable>
      </View>
      <Text style={{ color: c.inkMuted, fontSize: 12 }}>{music.unavailable ? t(`music.unavailable.${music.unavailable}` as MessageKey) : credit(music)}</Text>
    </View>
  );
}

const TABS: MusicTab[] = ['for_you', 'trending', 'saved', 'original'];

/** A source's name in the reader's language (a partner keeps its own name). */
function useSourceLabel() {
  const { t } = useT();
  return (s: MusicSourceInfo) =>
    s.id === 'library' ? t('music.tab.original') : s.id === 'jamendo' ? t('music.source.jamendo') : s.id === 'dev' ? t('music.source.dev') : s.label;
}

/**
 * The one music picker for reels, posts and stories: search every source that's on, or browse For
 * you, Trending, Saved and Original sounds. Each row plays a preview, shows the licence and credit,
 * and can be saved. Songs you can't use say why; business accounts only get songs cleared for
 * commercial use.
 */
export function MusicPicker({ visible, onClose, onPick }: { visible: boolean; onClose: () => void; onPick: (t: MusicTrack) => void }) {
  const focused = useScreenFocused();
  const c = useColors();
  const { t, locale } = useT();
  const { me } = useSession();
  const insets = useSafeAreaInsets();
  const credit = useMusicCredit();
  const sourceLabel = useSourceLabel();
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<MusicTab>('for_you');
  const [items, setItems] = useState<MusicTrack[] | null>(null);
  const [sources, setSources] = useState<MusicSourceInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<MusicTrack | null>(null);
  const req = useRef(0);
  useMusicLoop(previewing ? { sound: { audioUrl: previewing.previewUrl }, startMs: 0, durationMs: previewing.maxClipMs } : null, !!previewing && visible);

  useEffect(() => {
    if (!visible) {
      setPreviewing(null);
      return;
    }
    const n = ++req.current;
    setItems(null);
    const timer = setTimeout(
      () =>
        void client()
          .then((api) => api.music.list({ q: q.trim(), tab: q.trim() && tab !== 'saved' ? undefined : tab, limit: 24 }))
          .then(
            (r) => n === req.current && (setItems(r.items), setSources(r.sources), setError(null)),
            (e) => n === req.current && (setItems([]), setError(errorMessage(e))),
          ),
      q ? 250 : 0,
    );
    return () => clearTimeout(timer);
  }, [q, tab, visible]);

  async function toggleSave(track: MusicTrack) {
    const next = !track.saved;
    setItems((list) => list?.map((x) => (x.id === track.id ? { ...x, saved: next } : x)) ?? null);
    try {
      await (await client()).music.save(track, next);
    } catch (e) {
      setItems((list) => list?.map((x) => (x.id === track.id ? { ...x, saved: !next } : x)) ?? null);
      setError(errorMessage(e));
    }
  }

  const on = sources.filter((s) => s.enabled);
  const off = sources.filter((s) => !s.enabled);
  const close = () => {
    setPreviewing(null);
    onClose();
  };

  return (
    <Modal visible={visible && focused} animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <View style={{ flex: 1, backgroundColor: c.ground, padding: space[4], paddingBottom: insets.bottom + space[4], gap: space[3] }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 18, fontWeight: '800' }}>
            {t('music.picker.title')}
          </Text>
          <Button label={t('m.common.close')} variant="ghost" size="sm" onPress={close} />
        </View>
        <Field
          label={t('music.picker.search')}
          hideLabel
          placeholder={t('music.picker.search')}
          value={q}
          onChangeText={setQ}
          maxLength={80}
          autoCorrect={false}
        />
        <Segmented label={t('music.tabs')} value={tab} onChange={setTab} options={TABS.map((id) => ({ id, label: t(`music.tab.${id}` as MessageKey) }))} />
        {on.length ? (
          <Text style={{ color: c.inkMuted, fontSize: 12 }}>
            {t('music.sources', { sources: formatList(on.map(sourceLabel), locale, t) })}
            {off.length ? ` · ${t('music.sourcesOff', { sources: formatList(off.map(sourceLabel), locale, t) })}` : ''}
          </Text>
        ) : null}
        {me?.mode === 'business' ? <Text style={{ color: c.inkMuted, fontSize: 12 }}>{t('music.businessNote')}</Text> : null}
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <FlatList
          data={items ?? []}
          keyExtractor={(s) => `${s.source}:${s.id}`}
          keyboardShouldPersistTaps="handled"
          ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: c.line }} />}
          ListEmptyComponent={
            <Text style={{ color: c.inkMuted, paddingVertical: space[4] }}>
              {items === null
                ? t('music.loading')
                : q.trim()
                  ? t('music.noMatch', { q: q.trim() })
                  : tab === 'saved'
                    ? t('music.emptySaved')
                    : t('music.empty')}
            </Text>
          }
          renderItem={({ item }) => {
            const isPlaying = previewing?.id === item.id && previewing.source === item.source;
            return (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], paddingVertical: space[2] }}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={isPlaying ? t('sounds.pause', { title: item.title }) : t('sounds.play', { title: item.title })}
                  accessibilityState={{ disabled: !item.previewUrl || !item.canUse }}
                  disabled={!item.previewUrl || !item.canUse}
                  onPress={() => setPreviewing(isPlaying ? null : item)}
                  hitSlop={6}
                  style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: c.surfaceSunken, alignItems: 'center', justifyContent: 'center' }}
                >
                  <Icon name={isPlaying ? 'pause' : 'play'} size={18} color={c.ink} />
                </Pressable>
                <View style={{ flex: 1 }}>
                  <Text style={[{ color: c.ink, fontWeight: '700' }, userText]} numberOfLines={1}>
                    {item.title}
                  </Text>
                  <Text style={[{ color: c.inkMuted, fontSize: 12 }, userText]} numberOfLines={1}>
                    {item.artist}
                    {item.durationMs ? ` · ${clock(item.durationMs / 1000)}` : ''}
                  </Text>
                  <Text style={{ color: c.inkMuted, fontSize: 11 }} numberOfLines={2}>
                    {credit({ ...item, licenceName: item.licence.name })}
                  </Text>
                  {item.blocked ? (
                    <Text style={{ color: c.danger, fontSize: 11, fontWeight: '600' }}>{t(`music.blocked.${item.blocked}` as MessageKey)}</Text>
                  ) : null}
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={item.saved ? t('music.unsave', { title: item.title }) : t('music.save', { title: item.title })}
                  accessibilityState={{ selected: item.saved }}
                  onPress={() => void toggleSave(item)}
                  // A 20pt icon: 44 × 44, reaching less towards Use (12pt away, with its own 4pt slop).
                  hitSlop={slop({ top: 12, bottom: 12, start: 16, end: 8 })}
                >
                  <Icon name={item.saved ? 'bookmark' : 'bookmark-outline'} size={20} color={item.saved ? c.yapi : c.inkMuted} />
                </Pressable>
                <Button label={t('m.music.use')} variant="secondary" size="sm" disabled={!item.canUse} onPress={() => (setPreviewing(null), onPick(item))} />
              </View>
            );
          }}
        />
      </View>
    </Modal>
  );
}

/** A waveform-style strip of the song with the chosen part highlighted. */
function Waveform({ track, startMs, durationMs }: { track: MusicTrack; startMs: number; durationMs: number }) {
  const c = useColors();
  const bars = useMemo(() => waveformBars(track.id, 48), [track.id]);
  const songMs = track.durationMs ?? Math.max(60_000, startMs + durationMs);
  const from = startMs / songMs;
  const to = from + Math.min(1, durationMs / songMs);
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={{ height: 56, borderRadius: 12, backgroundColor: c.surfaceSunken, flexDirection: 'row', alignItems: 'center', gap: 2, paddingHorizontal: 8 }}
    >
      {bars.map((h, i) => {
        const at = (i + 0.5) / bars.length;
        const inPart = at >= from && at <= to;
        return (
          <View key={i} style={{ flex: 1, height: `${h * 80}%`, borderRadius: 2, backgroundColor: inPart ? c.yapi : c.inkMuted, opacity: inPart ? 1 : 0.35 }} />
        );
      })}
    </View>
  );
}

/**
 * Music for a post, reel or story in Create: pick from the music picker, choose the part (5 to 30
 * seconds, 15 on stories, never longer than the licence allows) on a waveform, and see the credit.
 * On a reel, a sound from the library plays in full instead of the video's own sound.
 */
export function MusicField({
  use,
  value,
  onChange,
  video = false,
}: {
  use: MusicUse;
  value: DraftMusic | null;
  onChange: (m: DraftMusic | null) => void;
  video?: boolean;
}) {
  const c = useColors();
  const { t } = useT();
  const credit = useMusicCredit();
  const [picking, setPicking] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const wholeSound = use === 'reel' && value?.track.source === 'library';
  const part = value ? (storyMusicPart(value.startMs, value.durationMs, value.track.durationMs) ?? { startMs: 0, durationMs: value.durationMs }) : null;
  useMusicLoop(
    value && part
      ? { sound: { audioUrl: value.track.previewUrl }, ...(wholeSound ? { startMs: 0, durationMs: value.track.durationMs ?? 60_000 } : part) }
      : null,
    previewing && !!value,
  );
  useEffect(() => {
    if (!value) setPreviewing(false);
  }, [value]);
  const songMs = value?.track.durationMs ?? null;
  const maxStart = value ? Math.max(0, (songMs ?? value.startMs + value.durationMs) - value.durationMs) : 0;
  const max = value ? clipMax(value.track, use) : 0;
  const min = Math.min(MUSIC_CLIP_MIN_MS, max);

  return (
    <View style={{ gap: space[2] }}>
      <Text style={{ color: c.ink, fontWeight: '600' }}>{use === 'reel' ? t('m.sound.title') : t('m.music.title')}</Text>
      {value && part ? (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={previewing ? t('m.music.stopPart') : t('m.music.playPart')}
              accessibilityState={{ disabled: !value.track.previewUrl }}
              disabled={!value.track.previewUrl}
              onPress={() => setPreviewing((p) => !p)}
              hitSlop={6}
              style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: c.surfaceSunken, alignItems: 'center', justifyContent: 'center' }}
            >
              <Icon name={previewing ? 'pause' : 'play'} size={20} color={c.ink} />
            </Pressable>
            <View style={{ flex: 1 }}>
              <Text style={[{ color: c.ink, fontWeight: '700' }, userText]} numberOfLines={1}>
                {value.track.title}
              </Text>
              <Text style={[{ color: c.inkMuted, fontSize: 12 }, userText]} numberOfLines={2}>
                {value.track.artist} ·{' '}
                {wholeSound
                  ? t('compose.soundReplaces')
                  : t('m.music.part', { from: clock(part.startMs / 1000), to: clock((part.startMs + part.durationMs) / 1000) })}
              </Text>
            </View>
          </View>
          {wholeSound ? null : (
            <>
              <Waveform track={value.track} startMs={value.startMs} durationMs={value.durationMs} />
              {maxStart > 0 ? (
                <Slider
                  label={t('music.scrubber')}
                  value={Math.min(value.startMs, maxStart)}
                  min={0}
                  max={maxStart}
                  step={500}
                  format={(v) => clock(v / 1000)}
                  onChange={(startMs) => onChange({ ...value, startMs })}
                />
              ) : (
                <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('m.music.short')}</Text>
              )}
              {max > min ? (
                <>
                  <Slider
                    label={t('music.length')}
                    value={value.durationMs}
                    min={min}
                    max={max}
                    step={1000}
                    format={(v) => t('music.seconds', { seconds: Math.round(v / 1000) })}
                    onChange={(durationMs) =>
                      onChange({ ...value, durationMs, startMs: songMs ? Math.min(value.startMs, Math.max(0, songMs - durationMs)) : value.startMs })
                    }
                  />
                  <Text style={{ color: c.inkMuted, fontSize: 12 }}>{t('music.lengthMax', { seconds: Math.round(max / 1000) })}</Text>
                </>
              ) : null}
            </>
          )}
          <Text style={{ color: c.inkMuted, fontSize: 12 }}>{credit({ ...value.track, licenceName: value.track.licence.name })}</Text>
          {use === 'story' ? (
            <Segmented
              label={t('m.music.style')}
              value={value.style}
              onChange={(style) => onChange({ ...value, style })}
              options={[
                { id: 'compact', label: t('m.music.compact') },
                { id: 'card', label: t('m.music.card') },
              ]}
            />
          ) : null}
          <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>
            {use === 'post'
              ? t('music.postHint')
              : use === 'reel'
                ? wholeSound
                  ? t('compose.soundReplaces')
                  : t('music.reelHint')
                : video
                  ? t('m.music.videoHint')
                  : t('m.music.moveHint')}
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
            <Button label={t('m.music.another')} icon="musical-notes" variant="secondary" size="sm" onPress={() => (setPreviewing(false), setPicking(true))} />
            <Button label={t('m.music.remove')} variant="ghost" size="sm" onPress={() => onChange(null)} />
          </View>
        </>
      ) : (
        <Button
          label={t('m.music.add')}
          icon="musical-notes"
          variant="secondary"
          size="sm"
          onPress={() => setPicking(true)}
          style={{ alignSelf: 'flex-start' }}
        />
      )}
      <MusicPicker
        visible={picking}
        onClose={() => setPicking(false)}
        onPick={(track) => {
          onChange(draftMusic(track, use, value ? { startMs: 0, durationMs: value.durationMs } : undefined));
          setPicking(false);
        }}
      />
    </View>
  );
}
