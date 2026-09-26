'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Button, EmptyState, Skeleton } from '@yapilapi/design-system';
import type { ArchivedStory } from '@yapilapi/api-client';
import { api, errorMessage } from '@/lib/api';
import { AddToChapter, formatDay } from '@/components/Chapters';
import { useSession } from '../../providers';

/**
 * Your archive: your stories after they expire, private to you. Browse by month, add a story
 * to a chapter, or delete it for good.
 */
export default function ArchivePage() {
  const { me, toast, locale } = useSession();
  const [months, setMonths] = useState<{ month: string; count: number }[] | null>(null);
  const [month, setMonth] = useState<string | null>(null);
  const [items, setItems] = useState<ArchivedStory[] | null>(null);
  const [adding, setAdding] = useState<string | null>(null);

  useEffect(() => {
    api.archive.months().then(
      (r) => {
        setMonths(r.items);
        setMonth(r.items[0]?.month ?? null);
      },
      (e) => {
        setMonths([]);
        toast(errorMessage(e));
      },
    );
  }, [toast]);

  const load = useCallback(() => {
    if (!month) return setItems([]);
    setItems(null);
    api.archive.list(month).then(
      (r) => setItems(r.items),
      (e) => {
        setItems([]);
        toast(errorMessage(e));
      },
    );
  }, [month, toast]);
  useEffect(() => {
    if (months) load();
  }, [load, months]);

  const monthName = (m: string) => new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${m}-01T00:00:00Z`));

  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>Your archive</h1>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        Your stories stay here after they expire. Only you can see your archive. Put the ones you want to keep showing into a chapter on{' '}
        <Link href={me ? `/u/${me.username}` : '/home'}>your profile</Link>.
      </p>
      {months === null ? (
        <Skeleton height={200} />
      ) : !months.length ? (
        <EmptyState title="Nothing here yet" body="When your stories expire, they come here, just for you." />
      ) : (
        <>
          <div className="row" role="group" aria-label="Month">
            {months.map((m) => (
              <button key={m.month} type="button" className="yp-chip" aria-pressed={m.month === month} onClick={() => setMonth(m.month)}>
                {monthName(m.month)} · {m.count}
              </button>
            ))}
          </div>
          {items === null ? (
            <Skeleton height={200} />
          ) : (
            <ul className="story-grid">
              {items.map((s) => (
                <li key={s.id} className="story-tile">
                  <div className="story-tile__media" role="img" aria-label={s.body || 'Story'}>
                    {s.mediaKind === 'image' && s.mediaUrl ? (
                      <img src={s.mediaUrl} alt="" className={s.sensitive ? 'yp-blurred' : undefined} />
                    ) : s.posterUrl ? (
                      <img src={s.posterUrl} alt="" className={s.sensitive ? 'yp-blurred' : undefined} />
                    ) : (
                      <p dir="auto">{s.blocked ? 'This photo or video isn’t available' : s.body}</p>
                    )}
                  </div>
                  <span className="story-tile__meta">
                    <time dateTime={s.createdAt}>{formatDay(s.createdAt, locale)}</time>
                    {s.chapters.length ? ` · In ${s.chapters.map((c) => c.title).join(', ')}` : ''}
                  </span>
                  <div className="row" style={{ gap: 4 }}>
                    {!s.blocked ? (
                      <Button size="sm" variant="secondary" onClick={() => setAdding(s.id)}>
                        Add to a chapter
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        if (!confirm('Delete this story for good? It also leaves any chapter it is in.')) return;
                        try {
                          await api.archive.remove(s.id);
                          setItems((cur) => cur?.filter((x) => x.id !== s.id) ?? null);
                          setMonths((cur) => cur?.map((m) => (m.month === month ? { ...m, count: m.count - 1 } : m)).filter((m) => m.count > 0) ?? null);
                          toast('Story deleted');
                        } catch (e) {
                          toast(errorMessage(e));
                        }
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <AddToChapter momentId={adding} open={adding !== null} onClose={() => setAdding(null)} onAdded={load} />
    </div>
  );
}
