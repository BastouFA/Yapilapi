import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { router, useIsFocused } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import type { MessageKey } from '../../../packages/shared/src/i18n';
import {
  MIX_DESCRIPTION_MAX,
  MIX_TITLE_MAX,
  MIX_VISIBILITIES,
  moveItem,
  nextPlayable,
  previousPlayable,
  type Mix,
  type MixCard,
  type MixDetail,
  type MixSong,
  type MixVisibility,
} from '../../../packages/shared/src/mixes';
import type { MusicTrack } from '../../../packages/shared/src/music';
import type { Conversation, Message } from '../../../packages/shared/src/types';
import { client, errorMessage, mediaUrl } from './api';
import { useDataSaver } from './data-saver';
import { useT } from './i18n';
import { MusicPicker, openMusic } from './music';
import { useSession } from './session';
import { radius, space } from './theme';
import { BottomSheet, Button, EmptyState, Field, Icon, Segmented, useColors, userText } from './ui';

type T = ReturnType<typeof useT>['t'];

/** Who can see a mix, as the person choosing reads it. */
export const MIX_VISIBILITY_LABEL: Record<MixVisibility, MessageKey> = {
  private: 'mixes.visibility.private',
  friends: 'mixes.visibility.friends',
  followers: 'mixes.visibility.followers',
  public: 'mixes.visibility.public',
};

/** "Added by Ada", "Added by a former member", or nothing (someone you can't see). */
export function addedByText(s: MixSong, t: T): string | null {
  if (s.addedBy) return t('mixes.addedBy', { name: s.addedBy.displayName });
  return s.addedByFormer ? t('mixes.addedByFormer') : null;
}

/** A picker track as the API takes it. */
export const songRef = (track: MusicTrack) => (track.source === 'library' ? { soundId: track.id } : { trackId: track.id });

export const openMix = (id: string) => router.push({ pathname: '/mixes/[id]', params: { id } });

// ── Listening ───────────────────────────────────────────────────────────

/**
 * Play a mix's songs one after another: each song's allowed part, then the next one that can play.
 * Nothing loads until play is pressed, and nothing starts by itself. The silent switch applies.
 */
export function useMixPlayer(songs: MixSong[]) {
  const player = useAudioPlayer(null, { updateInterval: 250 });
  const status = useAudioPlayerStatus(player);
  const [index, setIndex] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const songsRef = useRef(songs);
  songsRef.current = songs;
  const indexRef = useRef(index);
  indexRef.current = index;

  const load = useCallback(
    (i: number) => {
      const part = songsRef.current[i]?.play;
      if (!part) return;
      player.replace({ uri: mediaUrl(part.audioUrl) });
      if (part.startMs) void player.seekTo(part.startMs / 1000);
      player.play();
      indexRef.current = i;
      setIndex(i);
      setPlaying(true);
    },
    [player],
  );
  const advance = useCallback(() => {
    const n = nextPlayable(songsRef.current, indexRef.current + 1);
    if (n >= 0) load(n);
    else {
      player.pause();
      setPlaying(false);
      setIndex(-1);
    }
  }, [load, player]);

  // The part is over (or the song ended): the next one.
  useEffect(() => {
    const part = index >= 0 ? songsRef.current[index]?.play : null;
    if (!part || !playing) return;
    const end = (part.startMs + part.durationMs) / 1000;
    if (status.didJustFinish || (status.isLoaded && status.currentTime >= end - 0.1)) advance();
  }, [status.currentTime, status.didJustFinish, status.isLoaded, index, playing, advance]);

  // Opening a song's page, a profile or anything else on top pauses it (Play carries on from there).
  const focused = useIsFocused();
  useEffect(() => {
    if (focused || !playing) return;
    try {
      player.pause();
    } catch {
      // Already released.
    }
    setPlaying(false);
  }, [focused, playing, player]);

  // Leaving the screen stops it.
  useEffect(
    () => () => {
      // The player may already be released when the screen goes (or reloads); nothing left to stop then.
      try {
        player.pause();
      } catch {
        /* already gone */
      }
    },
    [player],
  );

  return {
    index,
    playing,
    current: index >= 0 ? (songs[index] ?? null) : null,
    playAt: (i: number) => {
      const n = nextPlayable(songsRef.current, i);
      if (n >= 0) load(n);
    },
    toggle: () => {
      if (indexRef.current < 0) {
        const n = nextPlayable(songsRef.current, 0);
        if (n >= 0) load(n);
      } else if (playing) {
        player.pause();
        setPlaying(false);
      } else {
        player.play();
        setPlaying(true);
      }
    },
    next: advance,
    previous: () => {
      const n = previousPlayable(songsRef.current, indexRef.current);
      if (n >= 0) load(n);
    },
  };
}

