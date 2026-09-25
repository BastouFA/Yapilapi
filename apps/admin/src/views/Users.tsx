'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button, EmptyState, FormField, Input, Select } from '@yapilapi/ui';
import {
  PLATFORM_ROLE_NAMES,
  type AdminUserRow,
  type PlatformRoleName,
} from '@yapilapi/api-client';
import { useI18n } from '@/i18n';
import { useAdminApi } from '@/lib/api';
import { usePagedList } from '@/lib/hooks';
import { DataTable } from '@/components/DataTable';
import { Filters, ListView, PageHeader, StatusBadge, Time } from '@/components/common';

const STATUSES = ['active', 'suspended', 'deactivated', 'pending_deletion', 'deleted'] as const;

export function UsersView() {
  const { t, label } = useI18n();
  const api = useAdminApi();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [role, setRole] = useState('');
  const [submitted, setSubmitted] = useState<{ q: string; status: string; role: string } | null>(
    null,
  );
  const list = usePagedList<AdminUserRow>(
    async (cursor, signal) => {
      if (!submitted) return { items: [], nextCursor: null };
      return api.users.search({
        q: submitted.q,
        status: submitted.status || undefined,
        role: (submitted.role || undefined) as PlatformRoleName | undefined,
        cursor,
        limit: 25,
        signal,
      });
    },
    [api, submitted],
  );
  const canSearch = q.trim().length >= 2;

  return (
    <>
      <PageHeader title={t('users.title')} lead={t('users.lead')} />
      <div className="page-body">
        <Filters
          label={t('users.searchLabel')}
          onSubmit={() => {
            if (canSearch) setSubmitted({ q: q.trim(), status, role });
          }}
        >
          <FormField
            label={t('users.query')}
            description={t('users.queryHint')}
            className="yl-field--grow"
          >
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </FormField>
          <FormField label={t('users.status')}>
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">{t('common.any')}</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {label('status', s)}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label={t('users.role')}>
            <Select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="">{t('common.any')}</option>
              {PLATFORM_ROLE_NAMES.map((r) => (
                <option key={r} value={r}>
                  {label('role', r)}
                </option>
              ))}
            </Select>
          </FormField>
          <Button type="submit" disabled={!canSearch}>
            {t('common.search')}
          </Button>
        </Filters>
        {!submitted ? (
          <EmptyState
            title={t('users.promptTitle')}
            description={t('users.promptBody')}
            headingLevel={2}
          />
        ) : (
          <ListView list={list} emptyTitle={t('users.noneTitle')} emptyBody={t('users.noneBody')}>
            {(items) => (
              <DataTable
                caption={t('users.results')}
                rows={items}
                rowKey={(u) => u.id}
                columns={[
                  {
                    id: 'user',
                    header: t('users.col.user'),
                    rowHeader: true,
                    cell: (u) => (
                      <Link href={`/users/${u.id}`}>{u.username ?? u.id.slice(0, 8)}</Link>
                    ),
                  },
                  {
                    id: 'name',
                    header: t('users.col.name'),
                    cell: (u) => u.displayName ?? t('common.none'),
                  },
                  {
                    id: 'email',
                    header: t('users.col.email'),
                    cell: (u) => (
                      <span dir="ltr" className="mono">
                        {u.email}
                      </span>
                    ),
                  },
                  {
                    id: 'status',
                    header: t('users.col.status'),
                    cell: (u) => <StatusBadge group="status" value={u.status} />,
                  },
                  { id: 'role', header: t('users.col.role'), cell: (u) => label('role', u.role) },
                  {
                    id: 'age',
                    header: t('users.col.age'),
                    cell: (u) => label('ageBand', u.ageBand),
                  },
                  {
                    id: 'created',
                    header: t('users.col.created'),
                    cell: (u) => <Time value={u.createdAt} />,
                  },
                ]}
              />
            )}
          </ListView>
        )}
      </div>
    </>
  );
}
