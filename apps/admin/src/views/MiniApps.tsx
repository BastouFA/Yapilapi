'use client';

import { useState } from 'react';
import { Button, FormField, Select } from '@yapilapi/ui';
import type { StaffMiniApp } from '@yapilapi/api-client';
import { useI18n } from '@/i18n';
import { useAdminApi } from '@/lib/api';
import { usePagedList } from '@/lib/hooks';
import { useAdmin } from '@/lib/session';
import { DataTable } from '@/components/DataTable';
import {
  Filters,
  JsonFacts,
  ListView,
  MutationDialog,
  PageHeader,
  StatusBadge,
  Time,
} from '@/components/common';

type Status = 'draft' | 'in_review' | 'published' | 'rejected' | 'suspended';
type Decision = 'approve' | 'reject' | 'suspend' | 'reinstate';

/** Decisions that make sense for a mini app in this state (the API refuses any other transition with 409). */
export function decisionsFor(status: string): Decision[] {
  if (status === 'in_review') return ['approve', 'reject'];
  if (status === 'published') return ['suspend'];
  if (status === 'suspended') return ['reinstate'];
  return [];
}

export function MiniAppsView() {
  const { t, tx, label } = useI18n();
  const api = useAdminApi();
  const { can } = useAdmin();
  const [status, setStatus] = useState<Status>('in_review');
  const [target, setTarget] = useState<{ app: StaffMiniApp; decision: Decision } | null>(null);
  const list = usePagedList<StaffMiniApp>(
    (cursor, signal) => api.miniApps.list({ status, cursor, limit: 25, signal }),
    [api, status],
  );
  const canReview = can('miniapps.review');
  return (
    <>
      <PageHeader title={t('mini.title')} lead={t('mini.lead')} />
      <div className="page-body">
        <Filters label={t('common.filters')}>
          <FormField label={t('mini.status')}>
            <Select value={status} onChange={(e) => setStatus(e.target.value as Status)}>
              {(['in_review', 'published', 'rejected', 'suspended', 'draft'] as const).map((s) => (
                <option key={s} value={s}>
                  {label('miniStatus', s)}
                </option>
              ))}
            </Select>
          </FormField>
        </Filters>
        <ListView list={list} emptyTitle={t('mini.emptyTitle')} emptyBody={t('mini.emptyBody')}>
          {(items) => (
            <DataTable
              caption={t('mini.title')}
              rows={items}
              rowKey={(m) => m.id}
              columns={[
                {
                  id: 'name',
                  header: t('mini.col.name'),
                  rowHeader: true,
                  cell: (m) => (
                    <div className="cell-stack">
                      <strong>{m.name}</strong>
                      <span className="muted mono">
                        {m.slug}
                        {m.version ? ` v${m.version}` : ''}
                      </span>
                    </div>
                  ),
                },
                {
                  id: 'dev',
                  header: t('mini.col.developer'),
                  cell: (m) => (
                    <div className="cell-stack">
                      <span>{m.developer ?? t('common.none')}</span>
                      <span className="muted">{m.appName}</span>
                    </div>
                  ),
                },
                {
                  id: 'status',
                  header: t('mini.status'),
                  cell: (m) => <StatusBadge group="miniStatus" value={m.status} />,
                },
                {
                  id: 'sub',
                  header: t('mini.col.submitted'),
                  cell: (m) => <Time value={m.submittedAt} />,
                },
                {
                  id: 'manifest',
                  header: t('mini.col.manifest'),
                  cell: (m) =>
                    m.manifest ? (
                      <details>
                        <summary>{t('mini.showManifest')}</summary>
                        <JsonFacts value={m.manifest} />
                      </details>
                    ) : (
                      t('common.none')
                    ),
                },
                {
                  id: 'note',
                  header: t('mini.col.note'),
                  cell: (m) => m.reviewNote ?? t('common.none'),
                },
                ...(canReview
                  ? [
                      {
                        id: 'act',
                        header: t('common.actions'),
                        cell: (m: StaffMiniApp) => (
                          <div className="cell-actions">
                            {decisionsFor(m.status).map((d) => (
                              <Button
                                key={d}
                                size="sm"
                                variant={d === 'reject' || d === 'suspend' ? 'danger' : 'primary'}
                                onClick={() => setTarget({ app: m, decision: d })}
                              >
                                {tx(`mini.decision.${d}`)}
                              </Button>
                            ))}
                          </div>
                        ),
                      },
                    ]
                  : []),
              ]}
            />
          )}
        </ListView>
        {target ? (
          <MutationDialog
            open
            onClose={() => setTarget(null)}
            title={tx(`mini.decision.${target.decision}Title`, { name: target.app.name })}
            description={t('mini.dialogDesc')}
            tone={
              target.decision === 'reject' || target.decision === 'suspend' ? 'danger' : 'primary'
            }
            submitLabel={tx(`mini.decision.${target.decision}`)}
            reasonLabel={t('mini.note')}
            reasonOptional={target.decision === 'approve' || target.decision === 'reinstate'}
            {...(target.decision === 'reject' || target.decision === 'suspend'
              ? { confirmPhrase: target.app.slug }
              : {})}
            onSubmit={(note) =>
              api.miniApps.review(target.app.id, {
                decision: target.decision,
                ...(note ? { note } : {}),
              })
            }
            successMessage={t('mini.done', { name: target.app.name })}
            onDone={() => {
              setTarget(null);
              list.reload();
            }}
          />
        ) : null}
      </div>
    </>
  );
}