function RoundButton({
  icon,
  label,
  onPress,
  disabled,
  main,
}: {
  icon: 'play' | 'pause' | 'play-skip-forward' | 'play-skip-back';
  label: string;
  onPress: () => void;
  disabled?: boolean;
  main?: boolean;
}) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        borderRadius: 22,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: main ? c.yapi : 'transparent',
        opacity: disabled ? 0.4 : pressed ? 0.8 : 1,
      })}
    >
      <Icon name={icon} size={main ? 22 : 20} color={main ? c.onYapi : c.ink} />
    </Pressable>
  );
}

/** The mini player at the bottom of a mix: what's playing, and previous, play or pause, next. */
export function MiniPlayer({ player, songs, bottom = 0 }: { player: ReturnType<typeof useMixPlayer>; songs: MixSong[]; bottom?: number }) {
  const c = useColors();
  const { t } = useT();
  const saver = useDataSaver().active;
  const playable = songs.filter((s) => s.play).length;
  if (!playable) return null;
  const s = player.current;
  const position = s ? songs.filter((x, i) => x.play && i <= player.index).length : 0;
  return (
    <View
      accessibilityLabel={t('mixes.player.label')}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space[2],
        paddingHorizontal: space[3],
        paddingTop: space[2],
        paddingBottom: space[2] + bottom,
        backgroundColor: c.surface,
        borderTopWidth: 1,
        borderTopColor: c.line,
      }}
    >
      {s?.coverUrl && !saver ? (
        <Image source={{ uri: mediaUrl(s.coverUrl) }} style={{ width: 40, height: 40, borderRadius: radius.sm }} />
      ) : (
        <Icon name="list" size={24} color={c.inkMuted} />
      )}
      <View style={{ flex: 1, minWidth: 0 }} accessibilityLiveRegion="polite">
        {s ? (
          <>
            <Text style={[{ color: c.ink, fontWeight: '700' }, userText]} numberOfLines={1}>
              {s.title}
            </Text>
            <Text style={[{ color: c.inkMuted, fontSize: 12 }, userText]} numberOfLines={1}>
              {s.artist} · {t('mixes.player.position', { n: position, total: playable })}
            </Text>
          </>
        ) : (
          <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('mixes.player.ready', { total: playable })}</Text>
        )}
      </View>
      <RoundButton icon="play-skip-back" label={t('mixes.player.previous')} disabled={!s} onPress={player.previous} />
      <RoundButton
        icon={player.playing ? 'pause' : 'play'}
        main
        label={t(player.playing ? 'mixes.player.pause' : 'mixes.player.play')}
        onPress={player.toggle}
      />
      <RoundButton icon="play-skip-forward" label={t('mixes.player.next')} disabled={!s} onPress={player.next} />
    </View>
  );
}

// ── Songs ───────────────────────────────────────────────────────────────

/**
 * One song of a mix: play it, open its page, and (for people who may add) move it up or down or
 * take it off. Songs that can't play are greyed with the reason.
 */
