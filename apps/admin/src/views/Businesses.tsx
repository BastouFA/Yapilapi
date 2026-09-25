'use client';

import { useState } from 'react';
import { Badge, Button, FormField, Input, Select } from '@yapilapi/ui';
import type { AdminBusiness } from '@yapilapi/api-client';
import { useI18n } from '@/i18n';
import { useAdminApi } from '@/lib/api';
import { useDebounced, usePagedList } from '@/lib/hooks';
import { useAdmin } from '@/lib/session';
import { DataTable } from '@/components/DataTable';
import {
  Filters,
  ListView,
  MutationDialog,
  PageHeader,
  ShortId,
  StatusBadge,
  Time,
} from '@/components/common';

type Action = 'verify' | 'unverify' | 'suspend' | 'reinstate';

export function BusinessesView() {
  const { t, tx, label } = useI18n();
  const api = useAdminApi();
  const { can } = useAdmin();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [verified, setVerified] = useState('');
  const dq = useDebounced(q.trim());
  const [target, setTarget] = useState<{ b: AdminBusiness; action: Action } | null>(null);
  const list = usePagedList<AdminBusiness>(
    (cursor, signal) =>
      api.businesses.list({
        q: dq || undefined,
        status: status || undefined,
        verified: verified === '' ? undefined : verified === 'true',
        cursor,
        limit: 25,
        signal,
      }),
    [api, dq, status, verified],
  );
  const canVerify = can('businesses.verify');
  const canSuspend = can('businesses.suspend');
  const run = (t0: NonNullable<typeof target>, reason: string) => {
    const { b, action } = t0;
    if (action === 'verify') return api.businesses.verify(b.id, reason || undefined);
    if (action === 'unverify') return api.businesses.unverify(b.id, reason || undefined);
    return api.businesses.setStatus(b.id, {
      status: action === 'suspend' ? 'suspended' : 'active',
      reason,
    });
  };
  return (
    <>
      <PageHeader title={t('businesses.title')} lead={t('businesses.lead')} />
      <div className="page-body">
        <Filters label={t('common.filters')}>
          <FormField label={t('businesses.search')} className="yl-field--grow">
            <Input value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
          </FormField>
          <FormField label={t('businesses.statusFilter')}>
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">{t('common.any')}</option>
              {['pending', 'active', 'suspended', 'closed'].map((s) => (
                <option key={s} value={s}>
                  {label('status', s)}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label={t('businesses.verifiedFilter')}>
            <Select value={verified} onChange={(e) => setVerified(e.target.value)}>
              <option value="">{t('common.any')}</option>
              <option value="true">{t('businesses.onlyVerified')}</option>
              <option value="false">{t('businesses.onlyUnverified')}</option>
            </Select>
          </FormField>
        </Filters>
        <ListView
          list={list}
          emptyTitle={t('businesses.emptyTitle')}
          emptyBody={t('businesses.emptyBody')}
        >
          {(items) => (
            <DataTable
              caption={t('businesses.title')}
              rows={items}
              rowKey={(b) => b.id}
              columns={[
                {
                  id: 'name',
                  header: t('businesses.col.name'),
                  rowHeader: true,
                  cell: (b) => (
                    <div className="cell-stack">
                      <strong>{b.name}</strong>
                      <span className="muted mono">{b.slug}</span>
                    </div>
                  ),
                },
                {
                  id: 'cat',
                  header: t('businesses.col.category'),
                  cell: (b) => b.category ?? t('common.none'),
                },
                {
                  id: 'status',
                  header: t('businesses.col.status'),
                  cell: (b) => <StatusBadge group="status" value={b.status} />,
                },
                {
                  id: 'ver',
                  header: t('businesses.col.verified'),
                  cell: (b) =>
                    b.verified ? (
                      <Badge tone="success">{t('businesses.verified')}</Badge>
                    ) : (
                      <Badge tone="neutral">{t('businesses.unverified')}</Badge>
                    ),
                },
                {
                  id: 'owner',
                  header: t('businesses.col.owner'),
                  cell: (b) => <ShortId id={b.ownerId} />,
                },
                {
                  id: 'created',
                  header: t('businesses.col.created'),
                  cell: (b) => <Time value={b.createdAt} />,
                },
                ...(canVerify || canSuspend
                  ? [
                      {
                        id: 'act',
                        header: t('common.actions'),
                        cell: (b: AdminBusiness) => (
                          <div className="cell-actions">
                            {canVerify && !b.verified ? (
                              <Button size="sm" onClick={() => setTarget({ b, action: 'verify' })}>
                                {t('businesses.verify')}
                              </Button>
                            ) : null}
                            {canVerify && b.verified ? (
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => setTarget({ b, action: 'unverify' })}
                              >
                                {t('businesses.unverify')}
                              </Button>
                            ) : null}
                            {canSuspend && b.status === 'active' ? (
                              <Button
                                size="sm"
                                variant="danger"
                                onClick={() => setTarget({ b, action: 'suspend' })}
                              >
                                {t('businesses.suspend')}
                              </Button>
                            ) : null}
                            {canSuspend && b.status === 'suspended' ? (
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => setTarget({ b, action: 'reinstate' })}
                              >
                                {t('businesses.reinstate')}
                              </Button>
                            ) : null}
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
            title={tx(`businesses.${target.action}Title`, { name: target.b.name })}
            description={tx(`businesses.${target.action}Desc`)}
            tone={
              target.action === 'suspend' || target.action === 'unverify' ? 'danger' : 'primary'
            }
            submitLabel={tx(`businesses.${target.action}`)}
            reasonLabel={
              target.action === 'verify' || target.action === 'unverify'
                ? t('businesses.note')
                : t('businesses.reason')
            }
            reasonOptional={target.action === 'verify' || target.action === 'unverify'}
            {...(target.action === 'suspend' || target.action === 'unverify'
              ? { confirmPhrase: target.b.slug }
              : {})}
            onSubmit={(reason) => run(target, reason)}
            successMessage={tx(`businesses.${target.action}Done`, { name: target.b.name })}
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
