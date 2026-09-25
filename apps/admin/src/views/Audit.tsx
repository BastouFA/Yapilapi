'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button, FormField, Input } from '@yapilapi/ui';
import type { AuditEntry, AuditFilters } from '@yapilapi/api-client';
import { useI18n } from '@/i18n';
import { useAdminApi } from '@/lib/api';
import { usePagedList } from '@/lib/hooks';
import { useAdmin } from '@/lib/session';
import { DataTable } from '@/components/DataTable';
import { Filters, JsonFacts, ListView, PageHeader, ShortId, Time } from '@/components/common';
import { isUuid } from '@/lib/ids';

export interface AuditForm {
  actionPrefix: string;
  action: string;
  actorId: string;
  targetType: string;
  targetId: string;
  from: string;
  to: string;
}
export const EMPTY_AUDIT_FORM: AuditForm = {
  actionPrefix: '',
  action: '',
  actorId: '',
  targetType: '',
  targetId: '',
  from: '',
  to: '',
};

/** datetime-local ("2026-09-21T10:30") -> ISO instant the API accepts; empty or unparsable -> undefined. */
export function toIso(local: string): string | undefined {
  if (!local) return undefined;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Form values -> API filters (empty fields are dropped; nothing is sent that the API would reject). */
export function auditFilters(f: AuditForm): AuditFilters {
  const out: AuditFilters = {};
  if (f.actionPrefix.trim()) out.actionPrefix = f.actionPrefix.trim();
  if (f.action.trim()) out.action = f.action.trim();
  if (isUuid(f.actorId.trim())) out.actorId = f.actorId.trim();
  if (f.targetType.trim()) out.targetType = f.targetType.trim();
  if (f.targetId.trim()) out.targetId = f.targetId.trim();
  const from = toIso(f.from);
  const to = toIso(f.to);
  if (from) out.from = from;
  if (to) out.to = to;
  return out;
}

export function AuditView() {
  const { t } = useI18n();
  const api = useAdminApi();
  const { can } = useAdmin();
  const [form, setForm] = useState<AuditForm>(EMPTY_AUDIT_FORM);
  const [applied, setApplied] = useState<AuditFilters>({});
  const set = (k: keyof AuditForm) => (e: { target: { value: string } }) =>
    setForm((p) => ({ ...p, [k]: e.target.value }));
  const actorBad = form.actorId.trim() !== '' && !isUuid(form.actorId.trim());
  const list = usePagedList<AuditEntry>(
    (cursor, signal) => api.audit.search({ ...applied, cursor, limit: 50, signal }),
    [api, applied],
  );

  return (
    <>
      <PageHeader title={t('audit.title')} lead={t('audit.lead')} />
      <div className="page-body">
        <Filters
          label={t('audit.filters')}
          onSubmit={() => {
            if (!actorBad) setApplied(auditFilters(form));
          }}
        >
          <FormField label={t('audit.f.prefix')} description={t('audit.f.prefixHint')}>
            <Input
              value={form.actionPrefix}
              onChange={set('actionPrefix')}
              maxLength={40}
              autoComplete="off"
              spellCheck={false}
            />
          </FormField>
          <FormField label={t('audit.f.action')}>
            <Input
              value={form.action}
              onChange={set('action')}
              maxLength={80}
              autoComplete="off"
              spellCheck={false}
            />
          </FormField>
          <FormField
            label={t('audit.f.actor')}
            description={t('audit.f.actorHint')}
            {...(actorBad ? { error: t('audit.f.actorInvalid') } : {})}
          >
            <Input
              value={form.actorId}
              onChange={set('actorId')}
              autoComplete="off"
              spellCheck={false}
            />
          </FormField>
          <FormField label={t('audit.f.targetType')}>
            <Input
              value={form.targetType}
              onChange={set('targetType')}
              maxLength={40}
              autoComplete="off"
              spellCheck={false}
            />
          </FormField>
          <FormField label={t('audit.f.targetId')}>
            <Input
              value={form.targetId}
              onChange={set('targetId')}
              maxLength={80}
              autoComplete="off"
              spellCheck={false}
            />
          </FormField>
          <FormField label={t('audit.f.from')} description={t('audit.f.tzHint')}>
            <Input type="datetime-local" value={form.from} onChange={set('from')} />
          </FormField>
          <FormField label={t('audit.f.to')}>
            <Input type="datetime-local" value={form.to} onChange={set('to')} />
          </FormField>
          <Button type="submit" disabled={actorBad}>
            {t('common.search')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setForm(EMPTY_AUDIT_FORM);
              setApplied({});
            }}
          >
            {t('common.reset')}
          </Button>
        </Filters>
        <ListView list={list} emptyTitle={t('audit.emptyTitle')} emptyBody={t('audit.emptyBody')}>
          {(items) => (
            <DataTable
              caption={t('audit.title')}
              rows={items}
              rowKey={(e) => String(e.id)}
              columns={[
                {
                  id: 'at',
                  header: t('audit.col.when'),
                  rowHeader: true,
                  cell: (e) => <Time value={e.createdAt} />,
                },
                {
                  id: 'action',
                  header: t('audit.col.action'),
                  cell: (e) => <code className="mono">{e.action}</code>,
                },
                {
                  id: 'actor',
                  header: t('audit.col.actor'),
                  cell: (e) =>
                    e.actorId ? (
                      can('users.read') ? (
                        <Link href={`/users/${e.actorId}`}>
                          <ShortId id={e.actorId} />
                        </Link>
                      ) : (
                        <ShortId id={e.actorId} />
                      )
                    ) : (
                      <span className="muted">{e.actorType ?? t('common.none')}</span>
                    ),
                },
                {
                  id: 'target',
                  header: t('audit.col.target'),
                  cell: (e) =>
                    e.targetType ? (
                      <span>
                        {e.targetType} <ShortId id={e.targetId} />
                      </span>
                    ) : (
                      t('common.none')
                    ),
                },
                {
                  id: 'req',
                  header: t('audit.col.request'),
                  cell: (e) =>
                    e.requestId ? (
                      <code className="mono" title={e.requestId}>
                        {e.requestId.slice(0, 8)}
                      </code>
                    ) : (
                      t('common.none')
                    ),
                },
                {
                  id: 'meta',
                  header: t('audit.col.details'),
                  cell: (e) =>
                    e.metadata && Object.keys(e.metadata).length ? (
                      <details>
                        <summary>{t('audit.showDetails')}</summary>
                        <JsonFacts value={e.metadata} />
                      </details>
                    ) : (
                      <span className="muted">{t('common.none')}</span>
                    ),
                },
              ]}
            />
          )}
        </ListView>
        <p className="muted">{t('audit.note')}</p>
      </div>
    </>
  );
}
