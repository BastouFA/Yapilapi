'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BottomSheet, Button, EmptyState, Icon, MixMosaic, MixTile, Select, Skeleton, TextField } from '@yapilapi/design-system';
import {
  MIX_DESCRIPTION_MAX,
  MIX_TITLE_MAX,
  MIX_VISIBILITIES,
  moveItem,
  nextPlayable,
  previousPlayable,
  type Conversation,
  type Message,
  type MessageKey,
  type Mix,
  type MixCard,
  type MixDetail,
  type MixSong,
  type MixVisibility,
  type MusicTrack,
} from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { NextLink } from '@/lib/link';
import { MusicPicker, musicHref } from '@/components/MusicPicker';
import { useSession } from '@/app/providers';

type T = ReturnType<typeof useSession>['t'];

/** Who can see a mix, as the person choosing reads it. */
export const MIX_VISIBILITY_LABEL: Record<MixVisibility, MessageKey> = {
  private: 'mixes.visibility.private',
  friends: 'mixes.visibility.friends',
  followers: 'mixes.visibility.followers',
  public: 'mixes.visibility.public',
};

/** Why a song doesn't play, in plain words. */
export const unavailableText = (s: MixSong, t: T) => (s.unavailable ? t(`mixes.unavailable.${s.unavailable}` as MessageKey) : '');

/** The licence's name, and a partner's own credit line when it adds something. */
export const songCredit = (s: MixSong, t: T) =>
  s.attribution && !s.attribution.startsWith(s.title)
    ? `${t('mixes.song.licence', { licence: s.licenceName ?? '' })} · ${s.attribution}`
    : t('mixes.song.licence', { licence: s.licenceName ?? '' });

/** "Added by Ada", "Added by a former member", or nothing (someone you can't see). */
export function addedByText(s: MixSong, t: T): string | null {
  if (s.addedBy) return t('mixes.addedBy', { name: s.addedBy.displayName });
  return s.addedByFormer ? t('mixes.addedByFormer') : null;
}

/** A picker track as the API takes it. */
export const songRef = (track: MusicTrack) => (track.source === 'library' ? { soundId: track.id } : { trackId: track.id });

// ── Listening ───────────────────────────────────────────────────────────

/**
 * Play a mix's songs one after another: each song's allowed part, from its start, then the next one
 * that can play. Nothing loads until play is pressed, and nothing starts by itself. Another player on
 * the page starting pauses this one.
 */
export function useMixPlayer(songs: MixSong[]) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [index, setIndex] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const songsRef = useRef(songs);
  songsRef.current = songs;
  const indexRef = useRef(index);
  indexRef.current = index;

  const load = useCallback((i: number) => {
    const song = songsRef.current[i];
    if (!song?.play) return;
    let a = audio.current;
    if (!a) {
      a = new Audio();
      a.preload = 'auto';
      a.addEventListener('play', () => setPlaying(true));
      a.addEventListener('pause', () => setPlaying(false));
      audio.current = a;
    }
    const part = song.play;
    const start = part.startMs / 1000;
    const end = start + part.durationMs / 1000;
    const next = () => {
      const n = nextPlayable(songsRef.current, indexRef.current + 1);
      if (n < 0) {
        a!.pause();
        setIndex(-1);
        return;
      }
      load(n);
    };
    a.onloadedmetadata = () => {
      try {
        a!.currentTime = start;
      } catch {
        // Not seekable yet.
      }
    };
    a.ontimeupdate = () => {
      if (a!.currentTime >= end - 0.05) next();
    };
    a.onended = next;
    a.onerror = next;
    a.src = part.audioUrl;
    setIndex(i);
    indexRef.current = i;
    void a.play().catch(() => setPlaying(false));
  }, []);

  // Another sound on the page starts: this one pauses.
  useEffect(() => {
    const stopOthers = (e: Event) => {
      if (audio.current && e.target !== audio.current) audio.current.pause();
    };
    document.addEventListener('play', stopOthers, true);
    return () => document.removeEventListener('play', stopOthers, true);
  }, []);
  // Let go of the file when the page goes away.
  useEffect(
    () => () => {
      const a = audio.current;
      if (!a) return;
      a.pause();
      a.removeAttribute('src');
      a.load();
      audio.current = null;
    },
    [],
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
      const a = audio.current;
      if (index < 0 || !a) {
        const n = nextPlayable(songsRef.current, 0);
        if (n >= 0) load(n);
      } else if (a.paused) void a.play().catch(() => setPlaying(false));
      else a.pause();
    },
    next: () => {
      const n = nextPlayable(songsRef.current, indexRef.current + 1);
      if (n >= 0) load(n);
    },
    previous: () => {
      const n = previousPlayable(songsRef.current, indexRef.current);
      if (n >= 0) load(n);
    },
  };
}

