'use client';

import { useState, type ReactNode } from 'react';
import { FormField, Select } from '@yapilapi/ui';
import {
  isUnavailable,
  type AcquisitionReport,
  type CommerceReport,
  type CreatorsReport,
  type EngagementReport,
  type MsaReport,
  type RetentionReport,
  type SafetyReport,
  type TechnicalReport,
  type Unavailable,
} from '@yapilapi/api-client';
import { useI18n } from '@/i18n';
import { useAdminApi } from '@/lib/api';
import { useResource } from '@/lib/hooks';
import { HBarChart, Kpi, LineChart, RetentionHeatmap, StackedBarChart } from '@/components/charts';
import { DataTable } from '@/components/DataTable';
import { Filters, PageHeader, ResourceView, Section, SubNav } from '@/components/common';

export const ANALYTICS_TABS = [
  'msa',
  'acquisition',
  'engagement',
  'retention',
  'commerce',
  'creators',
  'safety',
  'technical',
] as const;
export type AnalyticsTab = (typeof ANALYTICS_TABS)[number];
export const isAnalyticsTab = (v: string): v is AnalyticsTab =>
  (ANALYTICS_TABS as readonly string[]).includes(v);

/** Sum of the non-suppressed cells (suppressed cells are unknown, never zero). */
export function sumCells(cells: Array<number | null>): number {
  return cells.reduce<number>((a, c) => a + (c ?? 0), 0);
}

/** Group rows by a key and add their (possibly suppressed) counts; a group made only of suppressed cells stays suppressed. */
export function groupCells<R>(
  rows: R[],
  key: (r: R) => string,
  value: (r: R) => number | null,
): Array<{ key: string; value: number | null }> {
  const m = new Map<string, number | null>();
  for (const r of rows) {
    const k = key(r);
    const v = value(r);
    const prev = m.get(k);
    m.set(k, v === null ? (prev === undefined ? null : prev) : (prev ?? 0) + v);
  }
  return [...m.entries()].map(([k, v]) => ({ key: k, value: v }));
}

function PeriodPicker({
  value,
  onChange,
  unit,
}: {
  value: number;
  onChange: (n: number) => void;
  unit: 'days' | 'weeks';
}) {
  const { t } = useI18n();
  const options = unit === 'days' ? [7, 30, 90] : [4, 8, 12];
  return (
    <Filters label={t('common.filters')}>
      <FormField label={t('payments.period')}>
        <Select value={String(value)} onChange={(e) => onChange(Number(e.target.value))}>
          {options.map((d) => (
            <option key={d} value={d}>
              {unit === 'days'
                ? t('common.lastDays', { count: d })
                : t('analytics.lastWeeks', { count: d })}
            </option>
          ))}
        </Select>
      </FormField>
    </Filters>
  );
}

/** Wraps one report: loading/error, and the API's own "this section is unavailable" degradation. */
function Report<R>({
  load,
  deps,
  unit,
  initial,
  children,
}: {
  load: (n: number, signal: AbortSignal) => Promise<R | Unavailable>;
  deps: unknown[];
  unit: 'days' | 'weeks';
  initial: number;
  children: (r: R) => ReactNode;
}) {
  const { t } = useI18n();
  const [n, setN] = useState(initial);
  const res = useResource((signal) => load(n, signal), [...deps, n]);
  return (
    <div className="stack">
      <PeriodPicker value={n} onChange={setN} unit={unit} />
      <ResourceView resource={res}>
        {(r) =>
          isUnavailable(r) ? (
            <p className="muted" role="status">
              {t('analytics.unavailable')}
            </p>
          ) : (
            <>{children(r as R)}</>
          )
        }
      </ResourceView>
      <p className="muted">{t('analytics.privacyNote')}</p>
    </div>
  );
}

const cell = (n: number | null, fmt: { number: (n: number) => string }, suppressed: string) =>
  n === null ? suppressed : fmt.number(n);