export function SongRow({
  mix,
  song: s,
  index: i,
  player,
  onMove,
  onRemove,
}: {
  mix: MixDetail;
  song: MixSong;
  index: number;
  player: ReturnType<typeof useMixPlayer>;
  onMove: (from: number, to: number) => void;
  onRemove: (s: MixSong) => void;
}) {
  const c = useColors();
  const { t } = useT();
  const saver = useDataSaver().active;
  const name = s.title || t('mixes.unavailable.hidden');
  const current = player.index === i;
  const by = addedByText(s, t);
  const small = (icon: 'chevron-up' | 'chevron-down' | 'close', label: string, onPress: () => void, disabled?: boolean) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.35 : 1 }}
    >
      <Icon name={icon} size={20} color={c.ink} />
    </Pressable>
  );
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space[2],
        paddingVertical: space[1],
        paddingHorizontal: space[2],
        borderRadius: radius.md,
        backgroundColor: current ? c.surfaceSunken : 'transparent',
      }}
    >
      {s.play ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t(current && player.playing ? 'mixes.player.pause' : 'mixes.song.play', { title: name })}
          onPress={() => (current ? player.toggle() : player.playAt(i))}
          style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: c.yapi, alignItems: 'center', justifyContent: 'center' }}
        >
          <Icon name={current && player.playing ? 'pause' : 'play'} size={18} color={c.onYapi} />
        </Pressable>
      ) : (
        <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: c.surfaceSunken, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="volume-mute-outline" size={18} color={c.inkMuted} />
        </View>
      )}
      {s.coverUrl && !saver ? (
        <Image source={{ uri: mediaUrl(s.coverUrl) }} style={{ width: 44, height: 44, borderRadius: radius.sm, opacity: s.play ? 1 : 0.6 }} />
      ) : null}
      <Pressable
        accessibilityRole={s.title ? 'link' : undefined}
        disabled={!s.title}
        onPress={() => openMusic({ source: s.source, id: s.musicId })}
        style={{ flex: 1, minWidth: 0 }}
      >
        <Text style={[{ color: c.ink, fontWeight: '700', opacity: s.play ? 1 : 0.6 }, userText]} numberOfLines={1}>
          {i + 1}. {name}
        </Text>
        {s.artist ? (
          <Text style={[{ color: c.inkMuted, fontSize: 13 }, userText]} numberOfLines={1}>
            {s.artist}
          </Text>
        ) : null}
        {s.unavailable ? (
          <Text style={{ color: c.inkMuted, fontSize: 12, fontStyle: 'italic' }}>{t(`mixes.unavailable.${s.unavailable}` as MessageKey)}</Text>
        ) : null}
        {s.licenceName && !s.unavailable ? (
          <Text style={{ color: c.inkMuted, fontSize: 12 }} numberOfLines={1}>
            {s.attribution && !s.attribution.startsWith(s.title)
              ? `${t('mixes.song.licence', { licence: s.licenceName })} · ${s.attribution}`
              : t('mixes.song.licence', { licence: s.licenceName })}
          </Text>
        ) : null}
        {by ? (
          <Text style={[{ color: c.inkMuted, fontSize: 12 }, userText]} numberOfLines={1}>
            {by}
          </Text>
        ) : null}
      </Pressable>
      {mix.canAdd ? (
        <View style={{ flexDirection: 'row' }}>
          {small('chevron-up', t('mixes.song.up', { title: name }), () => onMove(i, i - 1), i === 0)}
          {small('chevron-down', t('mixes.song.down', { title: name }), () => onMove(i, i + 1), i === mix.songs.length - 1)}
          {s.canRemove ? small('close', t('mixes.song.remove', { title: name }), () => onRemove(s)) : null}
        </View>
      ) : null}
    </View>
  );
}

/** Move and take off songs, keeping what's on screen in step with the server. */
export function useSongActions(mix: MixDetail | null, setMix: (m: MixDetail) => void, toast: (m: string) => void) {
  const { t } = useT();
  return {
    move: async (from: number, to: number) => {
      if (!mix || to < 0 || to >= mix.songs.length) return;
      const songs = moveItem(mix.songs, from, to);
      setMix({ ...mix, songs });
      try {
        const api = await client();
        setMix(
          (
            await api.mixes.reorder(
              mix.id,
              songs.map((s) => s.id),
            )
          ).mix,
        );
      } catch (e) {
        toast(errorMessage(e));
        const api = await client();
        await api.mixes.get(mix.id).then(
          (r) => setMix(r.mix),
          () => setMix(mix),
        );
      }
    },
    remove: async (s: MixSong) => {
      if (!mix) return;
      try {
        const api = await client();
        setMix((await api.mixes.removeSong(mix.id, s.id)).mix);
        toast(t('mixes.removed'));
      } catch (e) {
        toast(errorMessage(e));
      }
    },
  };
}