/** The mini player at the bottom of a mix: what's playing, and previous, play or pause, next. */
export function MiniPlayer({ player, songs }: { player: ReturnType<typeof useMixPlayer>; songs: MixSong[] }) {
  const { t, dataSaver } = useSession();
  const playable = songs.filter((s) => s.play).length;
  if (!playable) return null;
  const s = player.current;
  const position = s ? songs.filter((x, i) => x.play && i <= player.index).length : 0;
  return (
    <div className="mix-player" role="region" aria-label={t('mixes.player.label')}>
      {s?.coverUrl && !dataSaver.active ? <img className="mix-player__cover" src={s.coverUrl} alt="" /> : <Icon name="mix" size={24} />}
      <div className="mix-player__text" aria-live="polite">
        {s ? (
          <>
            <bdi className="mix-player__title">{s.title}</bdi>
            <span className="mix-player__meta">
              <bdi>{s.artist}</bdi> · {t('mixes.player.position', { n: position, total: playable })}
            </span>
          </>
        ) : (
          <span className="mix-player__meta">{t('mixes.player.ready', { total: playable })}</span>
        )}
      </div>
      <button type="button" className="mix-player__btn" aria-label={t('mixes.player.previous')} disabled={!s} onClick={player.previous}>
        <Icon name="skip-previous" size={20} />
      </button>
      <button
        type="button"
        className="mix-player__btn mix-player__btn--main"
        aria-label={t(player.playing ? 'mixes.player.pause' : 'mixes.player.play')}
        onClick={player.toggle}
      >
        <Icon name={player.playing ? 'pause' : 'play'} filled size={22} />
      </button>
      <button type="button" className="mix-player__btn" aria-label={t('mixes.player.next')} disabled={!s} onClick={player.next}>
        <Icon name="skip-next" size={20} />
      </button>
    </div>
  );
}

// ── Songs ───────────────────────────────────────────────────────────────

/**
 * A mix's songs in order. Each plays from its row; songs that can't play are greyed with the reason.
 * People who may add to the mix move songs with the up and down buttons (or by dragging), and take
 * off the ones they may.
 */
