'use client';

import { useState } from 'react';
import Link from 'next/link';
import { FormField, Select } from '@yapilapi/ui';
import {
  CASE_STATES,
  REPORT_REASONS,
  REPORT_TARGET_TYPES,
  RISK_LEVELS,
  type CaseFilters,
  type CaseSummary,
  type CaseState,
  type RiskLevel,
} from '@yapilapi/api-client';
import { useI18n } from '@/i18n';
import { useAdminApi } from '@/lib/api';
import { usePagedList, useResource } from '@/lib/hooks';
import { useAdmin } from '@/lib/session';
import { HBarChart, Kpi } from '@/components/charts';
import { DataTable } from '@/components/DataTable';
import {
  Filters,
  ListView,
  PageHeader,
  ResourceView,
  Section,
  ShortId,
  StatusBadge,
  Time,
} from '@/components/common';
import { ModerationNav } from './moderation-shared';

function QueueStats() {
  const { t, label, fmt } = useI18n();
  const api = useAdminApi();
  const res = useResource((signal) => api.moderation.queueStats({ signal }), [api]);
  return (
    <Section title={t('mod.stats.title')} description={t('mod.stats.desc')}>
      <ResourceView resource={res}>
        {(s) => {
          const total = s.queue.reduce((a, r) => a + r.count, 0);
          const byRisk = RISK_LEVELS.map((r) => ({
            label: label('risk', r),
            value: s.queue.filter((q) => q.riskLevel === r).reduce((a, q) => a + q.count, 0),
          }));
          return (
            <div className="grid-2">
              <div className="grid-kpi">
                <Kpi label={t('mod.stats.open')} value={fmt.number(total)} />
                <Kpi label={t('mod.stats.appeals')} value={fmt.number(s.openAppeals)} />
              </div>
              <HBarChart
                title={t('mod.stats.byRisk')}
                summary={t('mod.stats.byRiskSummary', { total, critical: byRisk[0]?.value ?? 0 })}
                data={byRisk}
                valueHeader={t('mod.stats.cases')}
              />
            </div>
          );
        }}
      </ResourceView>
    </Section>
  );
}

