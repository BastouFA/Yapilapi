'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Button, EmptyState, Icon, Skeleton } from '@yapilapi/design-system';
import { videoPoster, type Page, type Post } from '@yapilapi/shared';
import { errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';

/**
 * Reels as a grid of poster frames (sound pages, remixes, echoes). Each opens in the
 * Reels player. Loads a page at a time with a "Show more" button.
 */
export function ReelGrid({ load, reloadKey, empty }: { load: (cursor?: string) => Promise<Page<Post>>; reloadKey: string; empty: string }) {
  const { locale, toast, dataSaver, t } = useSession();
  const [items, setItems] = useState<Post[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const n = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 });

  useEffect(() => {
    let live = true;
    setItems(null);
    load().then(
      (r) => {
        if (!live) return;
        setItems(r.items);
        setCursor(r.nextCursor);
      },
      (e) => {
        if (!live) return;
        setItems([]);
        toast(errorMessage(e));
      },
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  if (items === null) return <Skeleton height={320} />;
  if (!items.length) return <EmptyState title={t('m.feed.empty.title')} body={empty} />;

  return (
    <div className="stack">
      <ul className="reel-grid">
        {items.map((p) => {
          const m = p.media[0];
          return (
            <li key={p.id}>
              <Link
                href={`/reels?start=${p.id}`}
                className="reel-grid__item"
                aria-label={`${t('reel.card.label', { name: p.author.displayName })}${p.body ? ` ${p.body.slice(0, 80)}` : ''}`}
              >
                {m && videoPoster(m, dataSaver.active) ? (
                  <img src={videoPoster(m, dataSaver.active)} alt="" loading="lazy" />
                ) : m && !dataSaver.active ? (
                  <video src={(m.variants as Record<string, string> | undefined)?.mp4 ?? m.url} muted playsInline preload="metadata" aria-hidden />
                ) : null}
                {p.echoOf ? (
                  <span className="reel-grid__badge">
                    <Icon name="repost" size={12} />
                    {t('echo.title')}
                  </span>
                ) : p.remixOf ? (
                  <span className="reel-grid__badge">
                    <Icon name="duet" size={12} />
                    {p.remixOf.mode === 'duet' ? t('reelGrid.duet') : t('reelGrid.remix')}
                  </span>
                ) : null}
                <span className="reel-grid__meta">
                  <bdi>@{p.author.username}</bdi>
                  <span>
                    <Icon name="heart" size={12} filled /> {n.format(p.counts.likes)}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      {cursor ? (
        <Button
          variant="secondary"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await load(cursor);
              setItems((cur) => [...(cur ?? []), ...r.items.filter((x) => !cur?.some((y) => y.id === x.id))]);
              setCursor(r.nextCursor);
            } catch (e) {
              toast(errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {t('boards.showMore')}
        </Button>
      ) : null}
    </div>
  );
}
