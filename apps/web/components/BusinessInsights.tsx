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
  const { locale, t, tp } = useSession();
  const [days, setDays] = useState<'7' | '30' | '90'>('30');
  const [data, setData] = useState<BusinessAnalytics | null>(null);
  useEffect(() => {
    let current = true;
    setData(null);
    // A slow response for a period you've switched away from is dropped.
    api.businesses.analytics(businessId, Number(days)).then(
      (d) => current && setData(d),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [businessId, days]);

  const bookings = data ? Object.values(data.bookingsByStatus).reduce((a, b) => a + b.bookings, 0) : 0;
  const confirmed = data?.bookingsByStatus.confirmed?.bookings ?? 0;
  const visitors = data?.visitorsTotal ?? 0;
  const maxVisitors = Math.max(1, ...(data?.views.map((d) => d.visitors) ?? []));

  return (
    <Card title={t('m.insights.title')} subtitle={t('bizInsights.subtitle')}>
      <div className="stack">
        <Segments
          label={t('bizInsights.period')}
          value={days}
          onChange={setDays}
          options={[
            { id: '7', label: tp('m.boost.days', 7) },
            { id: '30', label: tp('m.boost.days', 30) },
            { id: '90', label: tp('m.boost.days', 90) },
          ]}
        />
        {!data ? (
          <Skeleton height={160} />
        ) : (
          <>
            <div className="stats">
              <Stat label={t('bizInsights.visitors')} value={visitors} />
              <Stat label={t('m.booking.requests')} value={bookings} delta={bookings ? tp('bizInsights.confirmed', confirmed) : undefined} />
              <Stat label={t('bizInsights.upcoming')} value={data.upcomingBookings} />
              <Stat label={t('bizInsights.rating')} value={data.reviews.average ?? '–'} delta={tp('m.place.reviewCount', data.reviews.count)} />
              {data.ads.impressions ? (
                <Stat label={t('bizInsights.adViews')} value={data.ads.impressions} delta={tp('bizInsights.clicks', data.ads.clicks)} />
              ) : null}
            </div>
            {data.views.length ? (
              <div className="usage" aria-label={t('bizInsights.visitorsPerDay')}>
                {data.views.slice(-30).map((d) => (
                  <div key={d.day} className="usage__day" title={tp('bizInsights.dayVisitors', d.visitors)}>
                    <span className="usage__bar" style={{ height: `${Math.max(4, (d.visitors / maxVisitors) * 64)}px` }} />
                    <span className="usage__label">{new Date(d.day).getDate()}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted" style={{ margin: 0 }}>
                {t('bizInsights.noVisits')}
              </p>
            )}
            {data.topProducts.length ? (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('shop.kind.product')}</th>
                      <th>{t('m.drops.stats.sold')}</th>
                      <th>{t('bizInsights.revenue')}</th>
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
