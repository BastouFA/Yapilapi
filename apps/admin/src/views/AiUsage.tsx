'use client';

import { useState } from 'react';
import { FormField, Select } from '@yapilapi/ui';
import { isUnavailable, type AiUsage, type Unavailable } from '@yapilapi/api-client';
import { useI18n } from '@/i18n';
import { useAdminApi } from '@/lib/api';
import { useResource } from '@/lib/hooks';
import { HBarChart, Kpi, LineChart } from '@/components/charts';
import { DataTable } from '@/components/DataTable';
import { Filters, PageHeader, ResourceView, Section } from '@/components/common';

function Part<T>({
  value,
  children,
}: {
  value: T | Unavailable;
  children: (v: T) => React.ReactNode;
}) {
  const { t } = useI18n();
  return isUnavailable(value) ? (
    <p className="muted">{t('analytics.unavailable')}</p>
  ) : (
    <>{children(value as T)}</>
  );
}

export function AiUsageView() {
  const { t, label, fmt } = useI18n();
  const api = useAdminApi();
  const [days, setDays] = useState(30);
  const res = useResource((signal) => api.ai.usage(days, { signal }), [api, days]);
  return (
    <>
      <PageHeader title={t('ai.title')} lead={t('ai.lead')} />
      <div className="page-body">
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
          {(u: AiUsage) => (
            <>
              <Section title={t('ai.consent.title')} description={t('ai.consent.desc')}>
                <Part value={u.consent}>
                  {(c) => (
                    <div className="grid-kpi">
                      <Kpi
                        label={t('ai.consent.users')}
                        value={fmt.number(c.users_with_ai_consent)}
                      />
                    </div>
                  )}
                </Part>
              </Section>
              <Section title={t('ai.daily.title')}>
                <Part value={u.daily}>
                  {(d) => (
                    <LineChart
                      title={t('ai.daily.chart')}
                      summary={t('ai.daily.summary', {
                        total: d.reduce((a, r) => a + r.assistant_messages, 0),
                      })}
                      valueHeader={t('ai.daily.messages')}
                      xHeader={t('analytics.day')}
                      points={d.map((r) => ({ x: r.day, y: r.assistant_messages }))}
                    />
                  )}
                </Part>
              </Section>
              <div className="grid-2">
                <Section title={t('ai.models.title')}>
                  <Part value={u.assistantMessages}>
                    {(rows) =>
                      rows.length === 0 ? (
                        <p className="muted">{t('payments.noneInPeriod')}</p>
                      ) : (
                        <DataTable
                          caption={t('ai.models.title')}
                          rows={rows}
                          rowKey={(r) => `${r.provider}-${r.model}`}
                          columns={[
                            {
                              id: 'p',
                              header: t('payments.col.provider'),
                              rowHeader: true,
                              cell: (r) => r.provider,
                            },
                            { id: 'm', header: t('ai.models.model'), cell: (r) => r.model },
                            {
                              id: 'n',
                              header: t('payments.col.count'),
                              numeric: true,
                              cell: (r) => fmt.number(r.count),
                            },
                          ]}
                        />
                      )
                    }
                  </Part>
                </Section>
                <Section title={t('ai.drafts.title')} description={t('ai.drafts.desc')}>
                  <Part value={u.drafts}>
                    {(rows) =>
                      rows.length === 0 ? (
                        <p className="muted">{t('payments.noneInPeriod')}</p>
                      ) : (
                        <DataTable
                          caption={t('ai.drafts.title')}
                          rows={rows}
                          rowKey={(r) => `${r.kind}-${r.status}`}
                          columns={[
                            {
                              id: 'k',
                              header: t('ai.drafts.kind'),
                              rowHeader: true,
                              cell: (r) => r.kind,
                            },
                            {
                              id: 's',
                              header: t('payments.col.status'),
                              cell: (r) => label('draftStatus', r.status),
                            },
                            {
                              id: 'n',
                              header: t('payments.col.count'),
                              numeric: true,
                              cell: (r) => fmt.number(r.count),
                            },
                          ]}
                        />
                      )
                    }
                  </Part>
                </Section>
              </div>
              <Section title={t('ai.tools.title')} description={t('ai.tools.desc')}>
                <Part value={u.toolCalls}>
                  {(rows) =>
                    rows.length === 0 ? (
                      <p className="muted">{t('payments.noneInPeriod')}</p>
                    ) : (
                      <HBarChart
                        title={t('ai.tools.chart')}
                        summary={t('ai.tools.summary', {
                          total: rows.reduce((a, r) => a + r.count, 0),
                        })}
                        valueHeader={t('payments.col.count')}
                        data={rows.map((r) => ({
                          label: `${r.tool} · ${label('toolOutcome', r.outcome)}`,
                          value: r.count,
                        }))}
                      />
                    )
                  }
                </Part>
              </Section>
            </>
          )}
        </ResourceView>
      </div>
    </>
  );
}