function Msa() {
  const { t, label, fmt } = useI18n();
  const api = useAdminApi();
  return (
    <Report<MsaReport>
      load={(n, signal) => api.analytics.msa(n, { signal })}
      deps={[api]}
      unit="weeks"
      initial={4}
    >
      {(m) => {
        const windows = [...m.windows].sort((a, b) => a.windowStart.localeCompare(b.windowStart));
        const types = Object.keys(m.definition.dailyCapPerUserPerType);
        return (
          <>
            <Section title={t('analytics.msa.def.title')} description={t('analytics.msa.def.desc')}>
              <div className="stack-sm">
                <p>{m.definition.msa}</p>
                <p>
                  <strong>{t('analytics.msa.def.mwp')}</strong>{' '}
                  {m.definition.meaningfulWeeklyParticipant}
                </p>
                <details>
                  <summary>{t('analytics.msa.def.notMsa')}</summary>
                  <ul>
                    {m.definition.notMsa.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                </details>
                <p className="muted">
                  {t('analytics.msa.def.caps', {
                    caps: types
                      .map(
                        (k) => `${label('msaType', k)} ${m.definition.dailyCapPerUserPerType[k]}`,
                      )
                      .join(', '),
                  })}
                </p>
                <p className="muted">{t('analytics.minCell', { min: m.minCell })}</p>
              </div>
            </Section>
            <Section title={t('analytics.msa.trend.title')}>
              <div className="stack">
                <LineChart
                  title={t('analytics.msa.mwpChart')}
                  summary={t('analytics.msa.mwpSummary', { count: windows.length })}
                  valueHeader={t('analytics.msa.mwp')}
                  xHeader={t('analytics.msa.windowEnd')}
                  points={windows.map((w) => ({ x: w.windowEnd, y: w.mwp }))}
                />
                <StackedBarChart
                  title={t('analytics.msa.byType')}
                  summary={t('analytics.msa.byTypeSummary', { count: windows.length })}
                  groups={windows.map((w) => ({
                    label: w.windowEnd,
                    values: types.map((k) => w.actionsByType[k] ?? null),
                  }))}
                  series={types.slice(0, 4).map((k, i) => ({
                    label: label('msaType', k),
                    slot: (i + 1) as 1 | 2 | 3 | 4,
                  }))}
                />
                <DataTable
                  caption={t('analytics.msa.windows')}
                  rows={windows}
                  rowKey={(w) => w.windowEnd}
                  columns={[
                    {
                      id: 'w',
                      header: t('analytics.msa.window'),
                      rowHeader: true,
                      cell: (w) => `${w.windowStart} → ${w.windowEnd}`,
                    },
                    {
                      id: 'p',
                      header: t('analytics.msa.participants'),
                      numeric: true,
                      cell: (w) => cell(w.participants, fmt, t('chart.suppressed')),
                    },
                    {
                      id: 'm',
                      header: t('analytics.msa.mwp'),
                      numeric: true,
                      cell: (w) => cell(w.mwp, fmt, t('chart.suppressed')),
                    },
                    {
                      id: 's',
                      header: t('analytics.msa.share'),
                      numeric: true,
                      cell: (w) =>
                        w.mwpShare === null ? t('chart.suppressed') : fmt.percent(w.mwpShare),
                    },
                  ]}
                />
              </div>
            </Section>
          </>
        );
      }}
    </Report>
  );
}

function Acquisition() {
  const { t, fmt } = useI18n();
  const api = useAdminApi();
  return (
    <Report<AcquisitionReport>
      load={(n, signal) => api.analytics.acquisition(n, { signal })}
      deps={[api]}
      unit="days"
      initial={30}
    >
      {(a) => (
        <>
          <Section title={t('analytics.acq.title')}>
            <div className="stack">
              <div className="grid-kpi">
                <Kpi
                  label={t('analytics.acq.signups')}
                  value={cell(a.onboarding.signups, fmt, t('chart.suppressed'))}
                />
                <Kpi
                  label={t('analytics.acq.onboarded')}
                  value={cell(a.onboarding.onboarded, fmt, t('chart.suppressed'))}
                />
                <Kpi
                  label={t('analytics.acq.completion')}
                  value={
                    a.onboarding.completionRate === null
                      ? t('chart.suppressed')
                      : fmt.percent(a.onboarding.completionRate)
                  }
                />
              </div>
              <LineChart
                title={t('analytics.acq.perDay')}
                summary={t('analytics.acq.perDaySummary', {
                  total: sumCells(a.signupsPerDay.map((d) => d.signups)),
                })}
                valueHeader={t('analytics.acq.signups')}
                xHeader={t('analytics.day')}
                points={a.signupsPerDay.map((d) => ({ x: d.day, y: d.signups }))}
              />
            </div>
          </Section>
          <Section title={t('analytics.acq.funnel')} description={a.onboardingFunnel.basis}>
            <HBarChart
              title={t('analytics.acq.funnel')}
              summary={t('analytics.acq.funnelSummary', { count: a.onboardingFunnel.steps.length })}
              valueHeader={t('analytics.people')}
              data={a.onboardingFunnel.steps.map((s) => ({
                label: [s.step, s.action].filter(Boolean).join(' · ') || t('common.unknown'),
                value: s.people,
              }))}
            />
          </Section>
          <Section title={t('analytics.acq.referrers')} description={a.referrers.basis}>
            <HBarChart
              title={t('analytics.acq.referrers')}
              summary={t('analytics.acq.referrersSummary', { count: a.referrers.rows.length })}
              valueHeader={t('analytics.opens')}
              data={a.referrers.rows.map((r) => ({
                label: r.referrer ?? t('analytics.direct'),
                value: r.opens,
              }))}
            />
          </Section>
        </>
      )}
    </Report>
  );
}

function Engagement() {
  const { t, fmt } = useI18n();
  const api = useAdminApi();
  return (
    <Report<EngagementReport>
      load={(n, signal) => api.analytics.engagement(n, { signal })}
      deps={[api]}
      unit="days"
      initial={30}
    >
      {(e) => (
        <Section title={t('analytics.eng.title')} description={e.definition}>
          <div className="stack">
            <div className="grid-kpi">
              <Kpi
                label={t('dashboard.metrics.dau')}
                value={cell(e.current.dau, fmt, t('chart.suppressed'))}
              />
              <Kpi
                label={t('dashboard.metrics.wau')}
                value={cell(e.current.wau, fmt, t('chart.suppressed'))}
              />
              <Kpi
                label={t('dashboard.metrics.mau')}
                value={cell(e.current.mau, fmt, t('chart.suppressed'))}
              />
              <Kpi
                label={t('dashboard.metrics.stickiness')}
                value={
                  e.current.stickiness === null
                    ? t('chart.suppressed')
                    : fmt.percent(e.current.stickiness)
                }
              />
            </div>
            <LineChart
              title={t('analytics.eng.dauChart')}
              summary={t('analytics.eng.dauSummary', { count: e.dauPerDay.length })}
              valueHeader={t('dashboard.metrics.dau')}
              xHeader={t('analytics.day')}
              points={e.dauPerDay.map((d) => ({ x: d.day, y: d.dau }))}
            />
          </div>
        </Section>
      )}
    </Report>
  );
}

function Retention() {
  const { t } = useI18n();
  const api = useAdminApi();
  return (
    <Report<RetentionReport>
      load={(n, signal) => api.analytics.retention(n, { signal })}
      deps={[api]}
      unit="weeks"
      initial={8}
    >
      {(r) => {
        const weeks = Math.max(0, ...r.cohorts.flatMap((c) => c.weeks.map((w) => w.week)));
        return (
          <Section title={t('analytics.ret.title')} description={r.definition}>
            <RetentionHeatmap
              title={t('analytics.ret.chart')}
              summary={t('analytics.ret.summary', { count: r.cohorts.length })}
              cohortHeader={t('analytics.ret.cohort')}
              weeks={weeks}
              cohorts={r.cohorts.map((c) => ({
                label: c.cohortWeek,
                size: c.size,
                cells: c.weeks.reduce<Array<number | null | undefined>>((a, w) => {
                  a[w.week] = w.rate;
                  return a;
                }, []),
              }))}
            />
          </Section>
        );
      }}
    </Report>
  );
}

const money = (v: number | string | null | undefined) =>
  v === null || v === undefined ? null : Number(v);

function Commerce() {
  const { t, label, fmt } = useI18n();
  const api = useAdminApi();
  return (
    <Report<CommerceReport>
      load={(n, signal) => api.analytics.commerce(n, { signal })}
      deps={[api]}
      unit="days"
      initial={30}
    >
      {(c) => (
        <Section title={t('analytics.com.title')}>
          <div className="stack">
            <HBarChart
              title={t('analytics.com.byStatus')}
              summary={t('analytics.com.byStatusSummary', {
                total: sumCells(c.ordersByStatus.map((o) => o.orders)),
              })}
              valueHeader={t('analytics.orders')}
              data={c.ordersByStatus.map((o) => ({
                label: label('payStatus', o.status),
                value: o.orders,
              }))}
            />
            <DataTable
              caption={t('analytics.com.paid')}
              rows={c.paidOrders}
              rowKey={(r) => r.currency}
              columns={[
                {
                  id: 'c',
                  header: t('payments.col.currency'),
                  rowHeader: true,
                  cell: (r) => r.currency,
                },
                {
                  id: 'o',
                  header: t('analytics.orders'),
                  numeric: true,
                  cell: (r) => cell(r.orders, fmt, t('chart.suppressed')),
                },
                {
                  id: 't',
                  header: t('payments.col.amount'),
                  numeric: true,
                  cell: (r) =>
                    money(r.total_cents) === null || r.orders === null
                      ? t('chart.suppressed')
                      : fmt.money(money(r.total_cents) ?? 0, r.currency),
                },
              ]}
            />
          </div>
        </Section>
      )}
    </Report>
  );
}

function Creators() {
  const { t, label, fmt } = useI18n();
  const api = useAdminApi();
  return (
    <Report<CreatorsReport>
      load={(n, signal) => api.analytics.creators(n, { signal })}
      deps={[api]}
      unit="days"
      initial={30}
    >
      {(c) => (
        <Section title={t('analytics.cre.title')}>
          <div className="stack">
            <DataTable
              caption={t('analytics.cre.byStatus')}
              rows={c.creatorsByStatus}
              rowKey={(r) => `${r.status}-${r.kyc_status}`}
              columns={[
                {
                  id: 's',
                  header: t('payments.col.status'),
                  rowHeader: true,
                  cell: (r) => label('status', r.status),
                },
                { id: 'k', header: t('creators.col.kyc'), cell: (r) => label('kyc', r.kyc_status) },
                {
                  id: 'n',
                  header: t('analytics.cre.creators'),
                  numeric: true,
                  cell: (r) => cell(r.creators, fmt, t('chart.suppressed')),
                },
              ]}
            />
            <HBarChart
              title={t('analytics.cre.subs')}
              summary={t('analytics.cre.subsSummary', {
                total: sumCells(c.subscriptionsByStatus.map((s) => s.subscriptions)),
              })}
              valueHeader={t('analytics.cre.subsCol')}
              data={c.subscriptionsByStatus.map((s) => ({
                label: label('status', s.status),
                value: s.subscriptions,
              }))}
            />
            <DataTable
              caption={t('analytics.cre.tips')}
              rows={c.tips}
              rowKey={(r) => r.currency}
              columns={[
                {
                  id: 'c',
                  header: t('payments.col.currency'),
                  rowHeader: true,
                  cell: (r) => r.currency,
                },
                {
                  id: 'n',
                  header: t('analytics.cre.tipCount'),
                  numeric: true,
                  cell: (r) => cell(r.tips, fmt, t('chart.suppressed')),
                },
                {
                  id: 'p',
                  header: t('analytics.cre.creators'),
                  numeric: true,
                  cell: (r) => cell(r.creators, fmt, t('chart.suppressed')),
                },
                {
                  id: 'a',
                  header: t('payments.col.amount'),
                  numeric: true,
                  cell: (r) =>
                    money(r.amount_cents) === null || r.tips === null
                      ? t('chart.suppressed')
                      : fmt.money(money(r.amount_cents) ?? 0, r.currency),
                },
              ]}
            />
          </div>
        </Section>
      )}
    </Report>
  );
}

function Safety() {
  const { t, label, fmt } = useI18n();
  const api = useAdminApi();
  return (
    <Report<SafetyReport>
      load={(n, signal) => api.analytics.safety(n, { signal })}
      deps={[api]}
      unit="days"
      initial={30}
    >
      {(s) => {
        const byReason = groupCells(
          s.reports,
          (r) => r.reason,
          (r) => r.reports,
        );
        return (
          <Section title={t('analytics.saf.title')}>
            <div className="stack">
              <div className="grid-kpi">
                <Kpi
                  label={t('analytics.saf.decided')}
                  value={cell(s.timeToDecision.decided, fmt, t('chart.suppressed'))}
                />
                <Kpi
                  label={t('analytics.saf.median')}
                  value={
                    s.timeToDecision.medianHours === null
                      ? t('chart.suppressed')
                      : t('analytics.saf.hours', {
                          count: Math.round(s.timeToDecision.medianHours * 10) / 10,
                        })
                  }
                />
              </div>
              <div className="grid-2">
                <HBarChart
                  title={t('analytics.saf.reports')}
                  summary={t('analytics.saf.reportsSummary', {
                    total: sumCells(byReason.map((r) => r.value)),
                  })}
                  valueHeader={t('analytics.saf.reportsCol')}
                  data={byReason
                    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
                    .map((r) => ({ label: label('reportReason', r.key), value: r.value }))}
                />
                <HBarChart
                  title={t('analytics.saf.enforcements')}
                  summary={t('analytics.saf.enforcementsSummary', {
                    total: sumCells(s.enforcements.map((e) => e.enforcements)),
                  })}
                  valueHeader={t('analytics.saf.enforcementsCol')}
                  data={s.enforcements.map((e) => ({
                    label: label('enforcement', e.kind),
                    value: e.enforcements,
                  }))}
                />
              </div>
              <DataTable
                caption={t('analytics.saf.cases')}
                rows={s.cases}
                rowKey={(r) => `${r.source}-${r.state}`}
                columns={[
                  {
                    id: 's',
                    header: t('mod.col.source'),
                    rowHeader: true,
                    cell: (r) => label('source', r.source),
                  },
                  {
                    id: 'st',
                    header: t('mod.col.state'),
                    cell: (r) => label('caseState', r.state),
                  },
                  {
                    id: 'n',
                    header: t('analytics.saf.casesCol'),
                    numeric: true,
                    cell: (r) => cell(r.cases, fmt, t('chart.suppressed')),
                  },
                ]}
              />
              <HBarChart
                title={t('analytics.saf.appeals')}
                summary={t('analytics.saf.appealsSummary', {
                  total: sumCells(s.appeals.map((a) => a.appeals)),
                })}
                valueHeader={t('analytics.saf.appealsCol')}
                data={s.appeals.map((a) => ({
                  label: label('appealStatus', a.status),
                  value: a.appeals,
                }))}
              />
            </div>
          </Section>
        );
      }}
    </Report>
  );
}

function Technical() {
  const { t, fmt } = useI18n();
  const api = useAdminApi();
  return (
    <Report<TechnicalReport>
      load={(n, signal) => api.analytics.technical(n, { signal })}
      deps={[api]}
      unit="days"
      initial={30}
    >
      {(x) => {
        const perDay = groupCells(
          x.eventVolume,
          (e) => e.day,
          (e) => e.events,
        ).sort((a, b) => a.key.localeCompare(b.key));
        return (
          <Section title={t('analytics.tech.title')} description={x.basis}>
            <div className="stack">
              <DataTable
                caption={t('analytics.tech.vitals')}
                rows={x.webVitalsP75}
                rowKey={(r) => `${r.metric}-${r.platform}`}
                columns={[
                  {
                    id: 'm',
                    header: t('analytics.tech.metric'),
                    rowHeader: true,
                    cell: (r) => r.metric ?? t('common.unknown'),
                  },
                  { id: 'p', header: t('analytics.tech.platform'), cell: (r) => r.platform },
                  {
                    id: 's',
                    header: t('analytics.tech.samples'),
                    numeric: true,
                    cell: (r) => cell(r.samples, fmt, t('chart.suppressed')),
                  },
                  {
                    id: 'v',
                    header: t('analytics.tech.p75'),
                    numeric: true,
                    cell: (r) =>
                      r.p75 === null
                        ? t('chart.suppressed')
                        : fmt.number(r.p75, { maximumFractionDigits: 2 }),
                  },
                ]}
              />
              <DataTable
                caption={t('analytics.tech.errors')}
                rows={x.clientErrors}
                rowKey={(r) => `${r.code}-${r.screen}`}
                columns={[
                  {
                    id: 'c',
                    header: t('analytics.tech.code'),
                    rowHeader: true,
                    cell: (r) => r.code ?? t('common.unknown'),
                  },
                  {
                    id: 's',
                    header: t('analytics.tech.screen'),
                    cell: (r) => r.screen ?? t('common.unknown'),
                  },
                  {
                    id: 'n',
                    header: t('analytics.tech.errorCount'),
                    numeric: true,
                    cell: (r) => cell(r.errors, fmt, t('chart.suppressed')),
                  },
                ]}
              />
              <LineChart
                title={t('analytics.tech.volume')}
                summary={t('analytics.tech.volumeSummary', { count: perDay.length })}
                valueHeader={t('analytics.tech.events')}
                xHeader={t('analytics.day')}
                points={perDay.map((d) => ({ x: d.key, y: d.value }))}
              />
            </div>
          </Section>
        );
      }}
    </Report>
  );
}

export function AnalyticsView({ tab }: { tab: AnalyticsTab }) {
  const { t, tx } = useI18n();
  const items = ANALYTICS_TABS.map((x) => ({
    id: x,
    href: `/analytics/${x}`,
    label: tx(`analytics.tab.${x}`),
  }));
  return (
    <>
      <PageHeader title={t('analytics.title')} lead={t('analytics.lead')} />
      <SubNav label={t('analytics.nav')} items={items} current={tab} />
      <div className="page-body">
        {tab === 'msa' ? (
          <Msa />
        ) : tab === 'acquisition' ? (
          <Acquisition />
        ) : tab === 'engagement' ? (
          <Engagement />
        ) : tab === 'retention' ? (
          <Retention />
        ) : tab === 'commerce' ? (
          <Commerce />
        ) : tab === 'creators' ? (
          <Creators />
        ) : tab === 'safety' ? (
          <Safety />
        ) : (
          <Technical />
        )}
      </div>
    </>
  );
}
