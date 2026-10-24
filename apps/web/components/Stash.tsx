'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Avatar, Badge, Button, Icon, Switch, type IconName } from '@yapilapi/design-system';
import {
  STASH_BADGE_KEYS,
  STASH_KIND_KEYS,
  STASH_MAX_ACCURACY,
  mapDistance,
  type MessageKey,
  type StashCard,
  type StashContent,
  type StashExplorer,
  type StashKind,
  type StashSettings,
} from '@yapilapi/shared';
import { useSession } from '@/app/providers';
import { api, errorMessage } from '@/lib/api';
import { geoProblemText } from '@/components/Market';

/**
 * Stash on the web (docs/product/stash.md): cards, what's inside, explorer counts, settings, and the
 * precise position hiding and opening need. The position is asked for only when someone taps
 * "Use my location" or "Open it here", and goes to the server only with those two actions.
 */

export const STASH_KIND_ICONS: Record<StashKind, IconName> = {
  text: 'edit',
  photo: 'image',
  video: 'video',
  song: 'music',
  voice: 'mic',
  gift: 'star',
};

export interface Position {
  lat: number;
  lng: number;
  accuracy: number;
}

/** Where the device is now, as precisely as it can say (for hiding and opening only). */
export function readPrecisePosition(): Promise<Position> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return reject('unsupported');
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) }),
      (e) => reject(e.code === e.PERMISSION_DENIED ? 'denied' : 'unavailable'),
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
    );
  });
}

/** The precise position, asked for on a tap: busy while it's found, a message when it can't be. */
export function usePrecisePosition() {
  const { t } = useSession();
  const [pos, setPos] = useState<Position | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  async function locate(): Promise<Position | null> {
    setBusy(true);
    setProblem(null);
    try {
      const p = await readPrecisePosition();
      setPos(p);
      if (p.accuracy > STASH_MAX_ACCURACY) setProblem(t('stash.form.inaccurate'));
      return p;
    } catch (e) {
      setProblem(geoProblemText(t, e));
      return null;
    } finally {
      setBusy(false);
    }
  }
  return { pos, locate, busy, problem };
}

/** "About 300 m away" (to the area's middle), or "Less than 100 m away". */
export function useAwayText() {
  const { t, locale } = useSession();
  return (metres: number) => {
    const d = mapDistance(t, metres, locale);
    return d ? t('stash.away', { distance: d }) : t('stash.close');
  };
}

/** "Hidden by Ada", or "Hidden by YAPILAPI" for the team's. */
export function hiddenBy(t: (k: MessageKey, v?: Record<string, string | number>) => string, s: StashCard): string {
  return s.seeded || !s.owner ? t('stash.byTeam') : t('stash.by', { name: s.owner.displayName });
}

/** One stash in a list: its kind, title, who hid it, roughly how far, and whether you found it. */
export function StashRow({ stash, metres }: { stash: StashCard; metres?: number | null }) {
  const { t, tp } = useSession();
  const away = useAwayText();
  const meta = [
    t(STASH_KIND_KEYS[stash.kind]),
    hiddenBy(t, stash),
    metres != null ? away(metres) : null,
    stash.found ? t('stash.opened') : stash.finds ? tp('stash.finds', stash.finds) : null,
  ].filter(Boolean);
  return (
    <Link href={`/stash/${stash.id}`} className="citymap-row">
      <span className="citymap-row__thumb citymap-row__thumb--stashes" aria-hidden="true">
        <Icon name={STASH_KIND_ICONS[stash.kind]} size={20} />
      </span>
      <span className="citymap-row__text">
        <span className="citymap-row__title">{stash.title || t('stash.untitled')}</span>
        {stash.hint ? <span className="citymap-row__sub">{stash.hint}</span> : null}
        <span className="citymap-row__meta">{meta.join(' · ')}</span>
      </span>
    </Link>
  );
}

