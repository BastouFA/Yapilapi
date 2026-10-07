'use client';

import { useId, useState } from 'react';
import { Card, Stat } from '@yapilapi/design-system';
import type { AdminSeries, AdminSeriesMetric } from '@yapilapi/api-client';
import type { AdminPeriod, MessageKey } from '@yapilapi/shared';
import { api } from '@/lib/api';
import { useSession } from '@/app/providers';
import { formatCount, LoadFailed, Loading, PeriodChoice, useLoad } from './shared';

const METRICS: { id: AdminSeriesMetric; label: MessageKey }[] = [
  { id: 'active', label: 'admin.trend.active' },
  { id: 'signups', label: 'admin.trend.signups' },
  { id: 'posts', label: 'admin.trend.posts' },
  { id: 'reels', label: 'admin.trend.reels' },
  { id: 'comments', label: 'admin.trend.comments' },
  { id: 'messages', label: 'admin.trend.messages' },
  { id: 'reports', label: 'admin.trend.reports' },
  { id: 'paidOrders', label: 'admin.trend.paidOrders' },
];

/** The day as a short date in the reader's language (the series' days are UTC). */
const shortDay = (day: string, locale: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** The headline numbers, then trends per day over 7, 30 or 90 days, then what people did, then AI usage. */
export function Overview() {
  const { t } = useSession();
  const [days, setDays] = useState<AdminPeriod>(30);
  const summary = useLoad(() => api.admin.summary(), []);
  const series = useLoad(() => api.admin.series(days), [days]);
  return (
    <div className="stack">
      {summary.error ? (
        <LoadFailed error={summary.error} onRetry={summary.reload} />
      ) : !summary.data ? (
        <Loading />
      ) : (
        <>
          <p className="muted">{t('admin.overview.northStar')}</p>
          <div className="stats">
            <Stat label={t('admin.overview.actions24h')} value={summary.data.summary.meaningful_actions_24h} />
            <Stat label={t('admin.overview.dau')} value={summary.data.summary.dau} />
            <Stat label={t('admin.overview.users')} value={summary.data.summary.users} />
            <Stat label={t('admin.overview.signups7d')} value={summary.data.summary.signups_7d} />
            <Stat label={t('admin.overview.openCases')} value={summary.data.summary.open_cases} />
            <Stat label={t('admin.overview.paidOrders7d')} value={summary.data.summary.paid_orders_7d} />
          </div>
        </>
      )}
      <Card title={t('admin.trend.title')} subtitle={t('admin.trend.subtitle')}>
        <div className="stack">
          <PeriodChoice value={days} onChange={setDays} />
          {series.error ? <LoadFailed error={series.error} onRetry={series.reload} /> : !series.data ? <Loading /> : <Trends data={series.data} />}
        </div>
      </Card>
      {summary.data ? (
        <div className="table-wrap" tabIndex={0} role="region" aria-label={t('admin.overview.action7d')}>
          <table className="table">
            <thead>
              <tr>
                <th>{t('admin.overview.action7d')}</th>
                <th>{t('admin.overview.count')}</th>
              </tr>
            </thead>
            <tbody>
              {summary.data.meaningfulByAction.map((r) => (
                <tr key={r.name}>
                  <td>{r.name.replace(/_/g, ' ')}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <AiUsage />
    </div>
  );
}

function Trends({ data }: { data: AdminSeries }) {
  const { t, locale } = useSession();
  return (
    <div className="stack">
      <div className="stats admin-trends">
        {METRICS.map((m) => (
          <Stat key={m.id} label={t(m.label)} value={formatCount(data.totals[m.id], locale)} delta={changeText(data.change[m.id], t)} />
        ))}
      </div>
      <div className="admin-charts">
        {METRICS.map((m) => (
          <BarChart key={m.id} title={t(m.label)} days={data.series.map((d) => ({ day: d.day, value: d[m.id] }))} />
        ))}
      </div>
    </div>
  );
}

/** "+12% from the previous period", "No change", or nothing to compare with. */
function changeText(change: number | null, t: ReturnType<typeof useSession>['t']): string {
  if (change === null) return t('admin.trend.noBefore');
  if (change === 0) return t('admin.trend.same');
  return t(change > 0 ? 'admin.trend.up' : 'admin.trend.down', { percent: Math.abs(change) });
}

/**
 * One count per day as bars (one series, one color), with the same numbers in a table for screen
 * readers. Hovering or focusing a day shows its count.
 */
function BarChart({ title, days }: { title: string; days: { day: string; value: number }[] }) {
  const { t, locale } = useSession();
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const highest = Math.max(0, ...days.map((d) => d.value));
  const max = Math.max(1, highest);
  const W = 10;
  const H = 100;
  const gap = days.length > 40 ? 1 : 2;
  const shown = hover === null ? null : days[hover];
  return (
    <figure className="admin-chart" aria-labelledby={`${id}-t`}>
      <figcaption id={`${id}-t`} className="admin-chart__title">
        <span>{title}</span>
        <span className="muted" aria-live="polite">
          {shown
            ? t('admin.trend.onDay', { day: shortDay(shown.day, locale), count: formatCount(shown.value, locale) })
            : t('admin.trend.max', { count: formatCount(highest, locale) })}
        </span>
      </figcaption>
      <svg
        viewBox={`0 0 ${days.length * W} ${H}`}
        preserveAspectRatio="none"
        className="admin-chart__plot"
        aria-hidden="true"
        onMouseLeave={() => setHover(null)}
      >
        <line x1={0} x2={days.length * W} y1={H - 0.5} y2={H - 0.5} className="admin-chart__base" />
        {days.map((d, i) => {
          const h = d.value ? Math.max(2, (d.value / max) * (H - 4)) : 0;
          return (
            <g key={d.day} onMouseEnter={() => setHover(i)}>
              {/* The whole column is the hover target, not just the bar. */}
              <rect x={i * W} y={0} width={W} height={H} fill="transparent" />
              <rect
                x={i * W + gap / 2}
                y={H - h}
                width={W - gap}
                height={h}
                rx={1.5}
                className={hover === i ? 'admin-chart__bar admin-chart__bar--on' : 'admin-chart__bar'}
              />
            </g>
          );
        })}
      </svg>
      <div className="admin-chart__axis muted" aria-hidden="true">
        <span>{shortDay(days[0]!.day, locale)}</span>
        <span>{shortDay(days[days.length - 1]!.day, locale)}</span>
      </div>
      <table className="yp-visually-hidden">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">{t('admin.trend.day')}</th>
            <th scope="col">{t('admin.overview.count')}</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.day}>
              <th scope="row">{shortDay(d.day, locale)}</th>
              <td>{d.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/** AI calls over the last 7 days: what for, which provider and model, how they went, and how long they took. */
function AiUsage() {
  const { t, locale } = useSession();
  const { data, error, reload } = useLoad(() => api.admin.aiCalls(), []);
  return (
    <Card title={t('admin.ai.title')} subtitle={t('admin.ai.subtitle')}>
      {error ? (
        <LoadFailed error={error} onRetry={reload} />
      ) : !data ? (
        <Loading />
      ) : !data.items.length ? (
        <p className="muted">{t('admin.ai.none')}</p>
      ) : (
        <div className="table-wrap" tabIndex={0} role="region" aria-label={t('admin.ai.title')}>
          <table className="table">
            <thead>
              <tr>
                <th>{t('admin.ai.task')}</th>
                <th>{t('admin.ai.provider')}</th>
                <th>{t('admin.ai.status')}</th>
                <th>{t('admin.overview.count')}</th>
                <th>{t('admin.ai.avg')}</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((r) => (
                <tr key={`${r.task}-${r.provider}-${r.model}-${r.status}`}>
                  <td>{r.task.replace(/_/g, ' ')}</td>
                  <td>
                    {r.provider} <span className="muted">{r.model}</span>
                  </td>
                  <td>{r.status}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{formatCount(Number(r.n), locale)}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.avg_ms === null ? '' : t('admin.ai.ms', { ms: formatCount(r.avg_ms, locale) })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
