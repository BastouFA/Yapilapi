'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Badge, Card, EmptyState } from '@yapilapi/design-system';
import type { AdminMoney } from '@yapilapi/api-client';
import { formatMoney, formatRelativeTime, type AdminPeriod } from '@yapilapi/shared';
import { useSession } from '@/app/providers';
import { api } from '@/lib/api';
import { formatCount, LoadFailed, Loading, PeriodChoice, useLoad } from './shared';

/**
 * Money in over 7, 30 or 90 days: what YAPILAPI kept, what creators are owed now, orders by status, payments by
 * provider, refunds, and the newest orders.
 */
export function Payments() {
  const { t, locale } = useSession();
  const [days, setDays] = useState<AdminPeriod>(30);
  const { data, error, reload } = useLoad(() => api.admin.payments(days), [days]);
  return (
    <div className="stack">
      <PeriodChoice value={days} onChange={setDays} />
      {error ? (
        <LoadFailed error={error} onRetry={reload} />
      ) : !data ? (
        <Loading />
      ) : (
        <>
          <Card title={t('admin.payments.kept')} subtitle={t('admin.payments.keptHint')}>
            <Figures
              label={t('admin.payments.kept')}
              columns={[t('admin.payments.fees'), t('admin.payments.plus'), t('admin.payments.ads'), t('admin.payments.processing'), t('admin.payments.net')]}
              rows={data.income.map((r) => ({
                currency: r.currency,
                cells: [r.feesCents, r.plusCents, r.adsCents, r.processingCents ? -r.processingCents : 0, r.netCents],
              }))}
            />
          </Card>
          <Card title={t('admin.payments.owed')} subtitle={t('admin.payments.owedHint')}>
            <Figures
              label={t('admin.payments.owed')}
              columns={[t('admin.payments.held'), t('admin.payments.available'), t('admin.payments.inFlight'), t('admin.payments.paidOut')]}
              rows={data.owed.map((r) => ({ currency: r.currency, cells: [r.heldCents, r.availableCents, r.inFlightCents, r.paidOutCents] }))}
            />
          </Card>
          <Card title={t('admin.payments.byStatus')}>
            <MoneyTable
              rows={data.byStatus.map((r) => ({ key: `${r.status}-${r.currency}`, label: r.status.replace(/_/g, ' '), ...r }))}
              label={t('admin.payments.status')}
            />
          </Card>
          <Card title={t('admin.payments.byProvider')}>
            <MoneyTable
              rows={data.byProvider.map((r) => ({
                key: `${r.provider}-${r.status}-${r.currency}`,
                label: `${r.provider} · ${r.status.replace(/_/g, ' ')}`,
                ...r,
              }))}
              label={t('admin.payments.provider')}
            />
          </Card>
          <Card title={t('admin.payments.refunds')}>
            <MoneyTable rows={data.refunds.map((r) => ({ key: `${r.status}-${r.currency}`, label: r.status, ...r }))} label={t('admin.payments.status')} />
          </Card>
          <Card title={t('admin.payments.recent')}>
            {!data.recent.length ? (
              <p className="muted">{t('admin.payments.none')}</p>
            ) : (
              <div className="table-wrap" tabIndex={0} role="region" aria-label={t('admin.payments.recent')}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('admin.audit.when')}</th>
                      <th>{t('admin.payments.amount')}</th>
                      <th>{t('admin.payments.status')}</th>
                      <th>{t('admin.payments.buyer')}</th>
                      <th>{t('admin.payments.seller')}</th>
                      <th>{t('admin.payments.what')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recent.map((o) => (
                      <tr key={o.id}>
                        <td>{formatRelativeTime(o.createdAt, locale)}</td>
                        <td style={{ fontVariantNumeric: 'tabular-nums' }}>{formatMoney(o.amountCents, o.currency, locale)}</td>
                        <td>
                          <Badge tone={o.status === 'paid' ? 'success' : o.status === 'failed' ? 'danger' : 'neutral'}>{o.status.replace(/_/g, ' ')}</Badge>
                        </td>
                        <td>{o.buyer ? <Link href={`/admin/users/${o.buyer.id}`}>@{o.buyer.username}</Link> : '—'}</td>
                        <td>{o.seller ? <Link href={`/admin/users/${o.seller.id}`}>@{o.seller.username}</Link> : t('admin.payments.platform')}</td>
                        <td>
                          {o.purpose.replace(/_/g, ' ')}
                          {o.provider ? <span className="muted"> · {o.provider}</span> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

function MoneyTable({ rows, label }: { rows: (AdminMoney & { key: string; label: string })[]; label: string }) {
  const { t, locale } = useSession();
  if (!rows.length) return <EmptyState title={t('admin.payments.none')} />;
  return (
    <div className="table-wrap" tabIndex={0} role="region" aria-label={label}>
      <table className="table">
        <thead>
          <tr>
            <th>{label}</th>
            <th>{t('admin.payments.currency')}</th>
            <th>{t('admin.overview.count')}</th>
            <th>{t('admin.payments.gross')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{r.label}</td>
              <td>{r.currency}</td>
              <td style={{ fontVariantNumeric: 'tabular-nums' }}>{formatCount(r.count, locale)}</td>
              <td style={{ fontVariantNumeric: 'tabular-nums' }}>{formatMoney(r.cents, r.currency, locale)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Amounts per currency, one column each; the last column is the one that matters, so it's bold. */
function Figures({ label, columns, rows }: { label: string; columns: string[]; rows: { currency: string; cells: number[] }[] }) {
  const { t, locale } = useSession();
  if (!rows.length) return <EmptyState title={t('admin.payments.none')} />;
  return (
    <div className="table-wrap" tabIndex={0} role="region" aria-label={label}>
      <table className="table">
        <thead>
          <tr>
            <th>{t('admin.payments.currency')}</th>
            {columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.currency}>
              <td>{r.currency}</td>
              {r.cells.map((cents, i) => (
                <td key={columns[i]} style={{ fontVariantNumeric: 'tabular-nums', fontWeight: i === r.cells.length - 1 ? 700 : undefined }}>
                  {formatMoney(cents, r.currency, locale)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