/** What's inside: the words, the gift, the photo or video, the voice note, or the song. */
export function StashInside({ content }: { content: StashContent }) {
  const { t } = useSession();
  return (
    <div className="stash-inside stack">
      {content.media?.kind === 'image' ? <img className="stash-inside__media" src={content.media.url} alt={content.media.altText ?? ''} /> : null}
      {content.media?.kind === 'video' ? (
        <video className="stash-inside__media" src={content.media.url} poster={content.media.posterUrl ?? undefined} controls playsInline preload="metadata" />
      ) : null}
      {content.voice ? (
        <div className="stack">
          <audio src={content.voice.url} controls preload="none" aria-label={t('stash.kind.voice')} />
          {content.voice.transcript.text ? <p className="muted">{content.voice.transcript.text}</p> : null}
        </div>
      ) : null}
      {content.song ? (
        <div className="stash-inside__song">
          {content.song.track.coverUrl ? <img src={content.song.track.coverUrl} alt="" width={56} height={56} /> : <Icon name="music" size={24} />}
          <div className="stack" style={{ gap: 4 }}>
            <strong>{content.song.track.title}</strong>
            <span className="muted">{content.song.track.artist}</span>
            {content.song.track.previewUrl ? (
              <audio
                src={`${content.song.track.previewUrl}#t=${Math.floor(content.song.startMs / 1000)}`}
                controls
                preload="none"
                aria-label={content.song.track.title}
              />
            ) : null}
            <span className="muted stash-inside__credit">{content.song.track.attribution}</span>
          </div>
        </div>
      ) : null}
      {content.giftCode ? (
        <p className="stash-inside__gift" aria-label={t('stash.kind.gift')}>
          <Icon name="star" size={18} /> <span>{content.giftCode}</span>
        </p>
      ) : null}
      {content.body ? <p className="stash-inside__body">{content.body}</p> : null}
    </div>
  );
}

/** "Stashes found: 12 · Hidden: 5" and badges, on a profile (nothing when the person keeps it to themselves). */
export function ExplorerLine({ username }: { username: string }) {
  const { t, flags } = useSession();
  const [ex, setEx] = useState<StashExplorer | null>(null);
  useEffect(() => {
    if (flags.STASH === false) return;
    let live = true;
    api.stash
      .explorer(username)
      .then((r) => live && setEx(r.explorer))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [username, flags.STASH]);
  if (!ex || (!ex.found && !ex.hidden)) return null;
  return (
    <p className="stash-explorer">
      <Icon name="map-pin" size={16} /> <span>{t('stash.explorer', { found: ex.found, hidden: ex.hidden })}</span>
      {ex.badges.map((b) => (
        <Badge key={b} tone="new">
          {t(STASH_BADGE_KEYS[b])}
        </Badge>
      ))}
    </p>
  );
}

/** Stash settings: counts on your profile, explorer lists and "new stashes near me". */
export function StashSettingsFields() {
  const { t, toast } = useSession();
  const [s, setS] = useState<StashSettings | null>(null);
  useEffect(() => {
    api.stash
      .settings()
      .then((r) => setS(r.settings))
      .catch(() => {});
  }, []);
  if (!s) return null;
  const save = async (patch: Partial<Pick<StashSettings, 'showCounts' | 'explorerLists' | 'nearbyNotify'>>) => {
    setS({ ...s, ...patch });
    try {
      setS((await api.stash.setSettings(patch)).settings);
    } catch (e) {
      toast(errorMessage(e));
      setS(s);
    }
  };
  return (
    <div className="stack">
      <Switch label={t('stash.settings.showCounts')} checked={s.showCounts} onChange={(v) => void save({ showCounts: v })} />
      <Switch
        label={t('stash.settings.explorerLists')}
        checked={s.explorerLists}
        disabled={s.explorerListsLocked}
        onChange={(v) => void save({ explorerLists: v })}
      />
      {s.explorerListsLocked ? <p className="muted">{t('stash.settings.explorerListsLocked')}</p> : null}
      <Switch label={t('stash.settings.nearby')} checked={s.nearbyNotify} onChange={(v) => void save({ nearbyNotify: v })} />
    </div>
  );
}

/** A small avatar and name, for who found a stash. */
export function Person({ name, src }: { name: string; src: string | null }) {
  return (
    <span className="row" style={{ alignItems: 'center', gap: 'var(--space-2)' }}>
      <Avatar name={name} src={src} size="sm" />
      <span>{name}</span>
    </span>
  );
}

export function TakeBackButton({ id, onDone }: { id: string; onDone: () => void }) {
  const { t, toast } = useSession();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="ghost"
      loading={busy}
      onClick={async () => {
        if (!confirm(t('stash.takeBackConfirm'))) return;
        setBusy(true);
        try {
          await api.stash.takeBack(id);
          onDone();
        } catch (e) {
          toast(errorMessage(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      {t('stash.takeBack')}
    </Button>
  );
}
