'use client';

import { useEffect, useState } from 'react';
import { Card, Segments, Skeleton, Stat } from '@yapilapi/design-system';
import type { BusinessAnalytics } from '@yapilapi/api-client';
import { formatMoney } from '@yapilapi/shared';
import { api } from '@/lib/api';
import { useSession } from '@/app/providers';
import { AgentPanel } from './AgentPanel';

/** Owner-only: visits, bookings, reviews, sales and ads, with the business assistant underneath. */
export function BusinessInsights({ businessId }: { businessId: string }) {
  const { locale } = useSession();
  const [days, setDays] = useState<'7' | '30' | '90'>('30');
  const [data, setData] = useState<BusinessAnalytics | null>(null);
  useEffect(() => {
    setData(null);
    api.businesses.analytics(businessId, Number(days)).then(setData, () => {});
  }, [businessId, days]);

  const bookings = data ? Object.values(data.bookingsByStatus).reduce((a, b) => a + b.bookings, 0) : 0;
  const confirmed = data?.bookingsByStatus.confirmed?.bookings ?? 0;
  const visitors = data ? data.views.reduce((a, d) => a + d.visitors, 0) : 0;
  const maxVisitors = Math.max(1, ...(data?.views.map((d) => d.visitors) ?? []));

  return (
    <Card title="Insights" subtitle="Only you can see this. Visits count signed-in people once a day, not you.">
      <div className="stack">
        <Segments
          label="Period"
          value={days}
          onChange={setDays}
          options={[
            { id: '7', label: '7 days' },
            { id: '30', label: '30 days' },
            { id: '90', label: '90 days' },
          ]}
        />
        {!data ? (
          <Skeleton height={160} />
        ) : (
          <>
            <div className="stats">
              <Stat label="Visitors" value={visitors} />
              <Stat label="Booking requests" value={bookings} delta={bookings ? `${confirmed} confirmed` : undefined} />
              <Stat label="Upcoming bookings" value={data.upcomingBookings} />
              <Stat label="Rating" value={data.reviews.average ?? '–'} delta={`${data.reviews.count} review${data.reviews.count === 1 ? '' : 's'}`} />
              {data.ads.impressions ? <Stat label="Ad views" value={data.ads.impressions} delta={`${data.ads.clicks} clicks`} /> : null}
            </div>
            {data.views.length ? (
              <div className="usage" aria-label="Visitors per day">
                {data.views.slice(-30).map((d) => (
                  <div key={d.day} className="usage__day" title={`${d.visitors} visitors`}>
                    <span className="usage__bar" style={{ height: `${Math.max(4, (d.visitors / maxVisitors) * 64)}px` }} />
                    <span className="usage__label">{new Date(d.day).getDate()}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted" style={{ margin: 0 }}>
                No visits recorded in this period.
              </p>
            )}
            {data.topProducts.length ? (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th>Sold</th>
                      <th>Revenue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topProducts.map((p) => (
                      <tr key={`${p.title}${p.currency}`}>
                        <td>{p.title}</td>
                        <td>{p.units}</td>
                        <td>{formatMoney(p.revenue_cents, p.currency, locale)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </>
        )}
        <AgentPanel kind="business" businessId={businessId} compact />
      </div>
    </Card>
  );
}
