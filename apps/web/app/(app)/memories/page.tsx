'use client';

import { FeatureOff } from '@/components/FeatureOff';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, EmptyState, EventCard, Icon, PostCard, Skeleton, TextField } from '@yapilapi/design-system';
import type { MemorySummary } from '@yapilapi/api-client';
import type { EventItem, Post } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { NextLink } from '@/lib/link';
import { useSession } from '../../providers';

export default function Memories() {
  const { toast, locale, flags, t, tp } = useSession();
  const router = useRouter();
  const [items, setItems] = useState<MemorySummary[] | null>(null);
  const [sugg, setSugg] = useState<{ events: EventItem[]; onThisDay: Post[] } | null>(null);
  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);

  // Why the memories couldn't load (shown with Try again, not as "no memories yet").
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadList = useCallback(() => {
    setLoadError(null);
    api.memories.list().then(
      (r) => setItems(r.items),
      (e) => setLoadError(errorMessage(e)),
    );
  }, []);
  useEffect(() => {
    if (flags.MEMORY === false) return;
    loadList();
    api.memories
      .suggestions()
      .then(setSugg)
      .catch(() => {});
  }, [flags.MEMORY, loadList]);

  if (flags.MEMORY === false) return <FeatureOff name={t('memories.title')} />;

  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>{t('memories.title')}</h1>
        <Link href="/recaps" className="yp-btn yp-btn--ghost yp-btn--sm">
          {t('m.recap.yours')}
        </Link>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        {t('memories.intro')}
      </p>
      <form
        className="row"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!title.trim() || creating) return;
          setCreating(true);
          try {
            const { memory } = await api.memories.create({ title: title.trim() });
            router.push(`/memories/${memory.id}`);
          } catch (err) {
            toast(errorMessage(err));
            setCreating(false);
          }
        }}
      >
        <TextField
          label={t('memories.new')}
          placeholder={t('memories.newPlaceholder')}
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
          maxLength={120}
        />
        <Button type="submit" loading={creating} disabled={!title.trim()} style={{ alignSelf: 'flex-end' }}>
          {t('m.chapters.create')}
        </Button>
      </form>

      {sugg?.events.length ? (
        <section className="stack-sm">
          <h2 className="section-title">{t('memories.fromEvents')}</h2>
          {sugg.events.map((ev) => (
            <div key={ev.id} className="stack-sm">
              <EventCard event={ev} linkAs={NextLink} locale={locale} />
              <Button
                size="sm"
                variant="secondary"
                icon="sparkle"
                onClick={async () => {
                  try {
                    const { memoryId } = await api.memories.fromEvent(ev.id);
                    router.push(`/memories/${memoryId}`);
                  } catch (err) {
                    toast(errorMessage(err));
                  }
                }}
              >
                {t('memories.makeMemory')}
              </Button>
            </div>
          ))}
        </section>
      ) : null}

      <section className="stack-sm" aria-labelledby="on-this-day">
        <h2 id="on-this-day" className="section-title">
          {t('m.recap.onThisDay')}
        </h2>
        <div className="recap-cta">
          <span className="stack-sm" style={{ gap: 2, minWidth: 0 }}>
            <strong>{t('m.recap.make')}</strong>
            <span className="muted">{t('memories.onThisDayHint')}</span>
          </span>
          <Link href="/recaps/new?source=on_this_day" className="yp-btn yp-btn--secondary yp-btn--sm">
            <Icon name="play" size={16} />
            {t('memories.makeOne')}
          </Link>
        </div>
        {sugg?.onThisDay.map((p) => (
          <PostCard key={p.id} post={p} locale={locale} linkAs={NextLink} />
        ))}
      </section>

      <section className="stack-sm">
        <h2 className="section-title">{t('m.recap.memories')}</h2>
        {items === null && loadError ? (
          <EmptyState
            title={loadError}
            action={
              <Button variant="secondary" onClick={loadList}>
                {t('m.common.retry')}
              </Button>
            }
          />
        ) : items === null ? (
          <Skeleton height={120} />
        ) : items.length ? (
          <div className="yp-grid">
            {items.map((m) => (
              <Link key={m.id} href={`/memories/${m.id}`} className="yp-ccard">
                <h3 className="yp-ccard__title">{m.title}</h3>
                {m.recap ? <p className="yp-ccard__desc">{m.recap}</p> : null}
                <span className="yp-ccard__meta">
                  {tp('memories.items', m.itemCount)} ·{' '}
                  {m.mine ? (m.visibility === 'private' ? t('memories.private') : t('memories.shared')) : t('memories.sharedWithYou')}
                </span>
              </Link>
            ))}
          </div>
        ) : (
          <EmptyState title={t('memories.emptyTitle')} body={t('memories.emptyBody')} />
        )}
      </section>
      <Badge tone="neutral">{t('memories.earlyAccess')}</Badge>
    </div>
  );
}
