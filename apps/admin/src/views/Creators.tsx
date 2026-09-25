'use client';

import { useState } from 'react';
import { Button, FormField, Select } from '@yapilapi/ui';
import type { AdminCreator, KycRow } from '@yapilapi/api-client';
import { useI18n } from '@/i18n';
import { useAdminApi } from '@/lib/api';
import { usePagedList, useResource } from '@/lib/hooks';
import { useAdmin } from '@/lib/session';
import { DataTable } from '@/components/DataTable';
import {
  Filters,
  ListView,
  MutationDialog,
  PageHeader,
  ResourceView,
  Section,
  ShortId,
  StatusBadge,
  Time,
} from '@/components/common';

function KycQueue() {
  const { t, label } = useI18n();
  const api = useAdminApi();
  const [status, setStatus] = useState<'pending' | 'verified' | 'rejected' | 'unverified'>(
    'pending',
  );
  const res = useResource((signal) => api.creators.kycQueue(status, { signal }), [api, status]);
  const [target, setTarget] = useState<{ row: KycRow; decision: 'verify' | 'reject' } | null>(null);
  return (
    <Section title={t('creators.kyc.title')} description={t('creators.kyc.desc')}>
      <div className="stack">
        <Filters label={t('common.filters')}>
          <FormField label={t('creators.kyc.status')}>
            <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
              {(['pending', 'verified', 'rejected', 'unverified'] as const).map((s) => (
                <option key={s} value={s}>
                  {label('kyc', s)}
                </option>
              ))}
            </Select>
          </FormField>
        </Filters>
        <ResourceView
          resource={res}
          isEmpty={(d) => d.items.length === 0}
          emptyTitle={t('creators.kyc.emptyTitle')}
          emptyBody={t('creators.kyc.emptyBody')}
        >
          {(d) => (
            <DataTable
              caption={t('creators.kyc.title')}
              rows={d.items}
              rowKey={(r) => r.userId}
              columns={[
                {
                  id: 'user',
                  header: t('creators.col.user'),
                  rowHeader: true,
                  cell: (r) => r.username,
                },
                {
                  id: 'status',
                  header: t('creators.col.kyc'),
                  cell: (r) => <StatusBadge group="kyc" value={r.kycStatus} />,
                },
                {
                  id: 'sub',
                  header: t('creators.kyc.submitted'),
                  cell: (r) => <Time value={r.submittedAt} />,
                },
                {
                  id: 'dec',
                  header: t('creators.kyc.decided'),
                  cell: (r) => <Time value={r.decidedAt} />,
                },
                {
                  id: 'note',
                  header: t('creators.kyc.note'),
                  cell: (r) => r.note ?? t('common.none'),
                },
                {
                  id: 'act',
                  header: t('common.actions'),
                  cell: (r) =>
                    r.kycStatus === 'pending' ? (
                      <div className="cell-actions">
                        <Button size="sm" onClick={() => setTarget({ row: r, decision: 'verify' })}>
                          {t('creators.kyc.verify')}
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => setTarget({ row: r, decision: 'reject' })}
                        >
                          {t('creators.kyc.reject')}
                        </Button>
                      </div>
                    ) : null,
                },
              ]}
            />
          )}
        </ResourceView>
        {target ? (
          <MutationDialog
            open
            onClose={() => setTarget(null)}
            title={t(
              target.decision === 'verify'
                ? 'creators.kyc.verifyTitle'
                : 'creators.kyc.rejectTitle',
              { name: target.row.username },
            )}
            description={t('creators.kyc.dialogDesc')}
            tone={target.decision === 'reject' ? 'danger' : 'primary'}
            submitLabel={t(
              target.decision === 'verify' ? 'creators.kyc.verify' : 'creators.kyc.reject',
            )}
            reasonLabel={t('creators.kyc.noteLabel')}
            {...(target.decision === 'reject' ? { confirmPhrase: target.row.username } : {})}
            onSubmit={(note) =>
              api.creators.decideKyc(target.row.userId, { decision: target.decision, note })
            }
            successMessage={t(
              target.decision === 'verify' ? 'creators.kyc.verified' : 'creators.kyc.rejected',
              { name: target.row.username },
            )}
            onDone={() => {
              setTarget(null);
              res.reload();
            }}
          />
        ) : null}
      </div>
    </Section>
  );
}

