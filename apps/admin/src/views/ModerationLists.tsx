'use client';

import { useState } from 'react';
import { Button, FormField, Select } from '@yapilapi/ui';
import { REPORT_REASONS, type AppealRow, type ReportRow } from '@yapilapi/api-client';
import { useI18n } from '@/i18n';
import { useAdminApi } from '@/lib/api';
import { usePagedList } from '@/lib/hooks';
import { DataTable } from '@/components/DataTable';
import { Filters, ListView, PageHeader, ShortId, StatusBadge, Time } from '@/components/common';
import { AppealReviewDialog, ModerationNav, caseLink } from './moderation-shared';

export function AppealsView() {
  const { t, label } = useI18n();
  const api = useAdminApi();
  const [status, setStatus] = useState<'open' | 'upheld' | 'overturned'>('open');
  const [review, setReview] = useState<AppealRow | null>(null);
  const list = usePagedList<AppealRow>(
    (cursor, signal) => api.moderation.appeals({ status, cursor, limit: 25, signal }),
    [api, status],
  );
  return (
    <>
      <PageHeader title={t('mod.appeals.title')} lead={t('mod.appeals.lead')} />
      <ModerationNav current="appeals" />
      <div className="page-body">
        <Filters label={t('mod.filters')}>
          <FormField label={t('mod.appeals.status')}>
            <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
              {(['open', 'upheld', 'overturned'] as const).map((s) => (
                <option key={s} value={s}>
                  {label('appealStatus', s)}
                </option>
              ))}
            </Select>
          </FormField>
        </Filters>
        <ListView
          list={list}
          emptyTitle={t('mod.appeals.emptyTitle')}
          emptyBody={t('mod.appeals.emptyBody')}
        >
          {(items) => (
            <DataTable
              caption={t('mod.appeals.title')}
              rows={items}
              rowKey={(a) => a.id}
              columns={[
                {
                  id: 'case',
                  header: t('mod.col.case'),
                  rowHeader: true,
                  cell: (a) => caseLink(a.caseId),
                },
                {
                  id: 'status',
                  header: t('mod.col.state'),
                  cell: (a) => <StatusBadge group="appealStatus" value={a.status} />,
                },
                {
                  id: 'decision',
                  header: t('mod.col.decision'),
                  cell: (a) => (a.decision ? label('decision', a.decision) : t('common.none')),
                },
                {
                  id: 'risk',
                  header: t('mod.col.risk'),
                  cell: (a) => <StatusBadge group="risk" value={a.riskLevel} />,
                },
                {
                  id: 'statement',
                  header: t('mod.appeal.statement'),
                  cell: (a) => (
                    <span className="wrap">
                      {a.statement.length > 160 ? `${a.statement.slice(0, 160)}…` : a.statement}
                    </span>
                  ),
                },
                {
                  id: 'orig',
                  header: t('mod.appeal.originalDecider'),
                  cell: (a) => <ShortId id={a.originalDeciderId} />,
                },
                {
                  id: 'created',
                  header: t('mod.col.created'),
                  cell: (a) => <Time value={a.createdAt} />,
                },
                {
                  id: 'act',
                  header: t('common.actions'),
                  cell: (a) =>
                    a.status === 'open' ? (
                      <Button size="sm" onClick={() => setReview(a)}>
                        {t('mod.appeal.review')}
                      </Button>
                    ) : (
                      <ShortId id={a.reviewerId} />
                    ),
                },
              ]}
            />
          )}
        </ListView>
        {review ? (
          <AppealReviewDialog
            appealId={review.id}
            statement={review.statement}
            originalDeciderId={review.originalDeciderId}
            open
            onClose={() => setReview(null)}
            onDone={() => {
              setReview(null);
              list.reload();
            }}
          />
        ) : null}
      </div>
    </>
  );
}

export function ReportsView() {
  const { t, label } = useI18n();
  const api = useAdminApi();
  const [status, setStatus] = useState('');
  const [reason, setReason] = useState('');
  const list = usePagedList<ReportRow>(
    (cursor, signal) =>
      api.moderation.reports({
        status: (status || undefined) as 'open' | undefined,
        reason: reason || undefined,
        cursor,
        limit: 25,
        signal,
      }),
    [api, status, reason],
  );
  return (
    <>
      <PageHeader title={t('mod.reports.title')} lead={t('mod.reports.lead')} />
      <ModerationNav current="reports" />
      <div className="page-body">
        <Filters label={t('mod.filters')}>
          <FormField label={t('mod.reports.status')}>
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">{t('common.any')}</option>
              {['open', 'triaged', 'actioned', 'dismissed'].map((s) => (
                <option key={s} value={s}>
                  {label('reportStatus', s)}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label={t('mod.reports.reason')}>
            <Select value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="">{t('common.any')}</option>
              {REPORT_REASONS.map((s) => (
                <option key={s} value={s}>
                  {label('reportReason', s)}
                </option>
              ))}
            </Select>
          </FormField>
        </Filters>
        <ListView
          list={list}
          emptyTitle={t('mod.reports.emptyTitle')}
          emptyBody={t('mod.reports.emptyBody')}
        >
          {(items) => (
            <DataTable
              caption={t('mod.reports.title')}
              rows={items}
              rowKey={(r) => r.id}
              columns={[
                {
                  id: 'id',
                  header: t('mod.reports.col.report'),
                  rowHeader: true,
                  cell: (r) => <ShortId id={r.id} />,
                },
                {
                  id: 'target',
                  header: t('mod.col.target'),
                  cell: (r) => (
                    <>
                      {label('targetType', r.targetType)} <ShortId id={r.targetId} />
                    </>
                  ),
                },
                {
                  id: 'reason',
                  header: t('mod.reports.reason'),
                  cell: (r) => label('reportReason', r.reason),
                },
                {
                  id: 'status',
                  header: t('mod.reports.status'),
                  cell: (r) => <StatusBadge group="reportStatus" value={r.status} />,
                },
                {
                  id: 'reporter',
                  header: t('mod.reports.col.reporter'),
                  cell: (r) =>
                    r.reporterId ? <ShortId id={r.reporterId} /> : t('mod.reports.hidden'),
                },
                {
                  id: 'created',
                  header: t('mod.col.created'),
                  cell: (r) => <Time value={r.createdAt} />,
                },
              ]}
            />
          )}
        </ListView>
      </div>
    </>
  );
}