/** Add songs from the music picker; it stays open to add more. */
export function AddSongs({
  mix,
  onMix,
  onNote,
}: {
  mix: Pick<Mix, 'id' | 'title'>;
  onMix?: (m: MixDetail) => void;
  onNote: (m: string, failed?: boolean) => void;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button label={t('mixes.addSongs')} icon="add" size="sm" variant="secondary" onPress={() => setOpen(true)} />
      <MusicPicker
        visible={open}
        onClose={() => setOpen(false)}
        onPick={async (track) => {
          // Back to the mix, where the note says it was added (behind the picker nobody would see it).
          setOpen(false);
          try {
            const api = await client();
            const r = await api.mixes.addSongs(mix.id, [songRef(track)]);
            onMix?.(r.mix);
            onNote(r.added ? t('mixes.added', { title: track.title, mix: mix.title }) : t('mixes.alreadyOn', { title: track.title }));
          } catch (e) {
            onNote(errorMessage(e), true);
          }
        }}
      />
    </>
  );
}

// ── Covers and cards ────────────────────────────────────────────────────

/** A mix's cover: a mosaic of the first four song covers, one cover, or the mix symbol. Nothing loads on Data saver. */
export function MixMosaic({ covers, size = 64 }: { covers: string[]; size?: number }) {
  const c = useColors();
  const saver = useDataSaver().active;
  const tiles = saver ? [] : covers.slice(0, 4);
  const box = { width: size, height: size, borderRadius: radius.md, overflow: 'hidden' as const, backgroundColor: c.surfaceSunken };
  if (!tiles.length)
    return (
      <View style={[box, { alignItems: 'center', justifyContent: 'center' }]} importantForAccessibility="no-hide-descendants">
        <Icon name="list" size={Math.round(size / 2.4)} color={c.inkMuted} />
      </View>
    );
  if (tiles.length < 4) return <Image source={{ uri: mediaUrl(tiles[0]!) }} style={box} accessibilityIgnoresInvertColors />;
  return (
    <View style={[box, { flexDirection: 'row', flexWrap: 'wrap' }]}>
      {tiles.map((u, i) => (
        <Image key={i} source={{ uri: mediaUrl(u) }} style={{ width: size / 2, height: size / 2 }} />
      ))}
    </View>
  );
}

/** A mix as a card (lists, posts, chats): mosaic, name, who made it, how many songs. A mix you can't see says so. */
export function MixTile({ mix, children }: { mix: MixCard; children?: ReactNode }) {
  const c = useColors();
  const { t, tp } = useT();
  if (!mix.available)
    return (
      <View
        style={{ flexDirection: 'row', gap: space[2], alignItems: 'center', padding: space[3], borderRadius: radius.md, borderWidth: 1, borderColor: c.line }}
      >
        <Icon name="list" size={18} color={c.inkMuted} />
        <Text style={{ color: c.inkMuted, fontSize: 14 }}>{t('mixes.card.gone')}</Text>
      </View>
    );
  return (
    <View style={{ gap: space[2], padding: space[3], borderRadius: radius.md, borderWidth: 1, borderColor: c.line, backgroundColor: c.surface }}>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={t('mixes.card.open', { title: mix.title, name: mix.owner.displayName })}
        onPress={() => openMix(mix.id)}
        style={{ flexDirection: 'row', gap: space[3], alignItems: 'center', minHeight: 44 }}
      >
        <MixMosaic covers={mix.covers} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text style={{ color: c.inkMuted, fontSize: 12 }}>{t('mixes.card.kind')}</Text>
          <Text style={[{ color: c.ink, fontWeight: '800', fontSize: 15 }, userText]} numberOfLines={1}>
            {mix.title}
          </Text>
          <Text style={[{ color: c.inkMuted, fontSize: 13 }, userText]} numberOfLines={1}>
            {mix.owner.displayName} · {tp('mixes.songs', mix.songCount)}
          </Text>
        </View>
      </Pressable>
      {children}
    </View>
  );
}

/** A mix shared into a chat: its card, and Add songs for people who may add. */
export function ChatMixCard({ mix, onMix, onNote }: { mix: MixCard; onMix: (m: MixCard) => void; onNote: (m: string, failed?: boolean) => void }) {
  return (
    <MixTile mix={mix}>{mix.available && mix.canAdd ? <AddSongs mix={mix} onMix={(m) => onMix({ available: true, ...m })} onNote={onNote} /> : null}</MixTile>
  );
}

