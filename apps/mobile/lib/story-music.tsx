import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import * as SecureStore from 'expo-secure-store';
import { useEffect, useRef, useState } from 'react';
import { FlatList, Image, Modal, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  STORY_MUSIC_MAX_MS,
  storyMusicMaxStart,
  storyMusicPart,
  type StoryMusic,
  type StoryMusicInput,
  type StoryMusicStyle,
} from '../../../packages/shared/src/stories';
import type { Sound } from '../../../packages/shared/src/types';
import { client, errorMessage, mediaUrl } from './api';
import { Slider } from './editor';
import { useT } from './i18n';
import { clock } from './media';
import { Placed } from './story-stickers';
import { radius, space } from './theme';
import { Button, Field, Icon, Notice, Segmented, useColors, userText } from './ui';

const INK = '#14151F';
const CARD = '#FFFFFF';

/** Music chosen for a story that isn't posted yet. */
export interface DraftMusic {
  sound: Sound;
  startMs: number;
  style: StoryMusicStyle;
  x: number;
  y: number;
}

export const draftMusic = (sound: Sound): DraftMusic => ({ sound, startMs: 0, style: 'compact', x: 0.5, y: 0.78 });

/** What the API takes for the draft. */
export const musicInput = (m: DraftMusic): StoryMusicInput => ({
  soundId: m.sound.id,
  startMs: m.startMs,
  durationMs: STORY_MUSIC_MAX_MS,
  style: m.style,
  x: m.x,
  y: m.y,
});

/** The part that plays, as a viewer will get it. */
const partOf = (m: DraftMusic) => storyMusicPart(m.startMs, STORY_MUSIC_MAX_MS, m.sound.durationMs) ?? { startMs: 0, durationMs: STORY_MUSIC_MAX_MS };

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

/** Play a part of a sound in a loop while `playing`. Nothing loads without a sound. */
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
    return () => player.pause();
  }, [url, playing, start, end, player]);

  // Back to the start of the part when it reaches its end (or the sound ends).
  useEffect(() => {
    if (!url || !playing) return;
    if (status.didJustFinish || status.currentTime >= end - 0.05) void player.seekTo(start).then(() => player.play());
  }, [status.currentTime, status.didJustFinish, url, playing, start, end, player]);
}

/**
 * The music sticker on a story: the sound's title and who made it, as a small pill or a card with
 * the sound's cover. Tapping it opens the sound's page.
 */
export function MusicSticker({ music, onOpen }: { music: StoryMusic; onOpen: () => void }) {
  const { t } = useT();
  const card = music.style === 'card';
  return (
    <Placed x={music.x} y={music.y}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('m.music.sticker', { title: music.sound.title, artist: music.sound.artist })}
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
        <View style={{ flexShrink: 1, flexDirection: card ? 'column' : 'row', gap: card ? 0 : 6 }}>
          <Text style={[{ color: INK, fontWeight: '700', fontSize: 13, flexShrink: 1 }, userText]} numberOfLines={1}>
            {music.sound.title}
          </Text>
          <Text style={[{ color: INK, opacity: 0.7, fontSize: 12, flexShrink: 1 }, userText]} numberOfLines={1}>
            {music.sound.artist}
          </Text>
        </View>
      </Pressable>
    </Placed>
  );
}