export function ModerationQueueView() {
  const { t, label } = useI18n();
  const api = useAdminApi();
  const { atLeast } = useAdmin();
  const staff = atLeast('moderator');
  const [f, setF] = useState<{
    state: string;
    risk: string;
    targetType: string;
    source: string;
    category: string;
    assigned: string;
  }>({ state: '', risk: '', targetType: '', source: '', category: '', assigned: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF((p) => ({ ...p, [k]: e.target.value }));
  const filters: CaseFilters = {
    state: (f.state || undefined) as CaseState | undefined,
    risk: (f.risk || undefined) as RiskLevel | undefined,
    targetType: f.targetType || undefined,
    source: (f.source || undefined) as CaseFilters['source'],
    category: f.category || undefined,
    assigned: (f.assigned || undefined) as CaseFilters['assigned'],
  };
  const list = usePagedList<CaseSummary>(
    (cursor, signal) =>
      staff
        ? api.moderation.cases({ ...filters, cursor, limit: 25, signal })
        : api.moderation.casesReadOnly({ ...filters, cursor, limit: 25, signal }),
    [api, staff, f.state, f.risk, f.targetType, f.source, f.category, f.assigned],
  );
  const { user } = useAdmin();

  return (
    <>
      <PageHeader title={t('mod.title')} lead={staff ? t('mod.lead') : t('mod.leadReadOnly')} />
      <ModerationNav current="queue" />
      <div className="page-body">
        {staff ? <QueueStats /> : null}
        <Section title={t('mod.queue.title')} description={t('mod.queue.desc')}>
          <Filters label={t('mod.filters')}>
            <FormField label={t('mod.filter.state')}>
              <Select value={f.state} onChange={set('state')}>
                <option value="">{t('mod.filter.stateOpen')}</option>
                {CASE_STATES.map((s) => (
                  <option key={s} value={s}>
                    {label('caseState', s)}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label={t('mod.filter.risk')}>
              <Select value={f.risk} onChange={set('risk')}>
                <option value="">{t('common.any')}</option>
                {RISK_LEVELS.map((s) => (
                  <option key={s} value={s}>
                    {label('risk', s)}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label={t('mod.filter.target')}>
              <Select value={f.targetType} onChange={set('targetType')}>
                <option value="">{t('common.any')}</option>
                {REPORT_TARGET_TYPES.map((s) => (
                  <option key={s} value={s}>
                    {label('targetType', s)}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label={t('mod.filter.source')}>
              <Select value={f.source} onChange={set('source')}>
                <option value="">{t('common.any')}</option>
                {['user_report', 'automated', 'staff'].map((s) => (
                  <option key={s} value={s}>
                    {label('source', s)}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label={t('mod.filter.category')}>
              <Select value={f.category} onChange={set('category')}>
                <option value="">{t('common.any')}</option>
                {[...new Set(REPORT_REASONS.map((r) => (r === 'violence' ? 'threat' : r)))].map(
                  (s) => (
                    <option key={s} value={s}>
                      {label('category', s)}
                    </option>
                  ),
                )}
              </Select>
            </FormField>
            <FormField label={t('mod.filter.assigned')}>
              <Select value={f.assigned} onChange={set('assigned')}>
                <option value="">{t('common.any')}</option>
                <option value="me">{t('mod.filter.assignedMe')}</option>
                <option value="none">{t('mod.filter.assignedNone')}</option>
              </Select>
            </FormField>
          </Filters>
          <ListView
            list={list}
            emptyTitle={t('mod.queue.emptyTitle')}
            emptyBody={t('mod.queue.emptyBody')}
          >
            {(items) => (
              <DataTable
                caption={t('mod.queue.title')}
                rows={items}
                rowKey={(c) => c.id}
                columns={[
                  {
                    id: 'case',
                    header: t('mod.col.case'),
                    rowHeader: true,
                    cell: (c) => (
                      <Link href={`/moderation/cases/${c.id}`}>
                        <ShortId id={c.id} />
                      </Link>
                    ),
                  },
                  {
                    id: 'risk',
                    header: t('mod.col.risk'),
                    cell: (c) => <StatusBadge group="risk" value={c.riskLevel} />,
                  },
                  {
                    id: 'state',
                    header: t('mod.col.state'),
                    cell: (c) => <StatusBadge group="caseState" value={c.state} />,
                  },
                  {
                    id: 'target',
                    header: t('mod.col.target'),
                    cell: (c) => label('targetType', c.targetType),
                  },
                  {
                    id: 'cats',
                    header: t('mod.col.categories'),
                    cell: (c) => c.categories.map((x) => label('category', x)).join(', '),
                  },
                  {
                    id: 'subject',
                    header: t('mod.col.subject'),
                    cell: (c) =>
                      c.subject
                        ? (c.subject.username ?? <ShortId id={c.subject.id} />)
                        : t('common.none'),
                  },
                  {
                    id: 'source',
                    header: t('mod.col.source'),
                    cell: (c) => label('source', c.source),
                  },
                  {
                    id: 'reports',
                    header: t('mod.col.reports'),
                    numeric: true,
                    cell: (c) => c.reportCount,
                  },
                  {
                    id: 'assigned',
                    header: t('mod.col.assigned'),
                    cell: (c) =>
                      c.assignedTo ? (
                        c.assignedTo === user.id ? (
                          t('mod.assignedToMe')
                        ) : (
                          <ShortId id={c.assignedTo} />
                        )
                      ) : (
                        t('mod.unassigned')
                      ),
                  },
                  {
                    id: 'created',
                    header: t('mod.col.created'),
                    cell: (c) => <Time value={c.createdAt} />,
                  },
                ]}
              />
            )}
          </ListView>
        </Section>
      </div>
    </>
  );
}
