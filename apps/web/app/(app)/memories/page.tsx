'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Badge, Button, EmptyState, EventCard, PostCard, Skeleton, TextField } from '@yapilapi/design-system';
import type { MemorySummary } from '@yapilapi/api-client';
import type { EventItem, Post } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { NextLink } from '@/lib/link';
import { useSession } from '../../providers';

export default function Memories() {
  const { toast, locale, flags } = useSession();
  const router = useRouter();
  const [items, setItems] = useState<MemorySummary[] | null>(null);
  const [sugg, setSugg] = useState<{ events: EventItem[]; onThisDay: Post[] } | null>(null);
  const [title, setTitle] = useState('');

  useEffect(() => {
    if (flags.MEMORY === false) return;
    api.memories.list().then(
      (r) => setItems(r.items),
      (e) => (setItems([]), toast(errorMessage(e))),
    );
    api.memories
      .suggestions()
      .then(setSugg)
      .catch(() => {});
  }, [flags.MEMORY, toast]);

  if (flags.MEMORY === false) return <EmptyState title="Memory isn't available yet" body="It's being rolled out gradually." />;

  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>Memories</h1>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        Private unless you share them with friends. Only you can add to your memories.
      </p>
      <form
        className="row"
        onSubmit={async (e) => {
          e.preventDefault();
          const { memory } = await api.memories.create({ title });
          router.push(`/memories/${memory.id}`);
        }}
      >
        <TextField label="New memory" placeholder="Summer in Lisbon" value={title} onChange={(e) => setTitle(e.currentTarget.value)} maxLength={120} />
        <Button type="submit" disabled={!title.trim()} style={{ alignSelf: 'flex-end' }}>
          Create
        </Button>
      </form>

      {sugg?.events.length ? (
        <section className="stack-sm">
          <h2 className="section-title">From events you went to</h2>
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
                Make a memory
              </Button>
            </div>
          ))}
        </section>
      ) : null}

      {sugg?.onThisDay.length ? (
        <section className="stack-sm">
          <h2 className="section-title">On this day</h2>
          {sugg.onThisDay.map((p) => (
            <PostCard key={p.id} post={p} locale={locale} linkAs={NextLink} />
          ))}
        </section>
      ) : null}

      <section className="stack-sm">
        <h2 className="section-title">Your memories</h2>
        {items === null ? (
          <Skeleton height={120} />
        ) : items.length ? (
          <div className="yp-grid">
            {items.map((m) => (
              <Link key={m.id} href={`/memories/${m.id}`} className="yp-ccard">
                <h3 className="yp-ccard__title">{m.title}</h3>
                {m.recap ? <p className="yp-ccard__desc">{m.recap}</p> : null}
                <span className="yp-ccard__meta">
                  {m.itemCount} items · {m.mine ? (m.visibility === 'private' ? 'Private' : 'Shared') : 'Shared with you'}
                </span>
              </Link>
            ))}
          </div>
        ) : (
          <EmptyState title="No memories yet" body="Create one, or turn an event you went to into a memory." />
        )}
      </section>
      <Badge tone="neutral">Memory is in early access</Badge>
    </div>
  );
}
