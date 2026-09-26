'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Avatar, EmptyState, Icon, Segments, Skeleton } from '@yapilapi/design-system';
import type { Sound } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { ReelGrid } from '@/components/ReelGrid';
import { SoundPlayButton, soundLength } from '@/components/SoundPicker';
import { useSession } from '../../../providers';

/** A sound: play it, see who made it and the reels that use it (most recent or top), and make your own reel with it. */
export default function SoundPage() {
  const { id } = useParams<{ id: string }>();
  const { me, locale } = useSession();
  const [sound, setSound] = useState<Sound | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [sort, setSort] = useState<'recent' | 'top'>('recent');
  const n = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 });

  useEffect(() => {
    setSound(null);
    setMissing(null);
    api.sounds.get(id).then(
      (r) => setSound(r.sound),
      (e) => setMissing(errorMessage(e)),
    );
  }, [id]);

  const load = useCallback((cursor?: string) => api.sounds.reels(id, sort, cursor), [id, sort]);

  if (missing) return <EmptyState title="This sound isn't available" body={missing} />;
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
            <strong>{n.format(sound.reels)}</strong> {sound.reels === 1 ? 'reel' : 'reels'}
            {soundLength(sound.durationMs) ? ` · ${soundLength(sound.durationMs)}` : ''}
            {sound.sourcePostId ? (
              <>
                {' · '}
                <Link href={`/reels?start=${sound.sourcePostId}`}>Original reel</Link>
              </>
            ) : null}
          </p>
          {me && sound.canUse ? (
            <Link href={`/create?mode=reel&sound=${sound.id}`} className="yp-btn yp-btn--primary yp-btn--sm" style={{ alignSelf: 'flex-start' }}>
              Use this sound
            </Link>
          ) : me ? (
            <p className="muted" style={{ margin: 0, fontSize: 14 }}>
              This sound can&apos;t be used in new reels.
            </p>
          ) : (
            <Link href="/login" className="yp-btn yp-btn--secondary yp-btn--sm" style={{ alignSelf: 'flex-start' }}>
              Sign in to use this sound
            </Link>
          )}
        </div>
      </section>
      <Segments
        label="Sort reels"
        value={sort}
        onChange={setSort}
        options={[
          { id: 'recent', label: 'Most recent' },
          { id: 'top', label: 'Top' },
        ]}
      />
      <ReelGrid load={load} reloadKey={`${id}:${sort}`} empty="No reels you can see use this sound yet." />
    </div>
  );
}
