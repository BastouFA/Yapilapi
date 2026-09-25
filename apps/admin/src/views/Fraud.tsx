'use client';

import { useState } from 'react';
import Link from 'next/link';
import { FormField, Select } from '@yapilapi/ui';
import {
  isUnavailable,
  type FraudSignalRow,
  type FraudSummary,
  type Unavailable,
} from '@yapilapi/api-client';
import { useI18n } from '@/i18n';
import { useAdminApi } from '@/lib/api';
import { useResource } from '@/lib/hooks';
import { HBarChart, Kpi } from '@/components/charts';
import { DataTable } from '@/components/DataTable';
import {
  Filters,
  PageHeader,
  ResourceView,
  Section,
  ShortId,
  StatusBadge,
  Time,
} from '@/components/common';

/** A number that the API may have degraded to `{available:false}`. */
function useCount() {
  const { t, fmt } = useI18n();
  return (v: number | Unavailable) => (isUnavailable(v) ? t('common.unavailable') : fmt.number(v));
}

function Summary() {
  const { t, label } = useI18n();
  const api = useAdminApi();
  const count = useCount();
  const [days, setDays] = useState(30);
  const res = useResource((signal) => api.fraud.summary(days, { signal }), [api, days]);
  return (
    <Section title={t('fraud.summary.title')} description={t('fraud.summary.desc')}>
      <Filters label={t('common.filters')}>
        <FormField label={t('payments.period')}>
          <Select value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
            {[7, 30, 90].map((d) => (
              <option key={d} value={d}>
                {t('common.lastDays', { count: d })}
              </option>
            ))}
          </Select>
        </FormField>
      </Filters>
      <ResourceView resource={res}>
        {(s: FraudSummary) => (
          <div className="stack">
            <div className="grid-kpi">
              <Kpi
                label={t('fraud.held')}
                value={count(s.ordersHeldForReview)}
                note={t('fraud.heldNote')}
              />
              <Kpi label={t('fraud.disputed')} value={count(s.disputedPayments)} />
            </div>
            <div className="grid-2">
              {isUnavailable(s.topFlags) ? (
                <p className="muted">{t('fraud.flagsUnavailable')}</p>
              ) : (
                <HBarChart
                  title={t('fraud.flags.title')}
                  summary={t('fraud.flags.summary', { count: s.topFlags.length })}
                  valueHeader={t('payments.col.count')}
                  data={s.topFlags.map((f) => ({
                    label: label('fraudFlag', f.flag),
                    value: f.count,
                  }))}
                />
              )}
              {isUnavailable(s.scoreBands) ? (
                <p className="muted">{t('fraud.bandsUnavailable')}</p>
              ) : (
                <HBarChart
                  title={t('fraud.bands.title')}
                  summary={t('fraud.bands.summary', {
                    total: s.scoreBands.reduce((a, b) => a + b.count, 0),
                  })}
                  valueHeader={t('payments.col.count')}
                  data={s.scoreBands.map((b) => ({
                    label: label('fraudBand', b.band),
                    value: b.count,
                  }))}
                />
              )}
            </div>
            <p className="muted">
              {t('fraud.queueNote')} <Link href="/payments/orders">{t('fraud.queueLink')}</Link>
            </p>
          </div>
        )}
      </ResourceView>
    </Section>
  );
}

function Signals() {
  const { t, label } = useI18n();
  const api = useAdminApi();
  const [decision, setDecision] = useState<'' | 'allow' | 'review' | 'block'>('review');
  const res = useResource(
    (signal) => api.fraud.signals({ ...(decision ? { decision } : {}), limit: 50, signal }),
    [api, decision],
  );
  return (
    <Section title={t('fraud.signals.title')} description={t('fraud.signals.desc')}>
      <Filters label={t('common.filters')}>
        <FormField label={t('fraud.signals.decision')}>
          <Select value={decision} onChange={(e) => setDecision(e.target.value as typeof decision)}>
            <option value="">{t('common.any')}</option>
            {(['allow', 'review', 'block'] as const).map((d) => (
              <option key={d} value={d}>
                {label('fraudDecision', d)}
              </option>
            ))}
          </Select>
        </FormField>
      </Filters>
      <ResourceView
        resource={res}
        isEmpty={(d) => d.items.length === 0}
        emptyTitle={t('fraud.signals.emptyTitle')}
        emptyBody={t('fraud.signals.emptyBody')}
      >
        {(d) => (
          <DataTable<FraudSignalRow>
            caption={t('fraud.signals.title')}
            rows={d.items}
            rowKey={(r) => r.id}
            columns={[
              {
                id: 'at',
                header: t('fraud.col.when'),
                rowHeader: true,
                cell: (r) => <Time value={r.created_at} />,
              },
              {
                id: 'dec',
                header: t('fraud.signals.decision'),
                cell: (r) => <StatusBadge group="fraudDecision" value={r.decision} />,
              },
              { id: 'score', header: t('fraud.col.score'), numeric: true, cell: (r) => r.score },
              {
                id: 'stage',
                header: t('fraud.col.stage'),
                cell: (r) => label('fraudStage', r.stage),
              },
              {
                id: 'subject',
                header: t('fraud.col.subject'),
                cell: (r) => (
                  <>
                    {label('targetType', r.subject_type)} <ShortId id={r.subject_id} />
                  </>
                ),
              },
              {
                id: 'user',
                header: t('fraud.col.user'),
                cell: (r) =>
                  r.user_id ? (
                    <Link href={`/users/${r.user_id}`}>
                      <ShortId id={r.user_id} />
                    </Link>
                  ) : (
                    t('common.none')
                  ),
              },
              {
                id: 'why',
                header: t('fraud.col.reasons'),
                cell: (r) =>
                  r.reasons?.length
                    ? r.reasons.map((x) => label('fraudFlag', x)).join(', ')
                    : t('common.none'),
              },
            ]}
          />
        )}
      </ResourceView>
    </Section>
  );
}

export function FraudView() {
  const { t } = useI18n();
  return (
    <>
      <PageHeader title={t('fraud.title')} lead={t('fraud.lead')} />
      <div className="page-body">
        <Summary />
        <Signals />
      </div>
    </>
  );
}
