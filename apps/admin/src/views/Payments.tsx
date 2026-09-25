'use client';

import { useState } from 'react';
import { Button, Checkbox, FormField, Input, Select } from '@yapilapi/ui';
import {
  isUnavailable,
  type StaffDispute,
  type StaffOrder,
  type StaffPayout,
  type StaffRefund,
  type StatusAgg,
  type Unavailable,
} from '@yapilapi/api-client';
import { useI18n } from '@/i18n';
import { useAdminApi } from '@/lib/api';
import { usePagedList, useResource } from '@/lib/hooks';
import { useAdmin } from '@/lib/session';
import { HBarChart } from '@/components/charts';
import { DataTable } from '@/components/DataTable';
import {
  ErrorNotice,
  Filters,
  ListView,
  MutationDialog,
  PageHeader,
  ResourceView,
  Section,
  ShortId,
  StatusBadge,
  SubNav,
  Time,
} from '@/components/common';

export type PaymentsTab =
  'overview' | 'orders' | 'refunds' | 'payouts' | 'disputes' | 'reconciliation';
export const PAYMENT_TABS: readonly PaymentsTab[] = [
  'overview',
  'orders',
  'refunds',
  'payouts',
  'disputes',
  'reconciliation',
];
const ORDER_STATUSES = [
  'pending_review',
  'pending_payment',
  'paid',
  'fulfilled',
  'completed',
  'cancelled',
  'refunded',
  'partially_refunded',
  'disputed',
] as const;

// ------------------------------------------------------------------ overview
function AggTable({
  caption,
  rows,
  amountKey,
}: {
  caption: string;
  rows: StatusAgg[] | Unavailable;
  amountKey: 'total_cents' | 'amount_cents';
}) {
  const { t, fmt } = useI18n();
  if (isUnavailable(rows))
    return <p className="muted">{t('payments.sectionUnavailable', { name: caption })}</p>;
  if (rows.length === 0) return <p className="muted">{t('payments.noneInPeriod')}</p>;
  return (
    <DataTable
      caption={caption}
      rows={rows}
      rowKey={(r) => `${r.status}-${r.currency}`}
      columns={[
        {
          id: 's',
          header: t('payments.col.status'),
          rowHeader: true,
          cell: (r) => <StatusBadge group="payStatus" value={r.status} />,
        },
        { id: 'c', header: t('payments.col.currency'), cell: (r) => r.currency },
        {
          id: 'n',
          header: t('payments.col.count'),
          numeric: true,
          cell: (r) => fmt.number(r.count),
        },
        {
          id: 'a',
          header: t('payments.col.amount'),
          numeric: true,
          cell: (r) => fmt.money(r[amountKey] ?? 0, r.currency),
        },
      ]}
    />
  );
}

function Overview() {
  const { t } = useI18n();
  const api = useAdminApi();
  const [days, setDays] = useState(30);
  const res = useResource((signal) => api.payments.summary(days, { signal }), [api, days]);
  return (
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
        {(s) => {
          const payments = isUnavailable(s.payments)
            ? []
            : s.payments.reduce<Record<string, number>>(
                (a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + r.count }),
                {},
              );
          return (
            <>
              <Section title={t('payments.chart.title')} description={t('payments.chart.desc')}>
                <HBarChart
                  title={t('payments.chart.byStatus')}
                  summary={t('payments.chart.summary', {
                    total: Object.values(payments).reduce((a, b) => a + b, 0),
                  })}
                  data={Object.entries(payments)
                    .sort((a, b) => b[1] - a[1])
                    .map(([k, v]) => ({ label: k, value: v }))}
                  valueHeader={t('payments.col.count')}
                />
              </Section>
              <div className="grid-2">
                <Section title={t('payments.orders')}>
                  <AggTable
                    caption={t('payments.orders')}
                    rows={s.orders}
                    amountKey="total_cents"
                  />
                </Section>
                <Section title={t('payments.payments')}>
                  <AggTable
                    caption={t('payments.payments')}
                    rows={s.payments}
                    amountKey="amount_cents"
                  />
                </Section>
                <Section title={t('payments.refunds')}>
                  <AggTable
                    caption={t('payments.refunds')}
                    rows={s.refunds}
                    amountKey="amount_cents"
                  />
                </Section>
                <Section title={t('payments.payouts')}>
                  <AggTable
                    caption={t('payments.payouts')}
                    rows={s.payouts}
                    amountKey="amount_cents"
                  />
                </Section>
              </div>
            </>
          );
        }}
      </ResourceView>
    </div>
  );
}

