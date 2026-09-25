'use client';

import { useState } from 'react';
import type {
  AffiliateLinkStats,
  CreatorPlan,
  CreatorSubscriber,
  CreatorSubscription,
  Partnership,
} from '@yapilapi/api-client';
import {
  Button,
  Card,
  FeedTabs,
  FormField,
  Input,
  Select,
  Switch,
  Textarea,
  useToast,
} from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useAsync, usePageTitle } from '@/lib/hooks';
import { describeError } from '@/lib/errors';
import { useSession } from '@/lib/session';
import { PageHeader } from '@/components/PageHeader';
import { ErrorView, PageSpinner, ConfirmDialog } from '@/components/common';

type Tab =
  | 'overview'
  | 'plans'
  | 'subscribers'
  | 'subscriptions'
  | 'payouts'
  | 'revenue'
  | 'supporters'
  | 'affiliate'
  | 'partnerships';

const KYC_KEYS = {
  unverified: 'creator.kyc.status.unverified',
  pending: 'creator.kyc.status.pending',
  verified: 'creator.kyc.status.verified',
  rejected: 'creator.kyc.status.rejected',
} as const;
const CREATOR_STATUS_KEYS = {
  active: 'creator.overview.status.active',
  suspended: 'creator.overview.status.suspended',
  closed: 'creator.overview.status.closed',
} as const;
const SUB_STATUS_KEYS = {
  incomplete: 'creator.subscriptions.status.incomplete',
  active: 'creator.subscriptions.status.active',
  past_due: 'creator.subscriptions.status.past_due',
  cancelled: 'creator.subscriptions.status.cancelled',
  expired: 'creator.subscriptions.status.expired',
} as const;
const PAYOUT_STATUS_KEYS = {
  pending: 'creator.payouts.status.pending',
  verifying: 'creator.payouts.status.verifying',
  approved: 'creator.payouts.status.approved',
  paid: 'creator.payouts.status.paid',
  failed: 'creator.payouts.status.failed',
  held: 'creator.payouts.status.held',
} as const;
const PARTNERSHIP_STATUS_KEYS = {
  proposed: 'creator.partnerships.status.proposed',
  negotiating: 'creator.partnerships.status.negotiating',
  accepted: 'creator.partnerships.status.accepted',
  in_progress: 'creator.partnerships.status.in_progress',
  delivered: 'creator.partnerships.status.delivered',
  paid: 'creator.partnerships.status.paid',
  declined: 'creator.partnerships.status.declined',
  cancelled: 'creator.partnerships.status.cancelled',
} as const;

const CURRENT_TERMS_VERSION = '2027-01';