/** The Mixes tab on a profile. */
export function ProfileMixes({ username, isSelf }: { username: string; isSelf: boolean }) {
  const { t } = useT();
  const [items, setItems] = useState<Mix[] | null>(null);
  useEffect(() => {
    void client()
      .then((api) => api.mixes.forUser(username))
      .then(
        (r) => setItems(r.items),
        () => setItems([]),
      );
  }, [username]);
  return (
    <View style={{ gap: space[2], paddingTop: space[2] }}>
      {isSelf ? (
        <Button label={t('mixes.yours')} size="sm" variant="secondary" icon="list" onPress={() => router.push('/mixes')} style={{ alignSelf: 'flex-start' }} />
      ) : null}
      {items === null ? null : items.length ? (
        items.map((m) => <MixTile key={m.id} mix={{ available: true, ...m }} />)
      ) : (
        <EmptyState title={t('mixes.profileEmpty')} />
      )}
    </View>
  );
}

// ── Making and sharing ──────────────────────────────────────────────────

/** Make a mix, or change its name, description and who sees it. */
export function MixEditor({ visible, onClose, onSaved, mix }: { visible: boolean; onClose: () => void; onSaved: (m: MixDetail) => void; mix?: Mix }) {
  const c = useColors();
  const { t } = useT();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<MixVisibility>('followers');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!visible) return;
    setTitle(mix?.title ?? '');
    setDescription(mix?.description ?? '');
    setVisibility(mix?.visibility ?? 'followers');
    setError(null);
  }, [visible, mix]);
  return (
    <BottomSheet visible={visible} title={t(mix ? 'mixes.edit' : 'mixes.new')} onClose={onClose}>
      <Field label={t('mixes.titleLabel')} value={title} maxLength={MIX_TITLE_MAX} placeholder={t('mixes.titlePlaceholder')} onChangeText={setTitle} />
      <Field label={t('mixes.descriptionLabel')} value={description} maxLength={MIX_DESCRIPTION_MAX} multiline onChangeText={setDescription} />
      <Segmented
        label={t('mixes.visibilityLabel')}
        value={visibility}
        onChange={setVisibility}
        options={MIX_VISIBILITIES.map((v) => ({ id: v, label: t(MIX_VISIBILITY_LABEL[v]) }))}
      />
      <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t(`mixes.visibilityHint.${visibility}` as MessageKey)}</Text>
      {error ? <Text style={{ color: c.danger }}>{error}</Text> : null}
      <Button
        label={t(mix ? 'common.save' : 'mixes.create')}
        disabled={!title.trim()}
        onPress={async () => {
          try {
            const api = await client();
            const body = { title: title.trim(), description: description.trim(), visibility };
            const r = mix ? await api.mixes.update(mix.id, body) : await api.mixes.create(body);
            onSaved(r.mix);
          } catch (e) {
            setError(errorMessage(e));
          }
        }}
      />
    </BottomSheet>
  );
}

function chatName(ch: Conversation, meId: string | undefined, t: T) {
  if (ch.title) return ch.title;
  return (
    ch.members
      .filter((m) => m.id !== meId)
      .map((m) => m.displayName)
      .join(', ') || t('mixes.share.chat')
  );
}