// ------------------------------------------------------------------ orders in review
function OrderDetail({ id }: { id: string }) {
  const { t, fmt, label } = useI18n();
  const api = useAdminApi();
  const res = useResource((signal) => api.payments.order(id, { signal }), [api, id]);
  return (
    <ResourceView resource={res} rows={2}>
      {({ order, fraudSignals }) => (
        <div className="stack-sm" data-testid="order-detail">
          <p>
            {t('payments.order.total', { total: fmt.money(order.totalCents, order.currency) })} ·{' '}
            <StatusBadge group="payStatus" value={order.status} />
          </p>
          <ul className="stack-sm">
            {order.items.map((i) => (
              <li key={i.id}>
                {i.quantity} × {i.title} — {fmt.money(i.lineTotalCents, order.currency)}
              </li>
            ))}
          </ul>
          {order.fraud ? (
            <p>
              {t('payments.order.fraud', {
                score: order.fraud.score ?? 0,
                decision: label('fraudDecision', order.fraud.decision),
                flags: (order.fraud.flags ?? []).join(', ') || t('common.none'),
              })}
            </p>
          ) : null}
          {fraudSignals.length ? (
            <ul className="stack-sm" aria-label={t('payments.order.signals')}>
              {fraudSignals.map((s, i) => (
                <li key={i}>
                  {s.stage}: {label('fraudDecision', s.decision)} ({s.score}){' '}
                  {(s.reasons ?? []).join(', ')}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </ResourceView>
  );
}

function Orders() {
  const { t, label, fmt } = useI18n();
  const api = useAdminApi();
  const [status, setStatus] = useState<string>('pending_review');
  const [target, setTarget] = useState<{ o: StaffOrder; decision: 'approve' | 'reject' } | null>(
    null,
  );
  const list = usePagedList<StaffOrder>(
    (cursor, signal) => api.payments.orders({ status, cursor, limit: 25, signal }),
    [api, status],
  );
  return (
    <div className="page-body">
      <Filters label={t('common.filters')}>
        <FormField label={t('payments.col.status')}>
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            {ORDER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {label('payStatus', s)}
              </option>
            ))}
          </Select>
        </FormField>
      </Filters>
      <ListView
        list={list}
        emptyTitle={t('payments.orders.emptyTitle')}
        emptyBody={t('payments.orders.emptyBody')}
      >
        {(items) => (
          <DataTable
            caption={t('payments.orders')}
            rows={items}
            rowKey={(o) => o.id}
            columns={[
              {
                id: 'id',
                header: t('payments.col.order'),
                rowHeader: true,
                cell: (o) => <ShortId id={o.id} />,
              },
              {
                id: 'buyer',
                header: t('payments.col.buyer'),
                cell: (o) => o.buyer?.username ?? <ShortId id={o.buyer?.id} />,
              },
              {
                id: 'total',
                header: t('payments.col.amount'),
                numeric: true,
                cell: (o) => fmt.money(o.totalCents, o.currency),
              },
              {
                id: 'status',
                header: t('payments.col.status'),
                cell: (o) => <StatusBadge group="payStatus" value={o.status} />,
              },
              {
                id: 'fraud',
                header: t('payments.col.fraud'),
                numeric: true,
                cell: (o) => o.fraud?.score ?? t('common.none'),
              },
              {
                id: 'created',
                header: t('payments.col.created'),
                cell: (o) => <Time value={o.createdAt} />,
              },
              {
                id: 'act',
                header: t('common.actions'),
                cell: (o) =>
                  o.status === 'pending_review' ? (
                    <div className="cell-actions">
                      <Button size="sm" onClick={() => setTarget({ o, decision: 'approve' })}>
                        {t('payments.order.approve')}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => setTarget({ o, decision: 'reject' })}
                      >
                        {t('payments.order.reject')}
                      </Button>
                    </div>
                  ) : null,
              },
            ]}
          />
        )}
      </ListView>
      {target ? (
        <MutationDialog
          open
          onClose={() => setTarget(null)}
          title={t(
            target.decision === 'approve'
              ? 'payments.order.approveTitle'
              : 'payments.order.rejectTitle',
          )}
          description={t(
            target.decision === 'approve'
              ? 'payments.order.approveDesc'
              : 'payments.order.rejectDesc',
          )}
          tone={target.decision === 'reject' ? 'danger' : 'primary'}
          submitLabel={t(
            target.decision === 'approve' ? 'payments.order.approve' : 'payments.order.reject',
          )}
          reasonLabel={t('payments.note')}
          reasonOptional
          {...(target.decision === 'reject' ? { confirmPhrase: target.o.id.slice(0, 8) } : {})}
          onSubmit={(note) =>
            api.payments.reviewOrder(target.o.id, {
              decision: target.decision,
              ...(note ? { note } : {}),
            })
          }
          successMessage={(r) => t('payments.order.done', { status: label('payStatus', r.status) })}
          onDone={() => {
            setTarget(null);
            list.reload();
          }}
        >
          <OrderDetail id={target.o.id} />
        </MutationDialog>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ refunds
function Refunds() {
  const { t, label, fmt } = useI18n();
  const api = useAdminApi();
  const [status, setStatus] = useState('requested');
  const [target, setTarget] = useState<{ r: StaffRefund; decision: 'approve' | 'deny' } | null>(
    null,
  );
  const [restock, setRestock] = useState(false);
  const list = usePagedList<StaffRefund>(
    (cursor, signal) => api.payments.refunds({ status, cursor, limit: 25, signal }),
    [api, status],
  );
  return (
    <div className="page-body">
      <Filters label={t('common.filters')}>
        <FormField label={t('payments.col.status')}>
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            {['requested', 'approved', 'processing', 'succeeded', 'failed', 'rejected'].map((s) => (
              <option key={s} value={s}>
                {label('payStatus', s)}
              </option>
            ))}
          </Select>
        </FormField>
      </Filters>
      <ListView
        list={list}
        emptyTitle={t('payments.refunds.emptyTitle')}
        emptyBody={t('payments.refunds.emptyBody')}
      >
        {(items) => (
          <DataTable
            caption={t('payments.refunds')}
            rows={items}
            rowKey={(r) => r.id}
            columns={[
              {
                id: 'id',
                header: t('payments.col.refund'),
                rowHeader: true,
                cell: (r) => <ShortId id={r.id} />,
              },
              {
                id: 'order',
                header: t('payments.col.order'),
                cell: (r) => <ShortId id={r.orderId} />,
              },
              {
                id: 'amount',
                header: t('payments.col.amount'),
                numeric: true,
                cell: (r) => fmt.money(r.amountCents, r.currency),
              },
              {
                id: 'reason',
                header: t('payments.col.reason'),
                cell: (r) => r.reason ?? t('common.none'),
              },
              {
                id: 'status',
                header: t('payments.col.status'),
                cell: (r) => <StatusBadge group="payStatus" value={r.status} />,
              },
              {
                id: 'created',
                header: t('payments.col.created'),
                cell: (r) => <Time value={r.createdAt} />,
              },
              {
                id: 'act',
                header: t('common.actions'),
                cell: (r) =>
                  r.status === 'requested' ? (
                    <div className="cell-actions">
                      <Button
                        size="sm"
                        onClick={() => {
                          setRestock(false);
                          setTarget({ r, decision: 'approve' });
                        }}
                      >
                        {t('payments.refund.approve')}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => setTarget({ r, decision: 'deny' })}
                      >
                        {t('payments.refund.deny')}
                      </Button>
                    </div>
                  ) : null,
              },
            ]}
          />
        )}
      </ListView>
      {target ? (
        <MutationDialog
          open
          onClose={() => setTarget(null)}
          title={t(
            target.decision === 'approve'
              ? 'payments.refund.approveTitle'
              : 'payments.refund.denyTitle',
            { amount: fmt.money(target.r.amountCents, target.r.currency) },
          )}
          description={t(
            target.decision === 'approve'
              ? 'payments.refund.approveDesc'
              : 'payments.refund.denyDesc',
          )}
          tone={target.decision === 'approve' ? 'danger' : 'primary'}
          submitLabel={t(
            target.decision === 'approve' ? 'payments.refund.approve' : 'payments.refund.deny',
          )}
          reasonLabel={t('payments.note')}
          reasonOptional
          {...(target.decision === 'approve' ? { confirmPhrase: target.r.id.slice(0, 8) } : {})}
          onSubmit={(note) =>
            api.payments.decideRefund(target.r.id, target.decision, {
              ...(note ? { note } : {}),
              ...(target.decision === 'approve' ? { restock } : {}),
            })
          }
          successMessage={(r) =>
            t('payments.refund.done', { status: label('payStatus', r.status) })
          }
          onDone={() => {
            setTarget(null);
            list.reload();
          }}
        >
          {target.decision === 'approve' ? (
            <Checkbox
              label={t('payments.refund.restock')}
              checked={restock}
              onChange={(e) => setRestock(e.target.checked)}
            />
          ) : null}
        </MutationDialog>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ payouts
function Payouts() {
  const { t, label, fmt } = useI18n();
  const api = useAdminApi();
  const [status, setStatus] = useState('');
  const [target, setTarget] = useState<{ p: StaffPayout; action: 'retry' | 'fail' } | null>(null);
  const list = usePagedList<StaffPayout>(
    (cursor, signal) =>
      api.payments.payouts({ status: status || undefined, cursor, limit: 25, signal }),
    [api, status],
  );
  return (
    <div className="page-body">
      <Filters label={t('common.filters')}>
        <FormField label={t('payments.col.status')}>
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">{t('common.any')}</option>
            {['pending', 'verifying', 'approved', 'paid', 'failed', 'held'].map((s) => (
              <option key={s} value={s}>
                {label('payStatus', s)}
              </option>
            ))}
          </Select>
        </FormField>
      </Filters>
      <ListView
        list={list}
        emptyTitle={t('payments.payouts.emptyTitle')}
        emptyBody={t('payments.payouts.emptyBody')}
      >
        {(items) => (
          <DataTable
            caption={t('payments.payouts')}
            rows={items}
            rowKey={(p) => p.id}
            columns={[
              {
                id: 'id',
                header: t('payments.col.payout'),
                rowHeader: true,
                cell: (p) => <ShortId id={p.id} />,
              },
              {
                id: 'payee',
                header: t('payments.col.payee'),
                cell: (p) => (
                  <>
                    {label('payeeType', p.payee.type)} <ShortId id={p.payee.id} />
                  </>
                ),
              },
              {
                id: 'amount',
                header: t('payments.col.amount'),
                numeric: true,
                cell: (p) => fmt.money(p.amountCents, p.currency),
              },
              {
                id: 'status',
                header: t('payments.col.status'),
                cell: (p) => <StatusBadge group="payStatus" value={p.status} />,
              },
              {
                id: 'fail',
                header: t('payments.col.failure'),
                cell: (p) => p.failureCode ?? t('common.none'),
              },
              {
                id: 'created',
                header: t('payments.col.created'),
                cell: (p) => <Time value={p.createdAt} />,
              },
              {
                id: 'act',
                header: t('common.actions'),
                cell: (p) =>
                  p.status === 'pending' || p.status === 'held' ? (
                    <div className="cell-actions">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setTarget({ p, action: 'retry' })}
                      >
                        {t('payments.payout.retry')}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => setTarget({ p, action: 'fail' })}
                      >
                        {t('payments.payout.fail')}
                      </Button>
                    </div>
                  ) : null,
              },
            ]}
          />
        )}
      </ListView>
      {target ? (
        <MutationDialog
          open
          onClose={() => setTarget(null)}
          title={t(
            target.action === 'retry' ? 'payments.payout.retryTitle' : 'payments.payout.failTitle',
            { amount: fmt.money(target.p.amountCents, target.p.currency) },
          )}
          description={t(
            target.action === 'retry' ? 'payments.payout.retryDesc' : 'payments.payout.failDesc',
          )}
          tone={target.action === 'fail' ? 'danger' : 'primary'}
          submitLabel={t(
            target.action === 'retry' ? 'payments.payout.retry' : 'payments.payout.fail',
          )}
          {...(target.action === 'fail'
            ? { reasonLabel: t('payments.reason'), confirmPhrase: target.p.id.slice(0, 8) }
            : {})}
          onSubmit={(reason) =>
            target.action === 'retry'
              ? api.payments.retryPayout(target.p.id)
              : api.payments.failPayout(target.p.id, reason)
          }
          successMessage={(r) =>
            t('payments.payout.done', { status: label('payStatus', r.status) })
          }
          onDone={() => {
            setTarget(null);
            list.reload();
          }}
        />
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ disputes
function Disputes() {
  const { t, label, fmt } = useI18n();
  const api = useAdminApi();
  const [status, setStatus] = useState('');
  const res = useResource(
    (signal) =>
      api.payments.disputes({
        status: (status || undefined) as 'open' | undefined,
        limit: 50,
        signal,
      }),
    [api, status],
  );
  return (
    <div className="page-body">
      <Filters label={t('common.filters')}>
        <FormField label={t('payments.col.status')}>
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">{t('common.any')}</option>
            {['open', 'won', 'lost'].map((s) => (
              <option key={s} value={s}>
                {label('payStatus', s)}
              </option>
            ))}
          </Select>
        </FormField>
      </Filters>
      <ResourceView
        resource={res}
        isEmpty={(d) => d.items.length === 0}
        emptyTitle={t('payments.disputes.emptyTitle')}
        emptyBody={t('payments.disputes.emptyBody')}
      >
        {(d) => (
          <DataTable
            caption={t('payments.disputes')}
            rows={d.items as StaffDispute[]}
            rowKey={(x) => x.id}
            columns={[
              {
                id: 'id',
                header: t('payments.col.dispute'),
                rowHeader: true,
                cell: (x) => <ShortId id={x.id} />,
              },
              {
                id: 'order',
                header: t('payments.col.order'),
                cell: (x) => <ShortId id={x.order_id} />,
              },
              {
                id: 'amount',
                header: t('payments.col.amount'),
                numeric: true,
                cell: (x) => fmt.money(x.amount_cents, x.currency),
              },
              {
                id: 'reason',
                header: t('payments.col.reason'),
                cell: (x) => x.reason ?? t('common.none'),
              },
              {
                id: 'status',
                header: t('payments.col.status'),
                cell: (x) => <StatusBadge group="payStatus" value={x.status} />,
              },
              { id: 'prov', header: t('payments.col.provider'), cell: (x) => x.provider },
              {
                id: 'opened',
                header: t('payments.col.opened'),
                cell: (x) => <Time value={x.opened_at} />,
              },
              {
                id: 'closed',
                header: t('payments.col.closed'),
                cell: (x) => <Time value={x.closed_at} />,
              },
            ]}
          />
        )}
      </ResourceView>
    </div>
  );
}

// ------------------------------------------------------------------ reconciliation
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

function Reconciliation() {
  const { t, fmt } = useI18n();
  const api = useAdminApi();
  const [from, setFrom] = useState(() => isoDay(new Date(Date.now() - 7 * 86_400_000)));
  const [to, setTo] = useState(() => isoDay(new Date()));
  const [run, setRun] = useState<{ from: string; to: string; n: number } | null>(null);
  const [unprocessed, setUnprocessed] = useState(false);
  const report = useResource(
    async (signal) =>
      run ? api.payments.reconciliation({ from: run.from, to: run.to }, { signal }) : null,
    [api, run],
  );
  const hooks = useResource(
    (signal) => api.payments.webhookEvents({ unprocessed, limit: 50, signal }),
    [api, unprocessed],
  );
  const valid = from !== '' && to !== '' && from <= to;
  return (
    <div className="page-body">
      <Section title={t('payments.recon.title')} description={t('payments.recon.desc')}>
        <div className="stack">
          <Filters
            label={t('payments.recon.title')}
            onSubmit={() => {
              if (valid)
                setRun((r) => ({
                  from: `${from}T00:00:00.000Z`,
                  to: to === isoDay(new Date()) ? new Date().toISOString() : `${to}T23:59:59.000Z`,
                  n: (r?.n ?? 0) + 1,
                }));
            }}
          >
            <FormField label={t('payments.recon.from')}>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} max={to} />
            </FormField>
            <FormField label={t('payments.recon.to')}>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} min={from} />
            </FormField>
            <Button
              type="submit"
              disabled={!valid}
              loading={report.loading && run !== null}
              loadingLabel={t('common.working')}
            >
              {t('payments.recon.run')}
            </Button>
          </Filters>
          {run ? (
            <ResourceView resource={report}>
              {(r) =>
                r && (
                  <div className="stack" data-testid="recon-report">
                    <p role="status">
                      {r.ok ? (
                        <StatusBadge group="recon" value="ok" />
                      ) : (
                        <StatusBadge group="recon" value="attention" />
                      )}{' '}
                      {t('payments.recon.summary', {
                        provider: r.provider,
                        matched: r.matched,
                        provider_records: r.providerRecords,
                        ledger_records: r.ledgerRecords,
                      })}
                    </p>
                    <h3 className="panel__title">
                      {t('payments.recon.discrepancies', { count: r.discrepancies.length })}
                    </h3>
                    {r.discrepancies.length === 0 ? (
                      <p className="muted">{t('payments.recon.noDiscrepancies')}</p>
                    ) : (
                      <ul className="stack-sm">
                        {r.discrepancies.map((d, i) => (
                          <li key={i}>
                            <pre className="json">{JSON.stringify(d, null, 2)}</pre>
                          </li>
                        ))}
                      </ul>
                    )}
                    <h3 className="panel__title">
                      {t('payments.recon.integrity', { count: r.integrity.length })}
                    </h3>
                    {r.integrity.length === 0 ? (
                      <p className="muted">{t('payments.recon.noIntegrity')}</p>
                    ) : (
                      <DataTable
                        caption={t('payments.recon.integrityCaption')}
                        rows={r.integrity}
                        rowKey={(x) => `${x.type}-${x.ref}`}
                        columns={[
                          {
                            id: 't',
                            header: t('payments.recon.type'),
                            rowHeader: true,
                            cell: (x) => x.type,
                          },
                          {
                            id: 'r',
                            header: t('payments.recon.ref'),
                            cell: (x) => <code className="mono">{x.ref}</code>,
                          },
                          { id: 'd', header: t('payments.recon.detail'), cell: (x) => x.detail },
                        ]}
                      />
                    )}
                    <p className="muted">
                      {t('payments.recon.window', {
                        from: fmt.dateTime(r.from),
                        to: fmt.dateTime(r.to),
                      })}
                    </p>
                  </div>
                )
              }
            </ResourceView>
          ) : null}
        </div>
      </Section>
      <Section title={t('payments.webhooks.title')} description={t('payments.webhooks.desc')}>
        <div className="stack">
          <Checkbox
            label={t('payments.webhooks.unprocessed')}
            checked={unprocessed}
            onChange={(e) => setUnprocessed(e.target.checked)}
          />
          <ResourceView
            resource={hooks}
            isEmpty={(d) => d.items.length === 0}
            emptyTitle={t('payments.webhooks.emptyTitle')}
            emptyBody={t('payments.webhooks.emptyBody')}
          >
            {(d) => (
              <DataTable
                caption={t('payments.webhooks.title')}
                rows={d.items}
                rowKey={(x) => x.id}
                columns={[
                  {
                    id: 'type',
                    header: t('payments.webhooks.type'),
                    rowHeader: true,
                    cell: (x) => x.event_type,
                  },
                  { id: 'prov', header: t('payments.col.provider'), cell: (x) => x.provider },
                  {
                    id: 'sig',
                    header: t('payments.webhooks.signature'),
                    cell: (x) => (x.signature_valid ? t('common.yes') : t('common.no')),
                  },
                  {
                    id: 'rec',
                    header: t('payments.webhooks.received'),
                    cell: (x) => <Time value={x.received_at} />,
                  },
                  {
                    id: 'proc',
                    header: t('payments.webhooks.processed'),
                    cell: (x) => <Time value={x.processed_at} />,
                  },
                  {
                    id: 'err',
                    header: t('payments.webhooks.error'),
                    cell: (x) => x.error ?? t('common.none'),
                  },
                ]}
              />
            )}
          </ResourceView>
        </div>
      </Section>
      {report.error && run === null ? <ErrorNotice error={report.error} /> : null}
    </div>
  );
}

export function PaymentsView({ tab }: { tab: PaymentsTab }) {
  const { t } = useI18n();
  const { atLeast } = useAdmin();
  const finance = atLeast('admin');
  const items = PAYMENT_TABS.filter((x) => x === 'overview' || finance).map((x) => ({
    id: x,
    href: x === 'overview' ? '/payments' : `/payments/${x}`,
    label: t(`payments.tab.${x}`),
  }));
  return (
    <>
      <PageHeader
        title={t('payments.title')}
        lead={finance ? t('payments.lead') : t('payments.leadReadOnly')}
      />
      <SubNav label={t('payments.nav')} items={items} current={tab} />
      {tab === 'overview' ? (
        <Overview />
      ) : !finance ? null : tab === 'orders' ? (
        <Orders />
      ) : tab === 'refunds' ? (
        <Refunds />
      ) : tab === 'payouts' ? (
        <Payouts />
      ) : tab === 'disputes' ? (
        <Disputes />
      ) : (
        <Reconciliation />
      )}
    </>
  );
}
