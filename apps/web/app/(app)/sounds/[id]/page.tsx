'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Avatar, Button, EmptyState, Icon, Segments, Skeleton } from '@yapilapi/design-system';
import type { Sound } from '@yapilapi/shared';
import { api, errorMessage, isGone } from '@/lib/api';
import { ReelGrid } from '@/components/ReelGrid';
import { SoundPlayButton, soundLength } from '@/components/SoundPicker';
import { useSession } from '../../../providers';

/** A sound: play it, see who made it and the reels that use it (most recent or top), and make your own reel or story with it. */
export default function SoundPage() {
  const { id } = useParams<{ id: string }>();
  const { me, locale, t, tp } = useSession();
  const [sound, setSound] = useState<Sound | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  // Why it couldn't load, when that isn't because it's gone or private.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sort, setSort] = useState<'recent' | 'top'>('recent');
  const n = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 });
  // "{number} reels" with the number in bold, in whatever order the language puts them.
  const stat = (text: string, value: number) => {
    const [before = '', after = ''] = text.split('{number}');
    return (
      <>
        {before}
        <strong>{n.format(value)}</strong>
        {after}
      </>
    );
  };

  const loadSound = useCallback(() => {
    setMissing(null);
    setLoadError(null);
    api.sounds.get(id).then(
      (r) => setSound(r.sound),
      (e) => (isGone(e) ? setMissing(errorMessage(e)) : setLoadError(errorMessage(e))),
    );
  }, [id]);
  useEffect(() => {
    setSound(null);
    loadSound();
  }, [loadSound]);

  const load = useCallback((cursor?: string) => api.sounds.reels(id, sort, cursor), [id, sort]);

  if (missing) return <EmptyState title={t('soundPage.unavailable')} body={missing} />;
  if (!sound && loadError) return <EmptyState title={loadError} action={<Button onClick={loadSound}>{t('m.common.retry')}</Button>} />;
  if (!sound) return <Skeleton height={240} />;

  return (
    <div className="yp-shell__inner stack">
      <section className="sound-hero" aria-labelledby="sound-title">
        <div className="sound-hero__cover" style={sound.coverUrl ? { backgroundImage: `url(${sound.coverUrl})` } : undefined}>
          <SoundPlayButton sound={sound} size="lg" />
        </div>
        <div className="sound-hero__text">
          <h1 id="sound-title">
            <Icon name="music" size={20} /> <bdi>{sound.title}</bdi>
          </h1>
          <Link href={`/u/${sound.owner.username}`} className="sound-hero__owner">
            <Avatar name={sound.owner.displayName} src={sound.owner.avatarUrl} size="sm" />
            <bdi>{sound.owner.displayName}</bdi>
          </Link>
          <p className="muted" style={{ margin: 0 }}>
            {stat(tp('soundPage.reels', sound.reels), sound.reels)}
            {sound.stories ? (
              <>
                {' · '}
                {stat(tp('soundPage.stories', sound.stories), sound.stories)}
              </>
            ) : null}
            {sound.posts ? ` · ${tp('m.sound.postCount', sound.posts)}` : ''}
            {soundLength(sound.durationMs) ? ` · ${soundLength(sound.durationMs)}` : ''}
            {sound.sourcePostId ? (
              <>
                {' · '}
                <Link href={`/reels?start=${sound.sourcePostId}`}>{t('m.sound.original')}</Link>
              </>
            ) : null}
          </p>
          {me && sound.canUse ? (
            <div className="row">
              <Link href={`/create?mode=reel&sound=${sound.id}`} className="yp-btn yp-btn--primary yp-btn--sm">
                {t('m.sound.use')}
              </Link>
              <Link href={`/create?mode=story&sound=${sound.id}`} className="yp-btn yp-btn--secondary yp-btn--sm">
                {t('m.sound.useInStory')}
              </Link>
              <Link href={`/create?mode=post&sound=${sound.id}`} className="yp-btn yp-btn--secondary yp-btn--sm">
                {t('music.track.inPost')}
              </Link>
            </div>
          ) : me ? (
            <p className="muted" style={{ margin: 0, fontSize: 14 }}>
              {t('soundPage.cantUse')}
            </p>
          ) : (
            <Link href="/login" className="yp-btn yp-btn--secondary yp-btn--sm" style={{ alignSelf: 'flex-start' }}>
              {t('soundPage.signIn')}
            </Link>
          )}
        </div>
      </section>
      <Segments
        label={t('soundPage.sort')}
        value={sort}
        onChange={setSort}
        options={[
          { id: 'recent', label: t('m.sound.recent') },
          { id: 'top', label: t('m.sound.top') },
        ]}
      />
      <ReelGrid load={load} reloadKey={`${id}:${sort}`} empty={t('m.sound.empty')} />
    </div>
  );
}
