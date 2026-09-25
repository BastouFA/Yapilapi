'use client';

import { useState } from 'react';
import { Button, FormField, Input, Select } from '@yapilapi/ui';
import type { AdminCommunity } from '@yapilapi/api-client';
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

export function CommunitiesView() {
  const { t, label, fmt } = useI18n();
  const api = useAdminApi();
  const { can } = useAdmin();
  const [q, setQ] = useState('');
  const [suspended, setSuspended] = useState('');
  const dq = useDebounced(q.trim());
  const [target, setTarget] = useState<{ c: AdminCommunity; action: 'suspend' | 'restore' } | null>(
    null,
  );
  const list = usePagedList<AdminCommunity>(
    (cursor, signal) =>
      api.communities.list({
        q: dq || undefined,
        suspended: suspended === '' ? undefined : suspended === 'true',
        cursor,
        limit: 25,
        signal,
      }),
    [api, dq, suspended],
  );
  const canAct = can('communities.suspend');
  return (
    <>
      <PageHeader title={t('communities.title')} lead={t('communities.lead')} />
      <div className="page-body">
        <Filters label={t('common.filters')}>
          <FormField label={t('communities.search')} className="yl-field--grow">
            <Input value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
          </FormField>
          <FormField label={t('communities.suspendedFilter')}>
            <Select value={suspended} onChange={(e) => setSuspended(e.target.value)}>
              <option value="">{t('common.any')}</option>
              <option value="false">{t('communities.onlyActive')}</option>
              <option value="true">{t('communities.onlySuspended')}</option>
            </Select>
          </FormField>
        </Filters>
        <ListView
          list={list}
          emptyTitle={t('communities.emptyTitle')}
          emptyBody={t('communities.emptyBody')}
        >
          {(items) => (
            <DataTable
              caption={t('communities.title')}
              rows={items}
              rowKey={(c) => c.id}
              columns={[
                {
                  id: 'name',
                  header: t('communities.col.name'),
                  rowHeader: true,
                  cell: (c) => (
                    <div className="cell-stack">
                      <strong>{c.name}</strong>
                      <span className="muted mono">{c.slug}</span>
                    </div>
                  ),
                },
                {
                  id: 'vis',
                  header: t('communities.col.visibility'),
                  cell: (c) => label('visibility', c.visibility),
                },
                {
                  id: 'members',
                  header: t('communities.col.members'),
                  numeric: true,
                  cell: (c) => fmt.number(c.memberCount),
                },
                {
                  id: 'owner',
                  header: t('communities.col.owner'),
                  cell: (c) => <ShortId id={c.ownerId} />,
                },
                {
                  id: 'status',
                  header: t('communities.col.status'),
                  cell: (c) => (
                    <StatusBadge group="status" value={c.suspended ? 'suspended' : 'active'} />
                  ),
                },
                {
                  id: 'created',
                  header: t('communities.col.created'),
                  cell: (c) => <Time value={c.createdAt} />,
                },
                ...(canAct
                  ? [
                      {
                        id: 'act',
                        header: t('common.actions'),
                        cell: (c: AdminCommunity) =>
                          c.suspended ? (
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => setTarget({ c, action: 'restore' })}
                            >
                              {t('communities.restore')}
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="danger"
                              onClick={() => setTarget({ c, action: 'suspend' })}
                            >
                              {t('communities.suspend')}
                            </Button>
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
            title={t(
              target.action === 'suspend' ? 'communities.suspendTitle' : 'communities.restoreTitle',
              { name: target.c.name },
            )}
            description={t(
              target.action === 'suspend' ? 'communities.suspendDesc' : 'communities.restoreDesc',
            )}
            tone={target.action === 'suspend' ? 'danger' : 'primary'}
            submitLabel={t(
              target.action === 'suspend' ? 'communities.suspend' : 'communities.restore',
            )}
            reasonLabel={t('communities.reason')}
            {...(target.action === 'suspend' ? { confirmPhrase: target.c.slug } : {})}
            onSubmit={async (reason) => {
              if (target.action === 'suspend') await api.communities.suspend(target.c.id, reason);
              else await api.communities.restore(target.c.id, reason);
            }}
            successMessage={t(
              target.action === 'suspend' ? 'communities.suspended' : 'communities.restored',
              { name: target.c.name },
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