// ------------------------------------------------------------------ overview
function OverviewPanel() {
  const api = useApi();
  const { t, fmt } = useI18n();
  const { isTeen } = useSession();
  const toast = useToast();
  const me = useAsync((signal) => api.creator.me({ signal }), [api]);
  const [category, setCategory] = useState('');
  const [country, setCountry] = useState('US');
  const [busy, setBusy] = useState(false);

  const fail = (e: unknown) =>
    toast.show({
      tone: 'danger',
      title: t('error.actionFailed'),
      description: describeError(e, t).message,
    });

  const join = async () => {
    setBusy(true);
    try {
      await api.creator.join({
        termsVersion: CURRENT_TERMS_VERSION,
        category: category.trim() || undefined,
      });
      toast.show({ tone: 'success', title: t('creator.overview.joined') });
      me.reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const switchMode = async (mode: 'creator' | 'personal') => {
    setBusy(true);
    try {
      await api.creator.setMode(mode);
      toast.show({ tone: 'success', title: t('creator.overview.modeSwitched') });
      me.reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const submitKyc = async () => {
    setBusy(true);
    try {
      const r = await api.creator.submitKyc({ country: country.trim().toUpperCase() });
      toast.show({ tone: 'success', title: t('creator.kyc.submitted') });
      me.reload();
      if (r.onboardingUrl) window.open(r.onboardingUrl, '_blank', 'noopener');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  if (me.loading) return <PageSpinner />;
  if (me.error) return <ErrorView error={me.error} onRetry={me.reload} />;
  const d = me.data;
  if (!d) return null;

  if (isTeen) return <p className="muted">{t('creator.overview.teenBlocked')}</p>;

  if (!d.creator) {
    return (
      <Card padding="md" className="stack-sm">
        <h3 className="section-title">{t('creator.overview.notCreator.title')}</h3>
        <p className="muted">{t('creator.overview.notCreator.body')}</p>
        <p className="muted">
          {t('creator.overview.termsVersion', { version: d.currentTermsVersion })}
        </p>
        <FormField
          label={t('creator.plans.name')}
          description={t('creator.overview.notCreator.body')}
        >
          <Input
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="e.g. music"
          />
        </FormField>
        <Button loading={busy} onClick={() => void join()}>
          {t('creator.overview.join')}
        </Button>
      </Card>
    );
  }

  const c = d.creator;
  const needsTerms = c.termsVersion !== d.currentTermsVersion;

  return (
    <div className="stack">
      <Card padding="md" className="stack-sm">
        <h3 className="section-title">{t('creator.overview.status')}</h3>
        <p>
          {c.status in CREATOR_STATUS_KEYS
            ? t(CREATOR_STATUS_KEYS[c.status as keyof typeof CREATOR_STATUS_KEYS])
            : c.status}
        </p>
        {needsTerms ? (
          <>
            <p className="muted">{t('creator.overview.termsOutdated')}</p>
            <Button size="sm" loading={busy} onClick={() => void join()}>
              {t('creator.overview.acceptTerms', { version: d.currentTermsVersion })}
            </Button>
          </>
        ) : null}
        <FormField label={t('creator.overview.mode')} description={t('creator.overview.modeHelp')}>
          <Select
            value={c.mode ?? 'personal'}
            disabled={busy}
            onChange={(e) => void switchMode(e.target.value as 'creator' | 'personal')}
          >
            <option value="creator">{t('creator.overview.mode.creator')}</option>
            <option value="personal">{t('creator.overview.mode.personal')}</option>
          </Select>
        </FormField>
      </Card>

      <Card padding="md" className="stack-sm">
        <h3 className="section-title">{t('creator.kyc.title')}</h3>
        <p>
          {t(KYC_KEYS[c.kycStatus])}
          {c.kycStatus === 'rejected' && c.kycNote
            ? ` — ${t('creator.kyc.rejectedNote', { note: c.kycNote })}`
            : ''}
        </p>
        <p>
          {d.payoutAccount?.payoutsEnabled
            ? t('creator.payoutAccount.enabled')
            : d.payoutAccount
              ? t('creator.payoutAccount.disabled')
              : t('creator.payoutAccount.none')}
        </p>
        {c.kycStatus !== 'verified' && c.kycStatus !== 'pending' ? (
          <>
            <p className="muted">{t('creator.kyc.body')}</p>
            <FormField label={t('creator.kyc.country')}>
              <Input value={country} maxLength={2} onChange={(e) => setCountry(e.target.value)} />
            </FormField>
            <Button size="sm" loading={busy} onClick={() => void submitKyc()}>
              {t('creator.kyc.submit')}
            </Button>
          </>
        ) : null}
        <h4 className="section-title">{t('creator.kyc.history')}</h4>
        {d.verification.length === 0 ? (
          <p className="muted">{t('creator.kyc.historyEmpty')}</p>
        ) : (
          <ul className="stack-sm">
            {d.verification.map((v, i) => (
              <li key={i} className="muted">
                {t('creator.kyc.event', { from: v.from, to: v.to, by: v.by })}
                {' · '}
                {fmt.dateTime(v.at)}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ plans
function PlansPanel() {
  const api = useApi();
  const { t, fmt } = useI18n();
  const toast = useToast();
  const state = useAsync((signal) => api.creator.plans({ signal }), [api]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [priceCents, setPriceCents] = useState('500');
  const [currency, setCurrency] = useState('USD');
  const [interval, setInterval] = useState<'month' | 'year'>('month');
  const [tier, setTier] = useState('1');
  const [benefits, setBenefits] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    try {
      await api.creator.createPlan({
        name: name.trim(),
        description: description.trim(),
        priceCents: Math.round(Number(priceCents)) || 100,
        currency: currency.trim().toUpperCase(),
        interval,
        tier: Math.round(Number(tier)) || 1,
        benefits: benefits
          .split('\n')
          .map((b) => b.trim())
          .filter(Boolean),
      });
      toast.show({ tone: 'success', title: t('creator.plans.created') });
      setName('');
      setDescription('');
      setBenefits('');
      state.reload();
    } catch (e) {
      toast.show({
        tone: 'danger',
        title: t('error.actionFailed'),
        description: describeError(e, t).message,
      });
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async (p: CreatorPlan) => {
    setBusyId(p.id);
    try {
      await api.creator.updatePlan(p.id, { active: !p.active });
      toast.show({ tone: 'success', title: t('creator.plans.updated') });
      state.reload();
    } catch (e) {
      toast.show({
        tone: 'danger',
        title: t('error.actionFailed'),
        description: describeError(e, t).message,
      });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="stack">
      <Card padding="md" className="stack-sm">
        <h3 className="section-title">{t('creator.plans.new')}</h3>
        <FormField label={t('creator.plans.name')} required>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </FormField>
        <FormField label={t('creator.plans.description')}>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
        </FormField>
        <FormField label={t('creator.plans.price')}>
          <Input
            type="number"
            min={100}
            value={priceCents}
            onChange={(e) => setPriceCents(e.target.value)}
          />
        </FormField>
        <FormField label={t('creator.plans.currency')}>
          <Input
            value={currency}
            maxLength={3}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
          />
        </FormField>
        <FormField label={t('creator.plans.interval')}>
          <Select
            value={interval}
            onChange={(e) => setInterval(e.target.value as 'month' | 'year')}
          >
            <option value="month">{t('creator.plans.interval.month')}</option>
            <option value="year">{t('creator.plans.interval.year')}</option>
          </Select>
        </FormField>
        <FormField label={t('creator.plans.tier')} description={t('creator.plans.priceImmutable')}>
          <Input
            type="number"
            min={1}
            max={10}
            value={tier}
            onChange={(e) => setTier(e.target.value)}
          />
        </FormField>
        <FormField label={t('creator.plans.benefits')}>
          <Textarea value={benefits} onChange={(e) => setBenefits(e.target.value)} rows={3} />
        </FormField>
        <Button loading={busy} onClick={() => void create()}>
          {t('creator.plans.create')}
        </Button>
      </Card>

      {state.loading ? <PageSpinner /> : null}
      {state.error ? <ErrorView error={state.error} onRetry={state.reload} /> : null}
      {state.data && state.data.items.length === 0 ? (
        <p className="muted">{t('creator.plans.empty')}</p>
      ) : null}
      {state.data && state.data.items.length > 0 ? (
        <ul className="stack-sm">
          {state.data.items.map((p) => (
            <li key={p.id} className="search-row">
              <span className="search-row__text">
                <span>{p.name}</span>
                <span className="muted">
                  {fmt.currency(p.priceCents / 100, p.currency)} /{' '}
                  {t(`creator.plans.interval.${p.interval}`)}
                  {' · '}
                  {t('creator.plans.tier')} {p.tier}
                  {' · '}
                  {p.active ? t('creator.plans.active') : t('creator.plans.inactive')}
                </span>
              </span>
              <Button
                size="sm"
                variant="ghost"
                loading={busyId === p.id}
                onClick={() => void toggleActive(p)}
              >
                {p.active ? t('creator.plans.deactivate') : t('creator.plans.activate')}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ subscribers
function SubscribersPanel() {
  const api = useApi();
  const { t, fmt } = useI18n();
  const toast = useToast();
  const [status, setStatus] = useState('');
  const state = useAsync(
    (signal) => api.creator.subscribers({ status: status || undefined, signal }),
    [api, status],
  );
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    if (!removeId) return;
    setBusy(true);
    try {
      await api.creator.removeSubscriber(removeId);
      toast.show({ tone: 'success', title: t('creator.subscribers.removed') });
      setRemoveId(null);
      state.reload();
    } catch (e) {
      toast.show({
        tone: 'danger',
        title: t('error.actionFailed'),
        description: describeError(e, t).message,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <FormField label={t('creator.subscribers.filter.all')}>
        <Select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t('creator.subscribers.filter.all')}</option>
          <option value="active">{t('creator.subscribers.filter.active')}</option>
          <option value="past_due">{t('creator.subscribers.filter.pastDue')}</option>
          <option value="cancelled">{t('creator.subscribers.filter.cancelled')}</option>
          <option value="expired">{t('creator.subscribers.filter.expired')}</option>
        </Select>
      </FormField>

      {state.loading ? <PageSpinner /> : null}
      {state.error ? <ErrorView error={state.error} onRetry={state.reload} /> : null}
      {state.data && state.data.items.length === 0 ? (
        <p className="muted">{t('creator.subscribers.empty')}</p>
      ) : null}
      {state.data && state.data.items.length > 0 ? (
        <ul className="stack-sm">
          {state.data.items.map((s: CreatorSubscriber) => (
            <li key={s.id} className="search-row">
              <span className="search-row__text">
                <span>{s.username}</span>
                <span className="muted">
                  {t('creator.subscribers.tier', { tier: s.tier, plan: s.plan })}
                  {' · '}
                  {s.status}
                  {' · '}
                  {s.startedAt
                    ? t('creator.subscribers.since', { date: fmt.dateTime(s.startedAt) })
                    : null}
                </span>
              </span>
              {s.status === 'active' || s.status === 'past_due' ? (
                <Button size="sm" variant="ghost" onClick={() => setRemoveId(s.id)}>
                  {t('creator.subscribers.remove')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      <ConfirmDialog
        open={removeId !== null}
        title={t('creator.subscribers.removeConfirm.title')}
        description={t('creator.subscribers.removeConfirm.body')}
        confirmLabel={t('creator.subscribers.remove')}
        danger
        busy={busy}
        onConfirm={() => void remove()}
        onClose={() => setRemoveId(null)}
      />
    </div>
  );
}

// ------------------------------------------------------------------ my subscriptions (fan side)
function SubscriptionsPanel() {
  const api = useApi();
  const { t, fmt } = useI18n();
  const toast = useToast();
  const state = useAsync((signal) => api.creator.mySubscriptions({ signal }), [api]);
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [immediately, setImmediately] = useState(false);
  const [busy, setBusy] = useState(false);

  const fail = (e: unknown) =>
    toast.show({
      tone: 'danger',
      title: t('error.actionFailed'),
      description: describeError(e, t).message,
    });

  const cancel = async () => {
    if (!cancelId) return;
    setBusy(true);
    try {
      await api.creator.cancelSubscription(cancelId, { immediately });
      toast.show({ tone: 'success', title: t('creator.subscriptions.cancelled') });
      setCancelId(null);
      setImmediately(false);
      state.reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const resume = async (id: string) => {
    setBusy(true);
    try {
      await api.creator.resumeSubscription(id);
      toast.show({ tone: 'success', title: t('creator.subscriptions.resumed') });
      state.reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  if (state.loading) return <PageSpinner />;
  if (state.error) return <ErrorView error={state.error} onRetry={state.reload} />;
  const items = state.data?.items ?? [];

  return (
    <div className="stack">
      {items.length === 0 ? <p className="muted">{t('creator.subscriptions.empty')}</p> : null}
      {items.length > 0 ? (
        <ul className="stack-sm">
          {items.map((s: CreatorSubscription) => (
            <li key={s.id} className="search-row">
              <span className="search-row__text">
                <span>{s.planName}</span>
                <span className="muted">
                  {t(SUB_STATUS_KEYS[s.status])}
                  {' · '}
                  {fmt.currency(s.priceCents / 100, s.currency)} / {s.interval}
                  {' · '}
                  {s.cancelAtPeriodEnd
                    ? t('creator.subscriptions.cancelAtPeriodEnd', {
                        date: fmt.dateTime(s.currentPeriodEnd),
                      })
                    : t('creator.subscriptions.renewsAt', {
                        date: fmt.dateTime(s.currentPeriodEnd),
                      })}
                </span>
              </span>
              {(s.status === 'active' || s.status === 'past_due') && !s.cancelAtPeriodEnd ? (
                <Button size="sm" variant="ghost" onClick={() => setCancelId(s.id)}>
                  {t('creator.subscriptions.cancel')}
                </Button>
              ) : null}
              {(s.status === 'active' || s.status === 'past_due') && s.cancelAtPeriodEnd ? (
                <Button size="sm" variant="ghost" loading={busy} onClick={() => void resume(s.id)}>
                  {t('creator.subscriptions.resume')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      <ConfirmDialog
        open={cancelId !== null}
        title={t('creator.subscriptions.cancelConfirm.title')}
        description={t('creator.subscriptions.cancelConfirm.body')}
        confirmLabel={t('creator.subscriptions.cancel')}
        danger
        busy={busy}
        onConfirm={() => void cancel()}
        onClose={() => {
          setCancelId(null);
          setImmediately(false);
        }}
      >
        <Switch
          label={t('creator.subscriptions.cancelImmediately')}
          checked={immediately}
          onChange={(e) => setImmediately(e.target.checked)}
        />
      </ConfirmDialog>
    </div>
  );
}

// ------------------------------------------------------------------ payouts
function PayoutsPanel() {
  const api = useApi();
  const { t, fmt } = useI18n();
  const toast = useToast();
  const balance = useAsync((signal) => api.creator.payoutBalance({ signal }), [api]);
  const payouts = useAsync((signal) => api.creator.payouts({ signal }), [api]);
  const [currency, setCurrency] = useState('USD');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);

  const request = async () => {
    setBusy(true);
    try {
      await api.creator.requestPayout({
        currency: currency.trim().toUpperCase(),
        amountCents: amount ? Math.round(Number(amount)) : undefined,
      });
      toast.show({ tone: 'success', title: t('creator.payouts.requested') });
      setAmount('');
      balance.reload();
      payouts.reload();
    } catch (e) {
      toast.show({
        tone: 'danger',
        title: t('error.actionFailed'),
        description: describeError(e, t).message,
      });
    } finally {
      setBusy(false);
    }
  };

  if (balance.loading) return <PageSpinner />;
  if (balance.error) return <ErrorView error={balance.error} onRetry={balance.reload} />;
  const d = balance.data;
  if (!d) return null;

  return (
    <div className="stack">
      <Card padding="md" className="stack-sm">
        {d.balances.length === 0 ? <p className="muted">—</p> : null}
        {d.balances.map((b) => (
          <div key={b.currency} className="stack-sm">
            <p>
              {t('creator.payouts.total')}: {fmt.currency(b.totalCents / 100, b.currency)}
            </p>
            <p>
              {t('creator.payouts.available')}: {fmt.currency(b.availableCents / 100, b.currency)}
            </p>
            <p className="muted">
              {t('creator.payouts.pending')}: {fmt.currency(b.pendingCents / 100, b.currency)}
            </p>
          </div>
        ))}
        <p className="muted">{t('creator.payouts.holdDays', { days: d.holdDays })}</p>
        {!d.payoutAccount?.payoutsEnabled ? (
          <p className="muted">{t('creator.payouts.needsVerification')}</p>
        ) : (
          <>
            <FormField label={t('creator.payouts.currency')}>
              <Input
                value={currency}
                maxLength={3}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              />
            </FormField>
            <FormField label={t('creator.payouts.amount')}>
              <Input
                type="number"
                min={1}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </FormField>
            <Button size="sm" loading={busy} onClick={() => void request()}>
              {t('creator.payouts.request')}
            </Button>
          </>
        )}
      </Card>

      <h4 className="section-title">{t('creator.payouts.history')}</h4>
      {payouts.data && payouts.data.items.length === 0 ? (
        <p className="muted">{t('creator.payouts.empty')}</p>
      ) : null}
      {payouts.data && payouts.data.items.length > 0 ? (
        <ul className="stack-sm">
          {payouts.data.items.map((p) => (
            <li key={p.id} className="search-row">
              <span className="search-row__text">
                <span>{fmt.currency(p.amountCents / 100, p.currency)}</span>
                <span className="muted">{t(PAYOUT_STATUS_KEYS[p.status])}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ revenue / analytics
function RevenuePanel() {
  const api = useApi();
  const { t, fmt } = useI18n();
  const [days, setDays] = useState(30);
  const dash = useAsync((signal) => api.creator.dashboard({ days, signal }), [api, days]);
  const rev = useAsync((signal) => api.creator.revenue({ days, signal }), [api, days]);

  if (dash.loading || rev.loading) return <PageSpinner />;
  if (dash.error) return <ErrorView error={dash.error} onRetry={dash.reload} />;
  if (rev.error) return <ErrorView error={rev.error} onRetry={rev.reload} />;
  const d = dash.data;
  const r = rev.data;
  if (!d || !r) return null;

  return (
    <div className="stack">
      <FormField label={t('creator.revenue.window', { days })}>
        <Select value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
          <option value="30">{t('creator.dashboard.days30')}</option>
          <option value="90">{t('creator.dashboard.days90')}</option>
          <option value="365">{t('creator.dashboard.days365')}</option>
        </Select>
      </FormField>

      <Card padding="md" className="stack-sm">
        <p>
          {t('creator.dashboard.followers')}: {d.followers.total}
          {' · '}
          {t('creator.dashboard.followersGained', { count: d.followers.gained })}
        </p>
        <p>
          {t('creator.dashboard.posts')}: {d.content.posts} · {t('creator.dashboard.views')}:{' '}
          {d.content.views}
        </p>
        {d.content.engagementRate !== null ? (
          <p>
            {t('creator.dashboard.engagement')}:{' '}
            {fmt.number(d.content.engagementRate, { style: 'percent', maximumFractionDigits: 2 })}
          </p>
        ) : null}
        <p>
          {t('creator.dashboard.subscribersActive')}: {d.subscribers.active}
          {' · '}
          {t('creator.dashboard.subscribersPastDue')}: {d.subscribers.pastDue}
        </p>
      </Card>

      {d.content.topPosts.length > 0 ? (
        <Card padding="md" className="stack-sm">
          <h4 className="section-title">{t('creator.dashboard.topPosts')}</h4>
          <ul className="stack-sm">
            {d.content.topPosts.map((p) => (
              <li key={p.id} className="muted">
                {p.kind} · {p.likes}♥ · {p.comments}💬 · {p.views} views
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {d.audience.countries.length > 0 ? (
        <Card padding="md" className="stack-sm">
          <h4 className="section-title">{t('creator.dashboard.audience')}</h4>
          <ul className="stack-sm">
            {d.audience.countries.map((c) => (
              <li key={c.country}>
                {c.country}: {c.followers}
              </li>
            ))}
            {d.audience.other > 0 ? (
              <li className="muted">
                {t('creator.dashboard.audienceOther')}: {d.audience.other}
              </li>
            ) : null}
          </ul>
        </Card>
      ) : null}

      <Card padding="md" className="stack-sm">
        <h4 className="section-title">{t('creator.tab.revenue')}</h4>
        {r.earnings.length === 0 ? <p className="muted">{t('creator.revenue.empty')}</p> : null}
        {r.earnings.map((e, i) => (
          <p key={i}>
            {e.source}: {t('creator.revenue.gross')} {fmt.currency(e.grossCents / 100, e.currency)}
            {' · '}
            {t('creator.revenue.fee')} {fmt.currency(e.platformFeeCents / 100, e.currency)}
            {' · '}
            {t('creator.revenue.net')} {fmt.currency(e.netCents / 100, e.currency)}
          </p>
        ))}
        {r.affiliate.map((a, i) => (
          <p key={i} className="muted">
            {t('creator.revenue.affiliateEarned')}: {fmt.currency(a.netCents / 100, a.currency)}
          </p>
        ))}
        {r.thisMonth.map((m, i) => (
          <p key={i} className="muted">
            {t('creator.revenue.thisMonth')}: {fmt.currency(m.netCents / 100, m.currency)}
          </p>
        ))}
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ supporters (tips & gifts received)
function SupportersPanel() {
  const api = useApi();
  const { t, fmt } = useI18n();
  const state = useAsync((signal) => api.creator.supporters({ signal }), [api]);
  const catalog = useAsync((signal) => api.creator.giftCatalog({ signal }), [api]);

  if (state.loading) return <PageSpinner />;
  if (state.error) return <ErrorView error={state.error} onRetry={state.reload} />;
  const d = state.data;
  if (!d) return null;

  return (
    <div className="stack">
      <Card padding="md" className="stack-sm">
        <h4 className="section-title">{t('creator.supporters.tips')}</h4>
        {d.tips.length === 0 && d.gifts.length === 0 ? (
          <p className="muted">{t('creator.supporters.empty')}</p>
        ) : null}
        {d.tips.map((tip) => (
          <p key={tip.id} className="muted">
            {tip.from.username}: {fmt.currency(tip.amountCents / 100, tip.currency)}
            {tip.message ? ` — ${tip.message}` : ''}
          </p>
        ))}
      </Card>
      <Card padding="md" className="stack-sm">
        <h4 className="section-title">{t('creator.supporters.gifts')}</h4>
        {d.gifts.map((g) => (
          <p key={g.id} className="muted">
            {g.from.username}: {g.name} ({fmt.currency(g.amountCents / 100, g.currency)})
          </p>
        ))}
      </Card>
      <Card padding="md" className="stack-sm">
        <h4 className="section-title">{t('creator.supporters.giftCatalog')}</h4>
        {catalog.data && catalog.data.items.length === 0 ? (
          <p className="muted">{t('creator.supporters.giftCatalogEmpty')}</p>
        ) : null}
        {(catalog.data?.items ?? []).map((g) => (
          <p key={g.id} className="muted">
            {g.name}: {fmt.currency(g.priceCents / 100, g.currency)}
          </p>
        ))}
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ affiliate
function AffiliatePanel() {
  const api = useApi();
  const { t, fmt } = useI18n();
  const toast = useToast();
  const state = useAsync((signal) => api.creator.affiliateLinks({ signal }), [api]);
  const conversions = useAsync((signal) => api.creator.affiliateConversions({ signal }), [api]);
  const [productId, setProductId] = useState('');
  const [commissionBps, setCommissionBps] = useState('500');
  const [optInProductId, setOptInProductId] = useState('');
  const [maxBps, setMaxBps] = useState('500');
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const fail = (e: unknown) =>
    toast.show({
      tone: 'danger',
      title: t('error.actionFailed'),
      description: describeError(e, t).message,
    });

  const createLink = async () => {
    setBusy(true);
    try {
      await api.creator.createAffiliateLink({
        productId: productId.trim(),
        commissionBps: Math.round(Number(commissionBps)) || 0,
      });
      toast.show({ tone: 'success', title: t('creator.affiliate.created') });
      setProductId('');
      state.reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async (l: AffiliateLinkStats) => {
    setBusyId(l.id);
    try {
      await api.creator.setAffiliateLinkActive(l.id, !l.active);
      toast.show({ tone: 'success', title: t('creator.affiliate.updated') });
      state.reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusyId(null);
    }
  };

  const optIn = async () => {
    setBusy(true);
    try {
      await api.creator.setProductAffiliateOptIn(
        optInProductId.trim(),
        Math.round(Number(maxBps)) || 0,
      );
      toast.show({ tone: 'success', title: t('creator.affiliate.optInSaved') });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <Card padding="md" className="stack-sm">
        <h4 className="section-title">{t('creator.affiliate.newLink')}</h4>
        <FormField label={t('creator.affiliate.productId')}>
          <Input value={productId} onChange={(e) => setProductId(e.target.value)} />
        </FormField>
        <FormField label={t('creator.affiliate.commissionBps')}>
          <Input
            type="number"
            min={0}
            max={5000}
            value={commissionBps}
            onChange={(e) => setCommissionBps(e.target.value)}
          />
        </FormField>
        <Button size="sm" loading={busy} onClick={() => void createLink()}>
          {t('creator.affiliate.create')}
        </Button>
      </Card>

      <h4 className="section-title">{t('creator.affiliate.links')}</h4>
      {state.loading ? <PageSpinner /> : null}
      {state.error ? <ErrorView error={state.error} onRetry={state.reload} /> : null}
      {state.data && state.data.items.length === 0 ? (
        <p className="muted">{t('creator.affiliate.linksEmpty')}</p>
      ) : null}
      {state.data && state.data.items.length > 0 ? (
        <ul className="stack-sm">
          {state.data.items.map((l) => (
            <li key={l.id} className="search-row">
              <span className="search-row__text">
                <span>{t('creator.affiliate.code', { code: l.code })}</span>
                <span className="muted">
                  {t('creator.affiliate.clicks', {
                    counted: l.clicks.counted,
                    rejected: l.clicks.rejected,
                  })}
                  {' · '}
                  {t('creator.affiliate.conversions', { count: l.conversions })}
                  {' · '}
                  {t('creator.affiliate.commissionPending', {
                    amount: fmt.currency(l.commissionCents.pending / 100, 'USD'),
                  })}
                </span>
              </span>
              <Button
                size="sm"
                variant="ghost"
                loading={busyId === l.id}
                onClick={() => void toggleActive(l)}
              >
                {l.active ? t('creator.affiliate.disable') : t('creator.affiliate.enable')}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      <h4 className="section-title">{t('creator.affiliate.conversionsTitle')}</h4>
      {conversions.data && conversions.data.items.length === 0 ? (
        <p className="muted">{t('creator.affiliate.conversionsEmpty')}</p>
      ) : null}
      {(conversions.data?.items ?? []).map((c) => (
        <p key={c.id} className="muted">
          {fmt.currency(c.commissionCents / 100, c.currency)} · {c.status}
        </p>
      ))}

      <Card padding="md" className="stack-sm">
        <h4 className="section-title">{t('creator.affiliate.sellerOptIn')}</h4>
        <p className="muted">{t('creator.affiliate.sellerOptInHelp')}</p>
        <FormField label={t('creator.affiliate.productId')}>
          <Input value={optInProductId} onChange={(e) => setOptInProductId(e.target.value)} />
        </FormField>
        <FormField label={t('creator.affiliate.maxBps')}>
          <Input
            type="number"
            min={0}
            max={5000}
            value={maxBps}
            onChange={(e) => setMaxBps(e.target.value)}
          />
        </FormField>
        <Button size="sm" loading={busy} onClick={() => void optIn()}>
          {t('creator.affiliate.optInSubmit')}
        </Button>
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ partnerships
function PartnershipDetail({ p, onChanged }: { p: Partnership; onChanged: () => void }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [declineOpen, setDeclineOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [postIds, setPostIds] = useState<Record<string, string>>({});

  const fail = (e: unknown) =>
    toast.show({
      tone: 'danger',
      title: t('error.actionFailed'),
      description: describeError(e, t).message,
    });

  const run = async (fn: () => Promise<unknown>, successMessage: string) => {
    setBusy(true);
    try {
      await fn();
      toast.show({ tone: 'success', title: successMessage });
      onChanged();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padding="md" className="stack-sm">
      <h4 className="section-title">{p.title}</h4>
      <p className="muted">{t(PARTNERSHIP_STATUS_KEYS[p.status])}</p>
      <p className="muted">{t('creator.partnerships.disclosure', { label: p.disclosureLabel })}</p>
      <p>{p.brief}</p>
      <p className="muted">
        {p.acceptedBy.creator
          ? t('creator.partnerships.acceptedBy.creator')
          : t('creator.partnerships.notAcceptedYet')}
        {' · '}
        {p.acceptedBy.business
          ? t('creator.partnerships.acceptedBy.business')
          : t('creator.partnerships.notAcceptedYet')}
      </p>

      {p.status === 'proposed' || p.status === 'negotiating' ? (
        <div className="button-row">
          <Button
            size="sm"
            loading={busy}
            onClick={() =>
              void run(
                () => api.creator.acceptPartnership(p.id, p.termsVersion),
                t('creator.partnerships.accepted'),
              )
            }
          >
            {t('creator.partnerships.accept')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDeclineOpen(true)}>
            {t('creator.partnerships.decline')}
          </Button>
        </div>
      ) : null}
      {p.status === 'accepted' ? (
        <Button
          size="sm"
          loading={busy}
          onClick={() =>
            void run(() => api.creator.startPartnership(p.id), t('creator.partnerships.started'))
          }
        >
          {t('creator.partnerships.start')}
        </Button>
      ) : null}
      {!['paid', 'declined', 'cancelled'].includes(p.status) ? (
        <Button size="sm" variant="ghost" onClick={() => setCancelOpen(true)}>
          {t('creator.partnerships.cancel')}
        </Button>
      ) : null}

      {p.deliverables.length > 0 ? (
        <div className="stack-sm">
          <h5 className="section-title">{t('creator.partnerships.deliverables')}</h5>
          {p.deliverables.map((d) => (
            <div key={d.id} className="stack-sm">
              <p className="muted">
                {d.title} · {d.status}
              </p>
              {d.status === 'pending' || d.status === 'rejected' ? (
                <div className="inline-form">
                  <Input
                    aria-label={t('creator.partnerships.deliverablePostId')}
                    placeholder={t('creator.partnerships.deliverablePostId')}
                    value={postIds[d.id] ?? ''}
                    onChange={(e) => setPostIds((s) => ({ ...s, [d.id]: e.target.value }))}
                  />
                  <Button
                    size="sm"
                    loading={busy}
                    onClick={() =>
                      void run(
                        () =>
                          api.creator.submitDeliverable(p.id, d.id, (postIds[d.id] ?? '').trim()),
                        t('creator.partnerships.deliverableSubmitted'),
                      )
                    }
                  >
                    {t('creator.partnerships.submitDeliverable')}
                  </Button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      <p className="muted">{t('creator.partnerships.viewerBusinessGap')}</p>

      <ConfirmDialog
        open={declineOpen}
        title={t('creator.partnerships.declineConfirm.title')}
        description={t('creator.partnerships.declineConfirm.body')}
        confirmLabel={t('creator.partnerships.decline')}
        danger
        busy={busy}
        onConfirm={() =>
          void run(
            () => api.creator.declinePartnership(p.id),
            t('creator.partnerships.declined'),
          ).then(() => setDeclineOpen(false))
        }
        onClose={() => setDeclineOpen(false)}
      />
      <ConfirmDialog
        open={cancelOpen}
        title={t('creator.partnerships.cancelConfirm.title')}
        description={t('creator.partnerships.cancelConfirm.body')}
        confirmLabel={t('creator.partnerships.cancel')}
        danger
        busy={busy}
        onConfirm={() =>
          void run(
            () => api.creator.cancelPartnership(p.id),
            t('creator.partnerships.cancelled'),
          ).then(() => setCancelOpen(false))
        }
        onClose={() => setCancelOpen(false)}
      />
    </Card>
  );
}

function PartnershipsPanel() {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const state = useAsync((signal) => api.creator.partnerships({ signal }), [api]);
  const [selected, setSelected] = useState<string | null>(null);
  const detail = useAsync(
    (signal) => (selected ? api.creator.partnership(selected, { signal }) : Promise.resolve(null)),
    [api, selected],
  );
  const [businessId, setBusinessId] = useState('');
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const [amountCents, setAmountCents] = useState('10000');
  const [currency, setCurrency] = useState('USD');
  const [deliverableTitle, setDeliverableTitle] = useState('');
  const [busy, setBusy] = useState(false);

  const propose = async () => {
    setBusy(true);
    try {
      await api.creator.proposePartnership({
        businessId: businessId.trim(),
        title: title.trim(),
        brief: brief.trim(),
        amountCents: Math.round(Number(amountCents)) || 100,
        currency: currency.trim().toUpperCase(),
        deliverables: [{ title: deliverableTitle.trim() || title.trim() }],
      });
      toast.show({ tone: 'success', title: t('creator.partnerships.proposed') });
      setBusinessId('');
      setTitle('');
      setBrief('');
      state.reload();
    } catch (e) {
      toast.show({
        tone: 'danger',
        title: t('error.actionFailed'),
        description: describeError(e, t).message,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <Card padding="md" className="stack-sm">
        <h4 className="section-title">{t('creator.partnerships.new')}</h4>
        <FormField label={t('creator.partnerships.businessId')}>
          <Input value={businessId} onChange={(e) => setBusinessId(e.target.value)} />
        </FormField>
        <FormField label={t('creator.partnerships.proposalTitle')}>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </FormField>
        <FormField label={t('creator.partnerships.brief')}>
          <Textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={2} />
        </FormField>
        <FormField label={t('creator.partnerships.amount')}>
          <Input
            type="number"
            min={100}
            value={amountCents}
            onChange={(e) => setAmountCents(e.target.value)}
          />
        </FormField>
        <FormField label={t('creator.partnerships.currency')}>
          <Input
            value={currency}
            maxLength={3}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
          />
        </FormField>
        <FormField label={t('creator.partnerships.deliverableTitle')}>
          <Input value={deliverableTitle} onChange={(e) => setDeliverableTitle(e.target.value)} />
        </FormField>
        <Button size="sm" loading={busy} onClick={() => void propose()}>
          {t('creator.partnerships.propose')}
        </Button>
      </Card>

      {state.loading ? <PageSpinner /> : null}
      {state.error ? <ErrorView error={state.error} onRetry={state.reload} /> : null}
      {state.data && state.data.items.length === 0 ? (
        <p className="muted">{t('creator.partnerships.empty')}</p>
      ) : null}
      {state.data && state.data.items.length > 0 ? (
        <ul className="stack-sm">
          {state.data.items.map((p) => (
            <li key={p.id} className="search-row">
              <button
                type="button"
                className="search-row__text"
                onClick={() => setSelected(p.id)}
                style={{ background: 'none', border: 0, textAlign: 'start', cursor: 'pointer' }}
              >
                <span>{p.title}</span>
                <span className="muted">{t(PARTNERSHIP_STATUS_KEYS[p.status])}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {selected && detail.data ? (
        <PartnershipDetail
          p={detail.data}
          onChanged={() => {
            detail.reload();
            state.reload();
          }}
        />
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ shell
export function CreatorStudioView() {
  const { t } = useI18n();
  usePageTitle(t('creator.title'), t('app.name'));
  const [tab, setTab] = useState<Tab>('overview');

  return (
    <>
      <PageHeader title={t('creator.title')} lead={t('creator.lead')} />
      <FeedTabs
        label={t('creator.title')}
        value={tab}
        onChange={(v) => setTab(v as Tab)}
        tabs={[
          { id: 'overview', label: t('creator.tab.overview') },
          { id: 'plans', label: t('creator.tab.plans') },
          { id: 'subscribers', label: t('creator.tab.subscribers') },
          { id: 'subscriptions', label: t('creator.tab.subscriptions') },
          { id: 'payouts', label: t('creator.tab.payouts') },
          { id: 'revenue', label: t('creator.tab.revenue') },
          { id: 'supporters', label: t('creator.tab.supporters') },
          { id: 'affiliate', label: t('creator.tab.affiliate') },
          { id: 'partnerships', label: t('creator.tab.partnerships') },
        ]}
      >
        {tab === 'overview' ? <OverviewPanel key="overview" /> : null}
        {tab === 'plans' ? <PlansPanel key="plans" /> : null}
        {tab === 'subscribers' ? <SubscribersPanel key="subscribers" /> : null}
        {tab === 'subscriptions' ? <SubscriptionsPanel key="subscriptions" /> : null}
        {tab === 'payouts' ? <PayoutsPanel key="payouts" /> : null}
        {tab === 'revenue' ? <RevenuePanel key="revenue" /> : null}
        {tab === 'supporters' ? <SupportersPanel key="supporters" /> : null}
        {tab === 'affiliate' ? <AffiliatePanel key="affiliate" /> : null}
        {tab === 'partnerships' ? <PartnershipsPanel key="partnerships" /> : null}
      </FeedTabs>
    </>
  );
}