export function SongList({ mix, player, onMix }: { mix: MixDetail; player: ReturnType<typeof useMixPlayer>; onMix: (m: MixDetail) => void }) {
  const { t, toast, dataSaver } = useSession();
  const [dragging, setDragging] = useState<number | null>(null);
  const [status, setStatus] = useState('');

  async function reorder(from: number, to: number) {
    if (from === to || to < 0 || to >= mix.songs.length) return;
    const songs = moveItem(mix.songs, from, to);
    const before = mix;
    onMix({ ...mix, songs });
    setStatus(t('mixes.moved', { title: mix.songs[from]!.title || t('mixes.unavailable.hidden'), n: to + 1 }));
    try {
      onMix(
        (
          await api.mixes.reorder(
            mix.id,
            songs.map((s) => s.id),
          )
        ).mix,
      );
    } catch (e) {
      onMix(before);
      toast(errorMessage(e));
      // Changed by someone else meanwhile: show it as it is now.
      api.mixes.get(mix.id).then(
        (r) => onMix(r.mix),
        () => {},
      );
    }
  }

  async function remove(s: MixSong) {
    try {
      onMix((await api.mixes.removeSong(mix.id, s.id)).mix);
      toast(t('mixes.removed'));
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  if (!mix.songs.length) return <EmptyState title={t('mixes.empty.title')} body={mix.canAdd ? t('mixes.empty.body') : undefined} />;
  return (
    <>
      <p className="yp-visually-hidden" role="status" aria-live="polite">
        {status}
      </p>
      <ol className="mix-songs">
        {mix.songs.map((s, i) => {
          const name = s.title || t('mixes.unavailable.hidden');
          const by = addedByText(s, t);
          const current = player.index === i;
          return (
            <li
              key={s.id}
              className={`mix-song${s.play ? '' : ' mix-song--off'}${current ? ' mix-song--current' : ''}${dragging === i ? ' mix-song--dragging' : ''}`}
              draggable={mix.canAdd}
              onDragStart={(e) => {
                setDragging(i);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => mix.canAdd && dragging !== null && e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (dragging !== null) void reorder(dragging, i);
                setDragging(null);
              }}
              onDragEnd={() => setDragging(null)}
            >
              <span className="mix-song__n" aria-hidden>
                {i + 1}
              </span>
              {s.play ? (
                <button
                  type="button"
                  className="mix-song__play"
                  aria-label={t(current && player.playing ? 'mixes.player.pause' : 'mixes.song.play', { title: name })}
                  onClick={() => (current ? player.toggle() : player.playAt(i))}
                >
                  <Icon name={current && player.playing ? 'pause' : 'play'} filled size={18} />
                </button>
              ) : (
                <span className="mix-song__play mix-song__play--off" aria-hidden>
                  <Icon name="volume-off" size={18} />
                </span>
              )}
              {s.coverUrl && !dataSaver.active ? <img className="mix-song__cover" src={s.coverUrl} alt="" loading="lazy" decoding="async" /> : null}
              <span className="mix-song__text">
                {s.title ? (
                  <Link href={musicHref({ source: s.source, id: s.musicId })} className="mix-song__title">
                    <bdi>{s.title}</bdi>
                  </Link>
                ) : (
                  <span className="mix-song__title">{name}</span>
                )}
                {s.artist ? <bdi className="mix-song__meta">{s.artist}</bdi> : null}
                {s.unavailable ? <span className="mix-song__reason">{unavailableText(s, t)}</span> : null}
                {s.licenceName && !s.unavailable ? <span className="mix-song__meta">{songCredit(s, t)}</span> : null}
                {by ? <span className="mix-song__meta">{by}</span> : null}
              </span>
              {mix.canAdd ? (
                <span className="mix-song__actions">
                  <button
                    type="button"
                    className="mix-song__btn"
                    aria-label={t('mixes.song.up', { title: name })}
                    disabled={i === 0}
                    onClick={() => void reorder(i, i - 1)}
                  >
                    <Icon name="chevron-up" size={18} />
                  </button>
                  <button
                    type="button"
                    className="mix-song__btn"
                    aria-label={t('mixes.song.down', { title: name })}
                    disabled={i === mix.songs.length - 1}
                    onClick={() => void reorder(i, i + 1)}
                  >
                    <Icon name="chevron-down" size={18} />
                  </button>
                  {s.canRemove ? (
                    <button type="button" className="mix-song__btn" aria-label={t('mixes.song.remove', { title: name })} onClick={() => void remove(s)}>
                      <Icon name="x" size={18} />
                    </button>
                  ) : null}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </>
  );
}

/** Add songs from the music picker. The picker stays open to add more; each song is added as it's picked. */
export function AddSongs({ mix, onMix }: { mix: Pick<Mix, 'id' | 'title'>; onMix?: (m: MixDetail) => void }) {
  const { t, toast } = useSession();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="secondary" icon="plus" onClick={() => setOpen(true)}>
        {t('mixes.addSongs')}
      </Button>
      <MusicPicker
        open={open}
        onClose={() => setOpen(false)}
        onPick={async (track) => {
          try {
            const r = await api.mixes.addSongs(mix.id, [songRef(track)]);
            onMix?.(r.mix);
            toast(r.added ? t('mixes.added', { title: track.title, mix: mix.title }) : t('mixes.alreadyOn', { title: track.title }));
          } catch (e) {
            toast(errorMessage(e));
          }
        }}
      />
    </>
  );
}

// ── Making and sharing ──────────────────────────────────────────────────

/** Make a mix, or change its name, description and who sees it. */
export function MixEditor({ open, onClose, onSaved, mix }: { open: boolean; onClose: () => void; onSaved: (m: MixDetail) => void; mix?: Mix }) {
  const { t, toast } = useSession();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<MixVisibility>('followers');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle(mix?.title ?? '');
    setDescription(mix?.description ?? '');
    setVisibility(mix?.visibility ?? 'followers');
  }, [open, mix]);

  return (
    <BottomSheet open={open} onClose={onClose} title={t(mix ? 'mixes.edit' : 'mixes.new')}>
      <form
        className="stack-sm"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!title.trim()) return;
          setBusy(true);
          try {
            const body = { title: title.trim(), description: description.trim(), visibility };
            const r = mix ? await api.mixes.update(mix.id, body) : await api.mixes.create(body);
            onSaved(r.mix);
          } catch (err) {
            toast(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <TextField
          label={t('mixes.titleLabel')}
          value={title}
          maxLength={MIX_TITLE_MAX}
          required
          placeholder={t('mixes.titlePlaceholder')}
          onChange={(e) => setTitle(e.currentTarget.value)}
          hint={`${title.length}/${MIX_TITLE_MAX}`}
        />
        <TextField
          label={t('mixes.descriptionLabel')}
          multiline
          rows={2}
          value={description}
          maxLength={MIX_DESCRIPTION_MAX}
          onChange={(e) => setDescription(e.currentTarget.value)}
          hint={`${description.length}/${MIX_DESCRIPTION_MAX}`}
        />
        <Select label={t('mixes.visibilityLabel')} value={visibility} onChange={(e) => setVisibility(e.currentTarget.value as MixVisibility)}>
          {MIX_VISIBILITIES.map((v) => (
            <option key={v} value={v}>
              {t(MIX_VISIBILITY_LABEL[v])}
            </option>
          ))}
        </Select>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          {t(`mixes.visibilityHint.${visibility}` as MessageKey)}
        </p>
        <Button type="submit" loading={busy} disabled={!title.trim()}>
          {t(mix ? 'common.save' : 'mixes.create')}
        </Button>
      </form>
    </BottomSheet>
  );
}

/** A one-to-one chat's name is the other person's. */
function chatName(c: Conversation, meId: string | undefined, t: T) {
  if (c.title) return c.title;
  const others = c.members.filter((m) => m.id !== meId).map((m) => m.displayName);
  return others.join(', ') || t('mixes.share.chat');
}

/** Share a mix into a chat (one-to-one or group): everyone there can then add and reorder songs. */
export function ShareToChatSheet({ mix, open, onClose, onShared }: { mix: Mix; open: boolean; onClose: () => void; onShared?: (m: Message) => void }) {
  const { t, toast, me } = useSession();
  const [chats, setChats] = useState<Conversation[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setChats(null);
    api.conversations.list().then(
      (r) => setChats(r.items.filter((c) => c.kind === 'direct' || c.kind === 'group')),
      (e) => (setChats([]), toast(errorMessage(e))),
    );
  }, [open, toast]);
  const shared = new Set(mix.chats.map((c) => c.conversationId));
  return (
    <BottomSheet open={open} onClose={onClose} title={t('mixes.share.title')}>
      <div className="stack-sm">
        <p className="muted" style={{ margin: 0 }}>
          {t('mixes.share.hint')}
        </p>
        {chats === null ? (
          <Skeleton height={48} />
        ) : chats.length ? (
          <ul className="mix-chats">
            {chats.map((c) => (
              <li key={c.id}>
                <span className="mix-chats__name">
                  <Icon name={c.kind === 'group' ? 'users' : 'message'} size={16} /> <bdi>{chatName(c, me?.id, t)}</bdi>
                </span>
                {shared.has(c.id) ? (
                  <Link className="yp-btn yp-btn--ghost yp-btn--sm" href={`/inbox/${c.id}`}>
                    {t('mixes.share.open')}
                  </Link>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busy === c.id}
                    aria-label={t('mixes.share.to', { name: chatName(c, me?.id, t) })}
                    onClick={async () => {
                      setBusy(c.id);
                      try {
                        const r = await api.mixes.share(mix.id, c.id, crypto.randomUUID());
                        toast(t('mixes.share.done'));
                        onShared?.(r.message);
                        onClose();
                      } catch (e) {
                        toast(errorMessage(e));
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    {t('mixes.share.send')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">{t('mixes.share.noChats')}</p>
        )}
      </div>
    </BottomSheet>
  );
}

/** From a chat's + menu: choose one of your mixes to share here. */
export function ShareMixHereSheet({
  open,
  onClose,
  conversationId,
  onSent,
}: {
  open: boolean;
  onClose: () => void;
  conversationId: string;
  onSent: (m: Message) => void;
}) {
  const { t, toast, locale } = useSession();
  const [items, setItems] = useState<Mix[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setItems(null);
    api.mixes.mine('own').then(
      (r) => setItems(r.items.filter((m) => m.visibility !== 'private')),
      () => setItems([]),
    );
  }, [open]);
  return (
    <BottomSheet open={open} onClose={onClose} title={t('mixes.shareHere')}>
      <div className="stack-sm">
        <p className="muted" style={{ margin: 0 }}>
          {t('mixes.share.hint')}
        </p>
        {items === null ? (
          <Skeleton height={64} />
        ) : items.length ? (
          <ul className="mix-grid">
            {items.map((m) => (
              <li key={m.id}>
                <MixTile mix={{ available: true, ...m }} locale={locale} linkAs={NextLink}>
                  <div className="mix-tile__actions">
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={busy === m.id}
                      aria-label={t('mixes.share.sendMix', { title: m.title })}
                      onClick={async () => {
                        setBusy(m.id);
                        try {
                          onSent((await api.mixes.share(m.id, conversationId, crypto.randomUUID())).message);
                          onClose();
                        } catch (e) {
                          toast(errorMessage(e));
                        } finally {
                          setBusy(null);
                        }
                      }}
                    >
                      {t('mixes.share.send')}
                    </Button>
                  </div>
                </MixTile>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            title={t('mixes.share.noMixes')}
            action={
              <Link href="/mixes" className="yp-btn yp-btn--secondary yp-btn--sm">
                {t('mixes.yours')}
              </Link>
            }
          />
        )}
      </div>
    </BottomSheet>
  );
}

/** Share a mix as a post: your words (or its name) and who sees the post. */
export function PostMixSheet({ mix, open, onClose }: { mix: Mix; open: boolean; onClose: () => void }) {
  const { t, toast } = useSession();
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'followers' | 'friends'>('public');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setBody('');
  }, [open]);
  return (
    <BottomSheet open={open} onClose={onClose} title={t('mixes.post.title')}>
      <form
        className="stack-sm"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const r = await api.mixes.post(mix.id, { body: body.trim(), visibility });
            toast(r.moderation?.message ?? t('mixes.post.done'));
            onClose();
          } catch (err) {
            toast(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <TextField label={t('mixes.post.body')} multiline rows={3} value={body} maxLength={2000} onChange={(e) => setBody(e.currentTarget.value)} />
        <Select label={t('mixes.post.audience')} value={visibility} onChange={(e) => setVisibility(e.currentTarget.value as typeof visibility)}>
          <option value="public">{t('mixes.visibility.public')}</option>
          <option value="followers">{t('mixes.visibility.followers')}</option>
          <option value="friends">{t('mixes.visibility.friends')}</option>
        </Select>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          {t('mixes.post.hint')}
        </p>
        <Button type="submit" loading={busy}>
          {t('mixes.post.send')}
        </Button>
      </form>
    </BottomSheet>
  );
}

// ── Lists and cards ─────────────────────────────────────────────────────

/** Mixes as a list of cards. */
export function MixGrid({ items, empty }: { items: Mix[] | null; empty: { title: string; body?: string } }) {
  const { locale } = useSession();
  if (items === null) return <Skeleton height={88} />;
  if (!items.length) return <EmptyState title={empty.title} body={empty.body} />;
  return (
    <ul className="mix-grid">
      {items.map((m) => (
        <li key={m.id}>
          <MixTile mix={{ available: true, ...m }} locale={locale} linkAs={NextLink} />
        </li>
      ))}
    </ul>
  );
}

/** The Mixes tab on a profile. */
export function ProfileMixes({ username, isSelf }: { username: string; isSelf: boolean }) {
  const { t } = useSession();
  const [items, setItems] = useState<Mix[] | null>(null);
  useEffect(() => {
    api.mixes.forUser(username).then(
      (r) => setItems(r.items),
      () => setItems([]),
    );
  }, [username]);
  return (
    <div className="stack-sm">
      {isSelf ? (
        <Link href="/mixes" className="yp-btn yp-btn--secondary yp-btn--sm" style={{ alignSelf: 'flex-start' }}>
          {t('mixes.yours')}
        </Link>
      ) : null}
      <MixGrid items={items} empty={{ title: t('mixes.profileEmpty') }} />
    </div>
  );
}

/**
 * A mix shared into a chat: its card, and (for people who may add to it) Add songs. Songs added in
 * the chat show as a line below ("Ada added 3 songs to Road trip").
 */
export function ChatMixCard({ mix, onMix }: { mix: MixCard; onMix?: (m: MixCard) => void }) {
  const { locale } = useSession();
  return (
    <MixTile mix={mix} locale={locale} linkAs={NextLink}>
      {mix.available && mix.canAdd ? (
        <div className="mix-tile__actions">
          <AddSongs mix={mix} onMix={(m) => onMix?.({ available: true, ...m })} />
        </div>
      ) : null}
    </MixTile>
  );
}

/** The mosaic big, for a mix's page. */
export function MixHeaderCover({ covers }: { covers: string[] }) {
  return <MixMosaic covers={covers} size={120} />;
}
