'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Icon, Skeleton } from '@yapilapi/design-system';
import type { TrendingTag } from '@yapilapi/api-client';
import { api } from '@/lib/api';
import { useSession } from '@/app/providers';

/** Tags the most different people used this week, with the ones picking up today marked. */
export function TrendingTags({ limit = 8 }: { limit?: number }) {
  const { locale } = useSession();
  const [items, setItems] = useState<TrendingTag[] | null>(null);
  useEffect(() => {
    api.trending(limit).then(
      (r) => setItems(r.items),
      () => setItems([]),
    );
  }, [limit]);
  const n = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 });

  if (items === null) return <Skeleton height={120} />;
  if (!items.length) return <p className="muted">No tags are trending yet. Add a #tag to your next post to start one.</p>;
  return (
    <ol className="trending">
      {items.map((it, i) => (
        <li key={it.tag}>
          <Link href={`/t/${encodeURIComponent(it.tag)}`} className="trending__item">
            <span className="trending__rank" aria-hidden>
              {i + 1}
            </span>
            <span className="trending__text">
              <bdi className="trending__tag">#{it.tag}</bdi>
              <span className="trending__meta">
                {n.format(it.posts)} {it.posts === 1 ? 'post' : 'posts'} · {n.format(it.people)} {it.people === 1 ? 'person' : 'people'}
              </span>
            </span>
            {it.rising ? (
              <span className="trending__rising">
                <Icon name="sparkle" size={14} />
                Rising
              </span>
            ) : null}
          </Link>
        </li>
      ))}
    </ol>
  );
}
