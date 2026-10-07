'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Button, EmptyState, Icon, Skeleton } from '@yapilapi/design-system';
import type { MessageKey, MusicTrack } from '@yapilapi/shared';
import { api, errorMessage, isGone } from '@/lib/api';
import { PostList } from '@/components/PostList';
import { SoundPlayButton, soundLength } from '@/components/SoundPicker';
import { BackButton } from '@/components/BackButton';
import { useMusicCredit } from '@/components/StoryMusic';
import { useSession } from '../../../providers';

/**
 * A song from the music catalogue: play the preview, see its licence and the credit it asks for,
 * save it, use it in a post, reel or story (when its licence allows it for you), and the posts you
 * can see that play it.
 */
export default function MusicTrackPage() {
  const { id } = useParams<{ id: string }>();
  const { me, t, tp, toast } = useSession();
  const credit = useMusicCredit();
  const [track, setTrack] = useState<MusicTrack | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  // Why it couldn't load, when that isn't because it's gone.
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadTrack = useCallback(() => {
    setMissing(null);
    setLoadError(null);
    api.music.track(id).then(
      (r) => setTrack(r.track),
      (e) => (isGone(e) ? setMissing(errorMessage(e)) : setLoadError(errorMessage(e))),
    );
  }, [id]);
  useEffect(() => {
    setTrack(null);
    loadTrack();
  }, [loadTrack]);

  const load = useCallback((cursor?: string) => api.music.posts(id, cursor), [id]);

  if (missing) return <EmptyState level={1} title={t('music.track.missing')} body={missing} />;
  if (!track && loadError) return <EmptyState level={1} title={loadError} action={<Button onClick={loadTrack}>{t('m.common.retry')}</Button>} />;
  if (!track) return <Skeleton height={240} />;

  async function toggleSave() {
    if (!track) return;
    const next = !track.saved;
    setTrack({ ...track, saved: next });
    try {
      await api.music.save(track, next);
    } catch (e) {
      setTrack({ ...track, saved: !next });
      toast(errorMessage(e));
    }
  }

  return (
    <div className="yp-shell__inner stack">
      <BackButton fallback="/reels" />
      <section className="sound-hero" aria-labelledby="track-title">
        <div className="sound-hero__cover" style={track.coverUrl ? { backgroundImage: `url(${track.coverUrl})` } : undefined}>
          <SoundPlayButton sound={{ title: track.title, audioUrl: track.previewUrl }} size="lg" />
        </div>
        <div className="sound-hero__text">
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {t('music.track.kind')}
          </p>
          <h1 id="track-title">
            <Icon name="music" size={20} /> <bdi>{track.title}</bdi>
          </h1>
          <p style={{ margin: 0 }}>
            <bdi>{track.artist}</bdi>
            {track.album ? (
              <span className="muted">
                {' · '}
                {t('music.track.album', { album: track.album })}
              </span>
            ) : null}
          </p>
          <p className="muted" style={{ margin: 0 }}>
            {tp('music.track.uses', track.uses)}
            {soundLength(track.durationMs) ? ` · ${soundLength(track.durationMs)}` : ''}
          </p>
          <p className="music-row__credit">
            {credit({ ...track, licenceName: track.licence.name })}
            {track.licence.url ? (
              <>
                {' · '}
                <a href={track.licence.url} target="_blank" rel="noopener noreferrer license">
                  {t('music.track.licence')}
                </a>
              </>
            ) : null}
          </p>
          {track.source === 'dev' ? <p className="music-hint muted">{t('music.track.devNote')}</p> : null}
          {track.blocked ? <p className="music-row__blocked">{t(`music.blocked.${track.blocked}` as MessageKey)}</p> : null}
          {me && track.canUse ? (
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <Link href={`/create?mode=post&track=${track.id}`} className="yp-btn yp-btn--primary yp-btn--sm">
                {t('music.track.inPost')}
              </Link>
              <Link href={`/create?mode=reel&track=${track.id}`} className="yp-btn yp-btn--secondary yp-btn--sm">
                {t('music.track.inReel')}
              </Link>
              <Link href={`/create?mode=story&track=${track.id}`} className="yp-btn yp-btn--secondary yp-btn--sm">
                {t('music.track.inStory')}
              </Link>
              <button
                type="button"
                className="music-row__save"
                aria-pressed={track.saved}
                aria-label={t(track.saved ? 'music.unsave' : 'music.save', { title: track.title })}
                onClick={() => void toggleSave()}
              >
                <Icon name="bookmark" filled={track.saved} size={18} />
              </button>
            </div>
          ) : null}
        </div>
      </section>
      <PostList load={load} reloadKey={id} empty={t('music.track.empty')} showEnd={false} />
    </div>
  );
}