export function CreatorsView() {
  const { t, label } = useI18n();
  const api = useAdminApi();
  const { can, atLeast } = useAdmin();
  const [status, setStatus] = useState('');
  const [kyc, setKyc] = useState('');
  const [target, setTarget] = useState<{ c: AdminCreator; action: 'suspend' | 'reinstate' } | null>(
    null,
  );
  const list = usePagedList<AdminCreator>(
    (cursor, signal) =>
      api.creators.list({
        status: status || undefined,
        kyc: kyc || undefined,
        cursor,
        limit: 25,
        signal,
      }),
    [api, status, kyc],
  );
  const canAct = can('creators.suspend');
  return (
    <>
      <PageHeader title={t('creators.title')} lead={t('creators.lead')} />
      <div className="page-body">
        {atLeast('admin') ? <KycQueue /> : null}
        <Section title={t('creators.list.title')}>
          <Filters label={t('common.filters')}>
            <FormField label={t('creators.col.status')}>
              <Select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">{t('common.any')}</option>
                {['active', 'suspended', 'closed'].map((s) => (
                  <option key={s} value={s}>
                    {label('status', s)}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label={t('creators.col.kyc')}>
              <Select value={kyc} onChange={(e) => setKyc(e.target.value)}>
                <option value="">{t('common.any')}</option>
                {['unverified', 'pending', 'verified', 'rejected'].map((s) => (
                  <option key={s} value={s}>
                    {label('kyc', s)}
                  </option>
                ))}
              </Select>
            </FormField>
          </Filters>
          <ListView
            list={list}
            emptyTitle={t('creators.emptyTitle')}
            emptyBody={t('creators.emptyBody')}
          >
            {(items) => (
              <DataTable
                caption={t('creators.list.title')}
                rows={items}
                rowKey={(c) => c.userId}
                columns={[
                  {
                    id: 'user',
                    header: t('creators.col.user'),
                    rowHeader: true,
                    cell: (c) => c.username ?? <ShortId id={c.userId} />,
                  },
                  {
                    id: 'status',
                    header: t('creators.col.status'),
                    cell: (c) => <StatusBadge group="status" value={c.status} />,
                  },
                  {
                    id: 'kyc',
                    header: t('creators.col.kyc'),
                    cell: (c) => <StatusBadge group="kyc" value={c.kycStatus} />,
                  },
                  {
                    id: 'cat',
                    header: t('creators.col.category'),
                    cell: (c) => c.category ?? t('common.none'),
                  },
                  {
                    id: 'fol',
                    header: t('creators.col.followers'),
                    numeric: true,
                    cell: (c) => c.followers ?? t('common.none'),
                  },
                  {
                    id: 'created',
                    header: t('creators.col.created'),
                    cell: (c) => <Time value={c.createdAt} />,
                  },
                  ...(canAct
                    ? [
                        {
                          id: 'act',
                          header: t('common.actions'),
                          cell: (c: AdminCreator) =>
                            c.status === 'active' ? (
                              <Button
                                size="sm"
                                variant="danger"
                                onClick={() => setTarget({ c, action: 'suspend' })}
                              >
                                {t('creators.suspend')}
                              </Button>
                            ) : c.status === 'suspended' ? (
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => setTarget({ c, action: 'reinstate' })}
                              >
                                {t('creators.reinstate')}
                              </Button>
                            ) : null,
                        },
                      ]
                    : []),
                ]}
              />
            )}
          </ListView>
        </Section>
        {target ? (
          <MutationDialog
            open
            onClose={() => setTarget(null)}
            title={t(
              target.action === 'suspend' ? 'creators.suspendTitle' : 'creators.reinstateTitle',
              { name: target.c.username ?? target.c.userId.slice(0, 8) },
            )}
            description={t('creators.dialogDesc')}
            tone={target.action === 'suspend' ? 'danger' : 'primary'}
            submitLabel={t(target.action === 'suspend' ? 'creators.suspend' : 'creators.reinstate')}
            reasonLabel={t('creators.reason')}
            {...(target.action === 'suspend'
              ? { confirmPhrase: target.c.username ?? target.c.userId.slice(0, 8) }
              : {})}
            onSubmit={async (reason) => {
              if (target.action === 'suspend') await api.creators.suspend(target.c.userId, reason);
              else await api.creators.reinstate(target.c.userId, reason);
            }}
            successMessage={t(
              target.action === 'suspend' ? 'creators.suspended' : 'creators.reinstated',
            )}
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
