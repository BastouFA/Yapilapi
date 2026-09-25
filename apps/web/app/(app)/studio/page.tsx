'use client';

import { useEffect, useState } from 'react';
import { EmptyState, List, ListItem, Skeleton, Stat } from '@yapilapi/design-system';
import { formatMoney, formatRelativeTime } from '@yapilapi/shared';
import { api } from '@/lib/api';
import { useSession } from '../../providers';

/** Creator Studio: how your content performs over the last 28 days, and what you've earned. */
export default function Studio() {
  const { locale } = useSession();
  const [data, setData] = useState<Awaited<ReturnType<typeof api.creator.analytics>> | null>(null);
  const [earnings, setEarnings] = useState<{ currency: string; grossCents: number; feeCents: number; availableCents: number }[]>([]);
  useEffect(() => {
    api.creator.analytics().then(setData);
    api.raw
      .get<{ balances: typeof earnings }>('/v1/me/earnings')
      .then((r) => setEarnings(r.balances))
      .catch(() => {});
  }, []);
  if (!data) return <Skeleton height={240} />;
  const growth = data.followerGrowth.map((d) => Number(d.new_followers));
  const max = Math.max(1, ...growth);
  const w = 560;
  const h = 120;
  const pts = growth.map((v, i) => `${(i / Math.max(1, growth.length - 1)) * w},${h - (v / max) * (h - 12) - 6}`).join(' ');

  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>Studio</h1>
        <span className="muted">Last 28 days</span>
      </div>
      <div className="stats">
        <Stat label="Posts" value={data.totals.posts} />
        <Stat label="Likes" value={data.totals.likes} />
        <Stat label="Comments" value={data.totals.comments} />
        <Stat label="Saves" value={data.totals.saves} />
        <Stat label="Followers" value={data.totals.followers} delta={`+${growth.reduce((a, b) => a + b, 0)} this period`} />
      </div>
      <section className="stack-sm">
        <h2 className="section-title">New followers per day</h2>
        <div className="yp-card" style={{ padding: 16, overflowX: 'auto' }}>
          <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} role="img" aria-label={`New followers per day, peak ${max}`}>
            <line x1="0" x2={w} y1={h - 6} y2={h - 6} stroke="var(--line)" />
            <polyline points={`0,${h - 6} ${pts} ${w},${h - 6}`} fill="var(--yapi-soft)" stroke="none" />
            <polyline points={pts} fill="none" stroke="var(--yapi)" strokeWidth="2" />
          </svg>
        </div>
      </section>
      {earnings.length ? (
        <section className="stack-sm">
          <h2 className="section-title">Earnings</h2>
          <div className="stats">
            {earnings.map((e) => (
              <Stat
                key={e.currency}
                label={`Available (${e.currency})`}
                value={formatMoney(e.availableCents, e.currency, locale)}
                delta={`${formatMoney(e.grossCents, e.currency, locale)} gross, ${formatMoney(e.feeCents, e.currency, locale)} fees`}
              />
            ))}
          </div>
        </section>
      ) : null}
      <section className="stack-sm">
        <h2 className="section-title">Top posts</h2>
        {data.topPosts.length ? (
          <List>
            {data.topPosts.map((p) => (
              <ListItem
                key={p.id}
                primary={p.excerpt || `(${p.kind})`}
                secondary={formatRelativeTime(p.created_at, locale)}
                end={`${p.like_count} likes · ${p.comment_count} comments`}
              />
            ))}
          </List>
        ) : (
          <EmptyState title="No posts yet" body="Publish something from Create to see how it does." />
        )}
      </section>
    </div>
  );
}