/** Pick a sound: the most used ones you can use, searchable by name or by who made it. */
function MusicPicker({ visible, onClose, onPick }: { visible: boolean; onClose: () => void; onPick: (s: Sound) => void }) {
  const c = useColors();
  const { t, tp } = useT();
  const insets = useSafeAreaInsets();
  const [q, setQ] = useState('');
  const [items, setItems] = useState<Sound[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const req = useRef(0);
  useEffect(() => {
    if (!visible) return;
    const n = ++req.current;
    const timer = setTimeout(
      () =>
        void client()
          .then((api) => api.sounds.list(q.trim(), 20))
          .then(
            (r) => n === req.current && (setItems(r.items), setError(null)),
            (e) => n === req.current && setError(errorMessage(e)),
          ),
      q ? 250 : 0,
    );
    return () => clearTimeout(timer);
  }, [q, visible]);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: c.ground, padding: space[4], paddingBottom: insets.bottom + space[4], gap: space[3] }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 18, fontWeight: '800' }}>
            {t('m.music.choose')}
          </Text>
          <Button label={t('m.common.close')} variant="ghost" size="sm" onPress={onClose} />
        </View>
        <Field label={t('m.music.search')} hideLabel placeholder={t('m.music.search')} value={q} onChangeText={setQ} maxLength={60} autoCorrect={false} />
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <FlatList
          data={items ?? []}
          keyExtractor={(s) => s.id}
          keyboardShouldPersistTaps="handled"
          ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: c.line }} />}
          ListEmptyComponent={
            <Text style={{ color: c.inkMuted, paddingVertical: space[4] }}>
              {items === null ? t('m.music.loading') : q.trim() ? t('m.music.noMatch', { q: q.trim() }) : t('m.music.none')}
            </Text>
          }
          renderItem={({ item }) => (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], paddingVertical: space[2] }}>
              <Icon name="musical-notes" size={20} color={c.ink} />
              <View style={{ flex: 1 }}>
                <Text style={[{ color: c.ink, fontWeight: '700' }, userText]} numberOfLines={1}>
                  {item.title}
                </Text>
                <Text style={{ color: c.inkMuted, fontSize: 12 }} numberOfLines={1}>
                  @{item.owner.username}
                  {item.durationMs ? ` · ${clock(item.durationMs / 1000)}` : ''} · {tp('m.sound.reelCount', item.reels)}
                  {item.stories ? ` · ${tp('m.sound.storyCount', item.stories)}` : ''}
                </Text>
              </View>
              <Button label={t('m.music.use')} variant="secondary" size="sm" onPress={() => onPick(item)} />
            </View>
          )}
        />
      </View>
    </Modal>
  );
}

/**
 * Music for a story in Create: pick a sound, choose the 15 second part that plays in a loop, and how
 * the sticker looks. The sticker is dragged into place on the sticker preview.
 */
export function MusicField({ value, onChange, video }: { value: DraftMusic | null; onChange: (m: DraftMusic | null) => void; video: boolean }) {
  const c = useColors();
  const { t } = useT();
  const [picking, setPicking] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const part = value ? partOf(value) : null;
  useMusicLoop(value && part ? { sound: value.sound, ...part } : null, previewing && !!value);
  useEffect(() => {
    if (!value) setPreviewing(false);
  }, [value]);
  const maxStart = value ? storyMusicMaxStart(value.sound.durationMs) : 0;

  return (
    <View style={{ gap: space[2] }}>
      <Text style={{ color: c.ink, fontWeight: '600' }}>{t('m.music.title')}</Text>
      {value && part ? (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={previewing ? t('m.music.stopPart') : t('m.music.playPart')}
              accessibilityState={{ selected: previewing, disabled: !value.sound.audioUrl }}
              disabled={!value.sound.audioUrl}
              onPress={() => setPreviewing((p) => !p)}
              hitSlop={6}
              style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: c.surfaceSunken, alignItems: 'center', justifyContent: 'center' }}
            >
              <Icon name={previewing ? 'pause' : 'play'} size={20} color={c.ink} />
            </Pressable>
            <View style={{ flex: 1 }}>
              <Text style={[{ color: c.ink, fontWeight: '700' }, userText]} numberOfLines={1}>
                {value.sound.title}
              </Text>
              <Text style={{ color: c.inkMuted, fontSize: 12 }}>
                {t('m.music.part', { from: clock(part.startMs / 1000), to: clock((part.startMs + part.durationMs) / 1000) })}
              </Text>
            </View>
          </View>
          {maxStart > 0 ? (
            <Slider
              label={t('m.music.start')}
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
          <Segmented
            label={t('m.music.style')}
            value={value.style}
            onChange={(style) => onChange({ ...value, style })}
            options={[
              { id: 'compact', label: t('m.music.compact') },
              { id: 'card', label: t('m.music.card') },
            ]}
          />
          <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{video ? t('m.music.videoHint') : t('m.music.moveHint')}</Text>
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
        onPick={(s) => {
          onChange(value ? { ...value, sound: s, startMs: 0 } : draftMusic(s));
          setPicking(false);
        }}
      />
    </View>
  );
}