/** Share a mix into a chat: everyone there can then add and reorder songs. */
export function ShareToChatSheet({ mix, visible, onClose, onShared }: { mix: Mix; visible: boolean; onClose: () => void; onShared: (note: string) => void }) {
  const c = useColors();
  const { t } = useT();
  const { me } = useSession();
  const [chats, setChats] = useState<Conversation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!visible) return;
    setChats(null);
    setError(null);
    void client()
      .then((api) => api.conversations.list())
      .then(
        (r) => setChats(r.items.filter((ch) => ch.kind === 'direct' || ch.kind === 'group')),
        (e) => (setChats([]), setError(errorMessage(e))),
      );
  }, [visible]);
  const shared = new Set(mix.chats.map((ch) => ch.conversationId));
  return (
    <BottomSheet visible={visible} title={t('mixes.share.title')} subtitle={t('mixes.share.hint')} onClose={onClose}>
      {error ? <Text style={{ color: c.danger }}>{error}</Text> : null}
      {chats?.length === 0 && !error ? <Text style={{ color: c.inkMuted }}>{t('mixes.share.noChats')}</Text> : null}
      {(chats ?? []).map((ch) => (
        <View key={ch.id} style={{ flexDirection: 'row', alignItems: 'center', gap: space[2], minHeight: 48 }}>
          <Icon name={ch.kind === 'group' ? 'people-outline' : 'chatbubble-outline'} size={18} color={c.inkMuted} />
          <Text style={[{ color: c.ink, flex: 1, fontWeight: '600' }, userText]} numberOfLines={1}>
            {chatName(ch, me?.id, t)}
          </Text>
          {shared.has(ch.id) ? (
            <Button label={t('mixes.share.open')} size="sm" variant="ghost" onPress={() => (onClose(), router.push(`/chat/${ch.id}`))} />
          ) : (
            <Button
              label={t('mixes.share.send')}
              size="sm"
              variant="secondary"
              onPress={async () => {
                try {
                  const api = await client();
                  await api.mixes.share(mix.id, ch.id, globalThis.crypto?.randomUUID?.());
                  onShared(t('mixes.share.done'));
                  onClose();
                } catch (e) {
                  setError(errorMessage(e));
                }
              }}
            />
          )}
        </View>
      ))}
    </BottomSheet>
  );
}

/** From a chat's + menu: choose one of your mixes to share here. */
export function ShareMixHereSheet({
  visible,
  onClose,
  conversationId,
  onSent,
}: {
  visible: boolean;
  onClose: () => void;
  conversationId: string;
  onSent: (m: Message) => void;
}) {
  const c = useColors();
  const { t } = useT();
  const [items, setItems] = useState<Mix[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!visible) return;
    setItems(null);
    setError(null);
    void client()
      .then((api) => api.mixes.mine('own'))
      .then(
        (r) => setItems(r.items.filter((m) => m.visibility !== 'private')),
        () => setItems([]),
      );
  }, [visible]);
  return (
    <BottomSheet visible={visible} title={t('mixes.shareHere')} subtitle={t('mixes.share.hint')} onClose={onClose}>
      {error ? <Text style={{ color: c.danger }}>{error}</Text> : null}
      {items?.length === 0 ? (
        <EmptyState title={t('mixes.share.noMixes')} action={{ label: t('mixes.yours'), onPress: () => (onClose(), router.push('/mixes')) }} />
      ) : null}
      {(items ?? []).map((m) => (
        <MixTile key={m.id} mix={{ available: true, ...m }}>
          <Button
            label={t('mixes.share.send')}
            size="sm"
            variant="secondary"
            onPress={async () => {
              try {
                const api = await client();
                onSent((await api.mixes.share(m.id, conversationId, globalThis.crypto?.randomUUID?.())).message);
                onClose();
              } catch (e) {
                setError(errorMessage(e));
              }
            }}
          />
        </MixTile>
      ))}
    </BottomSheet>
  );
}

/** Share a mix as a post: your words (or its name) and who sees the post. */
export function PostMixSheet({ mix, visible, onClose, onDone }: { mix: Mix; visible: boolean; onClose: () => void; onDone: (note: string) => void }) {
  const c = useColors();
  const { t } = useT();
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'followers' | 'friends'>('public');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (visible) (setBody(''), setError(null));
  }, [visible]);
  return (
    <BottomSheet visible={visible} title={t('mixes.post.title')} subtitle={t('mixes.post.hint')} onClose={onClose}>
      <Field label={t('mixes.post.body')} value={body} maxLength={2000} multiline onChangeText={setBody} />
      <Segmented
        label={t('mixes.post.audience')}
        value={visibility}
        onChange={setVisibility}
        options={[
          { id: 'public', label: t('mixes.visibility.public') },
          { id: 'followers', label: t('mixes.visibility.followers') },
          { id: 'friends', label: t('mixes.visibility.friends') },
        ]}
      />
      {error ? <Text style={{ color: c.danger }}>{error}</Text> : null}
      <Button
        label={t('mixes.post.send')}
        onPress={async () => {
          try {
            const api = await client();
            const r = await api.mixes.post(mix.id, { body: body.trim(), visibility });
            onDone(r.moderation?.message ?? t('mixes.post.done'));
            onClose();
          } catch (e) {
            setError(errorMessage(e));
          }
        }}
      />
    </BottomSheet>
  );
}
