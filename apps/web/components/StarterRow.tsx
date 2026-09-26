'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Icon } from '@yapilapi/design-system';
import type { TrendingTag } from '@yapilapi/api-client';
import type { Post } from '@yapilapi/shared';
import { api } from '@/lib/api';
import { useSession } from '@/app/providers';

/** Home shows this while someone follows fewer than this many people. */
export const STARTER_BELOW = 3;

/**
 * For people who follow fewer than three accounts: a row of reels to start with (from the
 * reels feed, which follows their interests) and trending tags, so Home is never empty.
 */
export function StarterRow() {
  const { me, t } = useSession();
  const [show, setShow] = useState(false);
  const [reels, setReels] = useState<Post[]>([]);
  const [tags, setTags] = useState<TrendingTag[]>([]);

  useEffect(() => {
    if (!me) return;
    let live = true;
    void (async () => {
      const profile = await api.users.get(me.username).catch(() => null);
      if (!live || !profile || profile.profile.counts.following >= STARTER_BELOW) return;
      setShow(true);
      const [r, tr] = await Promise.all([api.reels().catch(() => null), api.trending(8).catch(() => null)]);
      if (!live) return;
      setReels((r?.items ?? []).filter((p) => p.author.id !== me.id).slice(0, 10));
      setTags(tr?.items ?? []);
    })();
    return () => {
      live = false;
    };
  }, [me]);

  if (!show || (!reels.length && !tags.length)) return null;
  return (
    <section className="starter" aria-labelledby="starter-title">
      <div className="starter__head">
        <h2 id="starter-title" className="section-title">
          {t('starter.reels')}
        </h2>
        <Link href="/find-friends" className="yp-btn yp-btn--ghost yp-btn--sm">
          {t('friends.title')}
        </Link>
      </div>
      <p className="muted starter__body">{t('starter.body')}</p>
      {reels.length ? (
        <ul className="starter__reels">
          {reels.map((p) => {
            const media = p.media.find((m) => m.kind === 'video') ?? p.media[0];
            return (
              <li key={p.id}>
                <Link href={`/reels?start=${p.id}`} className="starter__reel" aria-label={`Reel by ${p.author.displayName}`}>
                  {media?.posterUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={media.posterUrl} alt="" loading="lazy" />
                  ) : (
                    <span className="starter__play" aria-hidden>
                      <Icon name="play" size={28} />
                    </span>
                  )}
                  <bdi className="starter__by">{p.author.displayName}</bdi>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
      {tags.length ? (
        <>
          <h3 className="starter__subtitle">{t('starter.tags')}</h3>
          <div className="starter__tags">
            {tags.map((tg) => (
              <Link key={tg.tag} href={`/t/${encodeURIComponent(tg.tag)}`} className="starter__tag">
                <bdi>#{tg.tag}</bdi>
              </Link>
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}
