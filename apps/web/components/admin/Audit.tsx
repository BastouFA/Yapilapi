'use client';

import Link from 'next/link';
import { Fragment, useEffect, useState } from 'react';
import { Button, EmptyState, TextField } from '@yapilapi/design-system';
import type { AuditLogEntry, AuditLogFilters } from '@yapilapi/api-client';
import { useSession } from '@/app/providers';
import { api, errorMessage } from '@/lib/api';
import { formatWhen, LoadFailed, Loading, prettyJson } from './shared';

const EMPTY: AuditLogFilters = { action: '', actor: '', entityType: '', from: '', to: '' };

/** The audit trail: filter it by what, who, what it was about and when; open a row for its details and address. */
export function Audit() {
  const { t, toast, locale } = useSession();
  const [form, setForm] = useState<AuditLogFilters>(EMPTY);
  const [filters, setFilters] = useState<AuditLogFilters>(EMPTY);
  const [items, setItems] = useState<AuditLogEntry[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const clean = (f: AuditLogFilters) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));

  useEffect(() => {
    let live = true;
    setItems(null);
    setError(null);
    api.admin.auditLogs(clean(filters)).then(
      (r) => {
        if (!live) return;
        setItems(r.items);
        setCursor(r.nextCursor);
      },
      (e) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [filters, attempt]);

  const more = async () => {
    if (!cursor) return;
    try {
      const r = await api.admin.auditLogs({ ...clean(filters), cursor });
      setItems((cur) => [...(cur ?? []), ...r.items]);
      setCursor(r.nextCursor);
    } catch (e) {
      toast(errorMessage(e));
    }
  };
  const field = (k: keyof AuditLogFilters) => ({
    value: form[k] ?? '',
    onChange: (e: { currentTarget: { value: string } }) => setForm({ ...form, [k]: e.currentTarget.value }),
  });

  return (
    <div className="stack">
      <form
        className="admin-filters"
        aria-label={t('admin.audit.filters')}
        onSubmit={(e) => {
          e.preventDefault();
          setFilters(form);
        }}
      >
        <TextField label={t('admin.audit.action')} hint={t('admin.audit.actionHint')} maxLength={100} {...field('action')} />
        <TextField label={t('admin.audit.actor')} hint={t('admin.audit.actorHint')} maxLength={100} {...field('actor')} />
        <TextField label={t('admin.audit.entityType')} hint={t('admin.audit.entityTypeHint')} maxLength={50} {...field('entityType')} />
        <TextField label={t('admin.audit.from')} type="date" {...field('from')} />
        <TextField label={t('admin.audit.to')} type="date" {...field('to')} />
        <div className="row admin-filters__buttons">
          <Button type="submit">{t('admin.audit.apply')}</Button>
          <Button
            variant="ghost"
            onClick={() => {
              setForm(EMPTY);
              setFilters(EMPTY);
            }}
          >
            {t('admin.audit.clear')}
          </Button>
        </div>
      </form>
      {error ? (
        <LoadFailed error={error} onRetry={() => setAttempt((n) => n + 1)} />
      ) : items === null ? (
        <Loading />
      ) : !items.length ? (
        <EmptyState title={t('admin.audit.none')} />
      ) : (
        // It scrolls sideways on a phone, so it can be focused and scrolled with the arrow keys.
        <div className="table-wrap" tabIndex={0} role="region" aria-label={t('admin.tab.audit')}>
          <table className="table">
            <thead>
              <tr>
                <th>{t('admin.audit.when')}</th>
                <th>{t('admin.audit.action')}</th>
                <th>{t('admin.audit.entity')}</th>
                <th>{t('admin.audit.actor')}</th>
                <th>
                  <span className="yp-visually-hidden">{t('admin.audit.details')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((l) => {
                const expanded = open === l.id;
                return (
                  <Fragment key={l.id}>
                    <tr>
                      <td>{formatWhen(l.created_at, locale)}</td>
                      <td>
                        <code>{l.action}</code>
                      </td>
                      <td>
                        {l.entity_type === 'user' && l.entity_id ? (
                          <Link href={`/admin/users/${l.entity_id}`}>
                            {l.entity_type} {l.entity_id.slice(0, 8)}
                          </Link>
                        ) : (
                          <>
                            {l.entity_type} {l.entity_id?.slice(0, 8)}
                          </>
                        )}
                      </td>
                      <td>{l.actor_username ? `@${l.actor_username}` : (l.actor_id?.slice(0, 8) ?? t('admin.audit.system'))}</td>
                      <td>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-expanded={expanded}
                          aria-controls={`audit-${l.id}`}
                          onClick={() => setOpen(expanded ? null : l.id)}
                        >
                          {expanded ? t('admin.audit.hide') : t('admin.audit.details')}
                        </Button>
                      </td>
                    </tr>
                    {expanded ? (
                      <tr id={`audit-${l.id}`}>
                        <td colSpan={5}>
                          <dl className="admin-facts">
                            <div>
                              <dt>{t('admin.audit.ip')}</dt>
                              <dd>{l.ip ?? '—'}</dd>
                            </div>
                            <div>
                              <dt>{t('admin.audit.request')}</dt>
                              <dd>
                                <code>{l.request_id ?? '—'}</code>
                              </dd>
                            </div>
                            <div>
                              <dt>{t('admin.audit.entityId')}</dt>
                              <dd>
                                <code>{l.entity_id ?? '—'}</code>
                              </dd>
                            </div>
                          </dl>
                          <pre className="admin-json">{prettyJson(l.metadata)}</pre>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {cursor && items?.length ? (
        <Button variant="secondary" onClick={more}>
          {t('admin.loadMore')}
        </Button>
      ) : null}
    </div>
  );
}
