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
  const { me, toast, locale, t } = useSession();
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
        <h1>{t('m.archive.title')}</h1>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        {(() => {
          // The link sits wherever {link} falls in the translated sentence.
          const [before, after = ''] = t('archive.intro').split('{link}');
          return (
            <>
              {before}
              <Link href={me ? `/u/${me.username}` : '/home'}>{t('archive.yourProfile')}</Link>
              {after}
            </>
          );
        })()}
      </p>
      {months === null ? (
        <Skeleton height={200} />
      ) : !months.length ? (
        <EmptyState title={t('m.feed.empty.title')} body={t('archive.emptyBody')} />
      ) : (
        <>
          <div className="row" role="group" aria-label={t('archive.month')}>
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
                  <div className="story-tile__media" role="img" aria-label={s.body || t('m.create.mode.story')}>
                    {s.mediaKind === 'image' && s.mediaUrl ? (
                      <img src={s.mediaUrl} alt="" className={s.sensitive ? 'yp-blurred' : undefined} />
                    ) : s.posterUrl ? (
                      <img src={s.posterUrl} alt="" className={s.sensitive ? 'yp-blurred' : undefined} />
                    ) : (
                      <p dir="auto">{s.blocked ? t('archive.unavailable') : s.body}</p>
                    )}
                  </div>
                  <span className="story-tile__meta">
                    <time dateTime={s.createdAt}>{formatDay(s.createdAt, locale)}</time>
                    {s.chapters.length ? ` · ${t('m.archive.inChapters', { titles: new Intl.ListFormat(locale).format(s.chapters.map((c) => c.title)) })}` : ''}
                  </span>
                  <div className="row" style={{ gap: 4 }}>
                    {!s.blocked ? (
                      <Button size="sm" variant="secondary" onClick={() => setAdding(s.id)}>
                        {t('m.chapters.add')}
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        if (!confirm(`${t('m.archive.delete.title')} ${t('m.archive.delete.body')}`)) return;
                        try {
                          await api.archive.remove(s.id);
                          setItems((cur) => cur?.filter((x) => x.id !== s.id) ?? null);
                          setMonths((cur) => cur?.map((m) => (m.month === month ? { ...m, count: m.count - 1 } : m)).filter((m) => m.count > 0) ?? null);
                          toast(t('archive.deleted'));
                        } catch (e) {
                          toast(errorMessage(e));
                        }
                      }}
                    >
                      {t('m.common.delete')}
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
