'use client';

import { useEffect, useState } from 'react';
import { Button, EmptyState, List, ListItem, Select, Skeleton, Stat, TextField } from '@yapilapi/design-system';
import { CURRENCIES, currencyForCountry, EARNINGS_HOLD_DAYS, formatMoney, formatRelativeTime } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { Campaigns } from '@/components/Campaigns';
import { VideoEditor } from '@/components/VideoEditor';
import { BoostsPanel, SalesPanel, ShopManager } from '@/components/StudioMoney';
import { PayoutsPanel } from '@/components/Payouts';
import { useSession } from '../../providers';

/** Creator Studio: how your content performs over the last 28 days, and what you've earned. */
export default function Studio() {
  const { locale, t, tp } = useSession();
  const [data, setData] = useState<Awaited<ReturnType<typeof api.creator.analytics>> | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [earnings, setEarnings] = useState<{ currency: string; grossCents: number; feeCents: number; heldCents: number; availableCents: number }[]>([]);
  const loadAnalytics = () => {
    setFailed(null);
    api.creator.analytics().then(setData, (e) => setFailed(errorMessage(e)));
  };
  useEffect(() => {
    loadAnalytics();
    api.raw
      .get<{ balances: typeof earnings }>('/v1/me/earnings')
      .then((r) => setEarnings(r.balances))
      .catch(() => {});
  }, []);
  // A failed load says so, with a way to try again, instead of loading for ever.
  if (failed && !data)
    return (
      <div className="yp-shell__inner">
        <EmptyState
          level={1}
          title={t('error.generic')}
          body={failed}
          action={
            <Button variant="secondary" onClick={loadAnalytics}>
              {t('m.common.retry')}
            </Button>
          }
        />
      </div>
    );
  if (!data) return <Skeleton height={240} />;
  const growth = data.followerGrowth.map((d) => Number(d.new_followers));
  const max = Math.max(1, ...growth);
  const total = growth.reduce((a, b) => a + b, 0);
  const w = 560;
  const h = 120;
  const pts = growth.map((v, i) => `${(i / Math.max(1, growth.length - 1)) * w},${h - (v / max) * (h - 12) - 6}`).join(' ');

  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>{t('m.studio.title')}</h1>
        <span className="muted">{t('m.studio.period')}</span>
      </div>
      <div className="stats">
        <Stat label={t('profile.posts')} value={data.totals.posts} />
        <Stat label={t('m.studio.likes')} value={data.totals.likes} />
        <Stat label={t('m.studio.comments')} value={data.totals.comments} />
        <Stat label={t('m.studio.saves')} value={data.totals.saves} />
        <Stat label={t('profile.followers')} value={data.totals.followers} delta={t('m.studio.followersDelta', { count: total })} />
      </div>
      <section className="stack-sm">
        <h2 className="section-title">{t('m.studio.growth')}</h2>
        <div className="yp-card" style={{ padding: 16, overflowX: 'auto' }}>
          <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} role="img" aria-label={t('m.studio.growthA11y', { total, peak: Math.max(0, ...growth) })}>
            <line x1="0" x2={w} y1={h - 6} y2={h - 6} stroke="var(--line)" />
            <polyline points={`0,${h - 6} ${pts} ${w},${h - 6}`} fill="var(--yapi-soft)" stroke="none" />
            <polyline points={pts} fill="none" stroke="var(--yapi)" strokeWidth="2" />
          </svg>
        </div>
      </section>
      {earnings.length ? (
        <section className="stack-sm">
          <h2 className="section-title">{t('m.studio.earnings')}</h2>
          <div className="stats">
            {earnings.map((e) => (
              <Stat
                key={e.currency}
                label={t('m.studio.available', { currency: e.currency })}
                value={formatMoney(e.availableCents, e.currency, locale)}
                delta={[
                  t('m.studio.earningsLine', { gross: formatMoney(e.grossCents, e.currency, locale), fees: formatMoney(e.feeCents, e.currency, locale) }),
                  e.heldCents > 0 ? t('m.studio.earningsHeld', { amount: formatMoney(e.heldCents, e.currency, locale), days: EARNINGS_HOLD_DAYS }) : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              />
            ))}
          </div>
        </section>
      ) : null}
      {earnings.length ? <PayoutsPanel balances={earnings} /> : null}
      <section className="stack-sm">
        <h2 className="section-title">{t('m.studio.topPosts')}</h2>
        {data.topPosts.length ? (
          <List>
            {data.topPosts.map((p) => (
              <ListItem
                key={p.id}
                primary={p.excerpt || t(p.format === 'reel' ? 'm.studio.untitledReel' : 'm.studio.untitledPost')}
                secondary={formatRelativeTime(p.created_at, locale)}
                end={`${tp('comments.likes', p.like_count)} · ${tp('m.post.commentCount', p.comment_count)}`}
              />
            ))}
          </List>
        ) : (
          <EmptyState title={t('m.studio.noPosts')} />
        )}
      </section>
      <SalesPanel />
      <ShopManager />
      <BoostsPanel />
      <VideoEditor />
      <PlansManager />
      <Campaigns />
    </div>
  );
}

function PlansManager() {
  const { me, toast, locale, t, tp } = useSession();
  const [plans, setPlans] = useState<{ id: string; name: string; priceCents: number; currency: string }[]>([]);
  const [subs, setSubs] = useState<{ active: number; cancelled: number } | null>(null);
  const [name, setName] = useState('');
  const [price, setPrice] = useState('5');
  const [currency, setCurrency] = useState<string>(() => currencyForCountry(me?.country));
  const load = async () => {
    if (!me) return;
    setPlans((await api.economy.plans(me.id)).items);
    setSubs(await api.economy.subscribers());
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.id]);
  return (
    <section className="stack-sm">
      <h2 className="section-title">{t('m.studio.subscriptions')}</h2>
      <p className="muted" style={{ margin: 0 }}>
        {subs ? `${tp('m.studio.subscriberCount', subs.active)}. ` : ''}
        {t('studio.plans.intro')}
      </p>
      {plans.map((p) => (
        <div key={p.id} className="yp-card" style={{ padding: 12 }}>
          <strong>{p.name}</strong> · {t('m.money.perMonth', { price: formatMoney(p.priceCents, p.currency, locale) })}
        </div>
      ))}
      <form
        className="row"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.economy.createPlan({ name, priceCents: Math.round(Number(price) * 100), currency });
            setName('');
            await load();
          } catch (err) {
            toast(errorMessage(err));
          }
        }}
      >
        <TextField label={t('studio.plans.name')} value={name} onChange={(e) => setName(e.currentTarget.value)} maxLength={60} />
        <TextField label={t('studio.plans.price')} type="number" min={1} step="0.5" value={price} onChange={(e) => setPrice(e.currentTarget.value)} />
        <Select label={t('m.boost.currency')} value={currency} onChange={(e) => setCurrency(e.currentTarget.value)}>
          {CURRENCIES.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </Select>
        <Button type="submit" disabled={!name.trim()} style={{ alignSelf: 'flex-end' }}>
          {t('studio.plans.add')}
        </Button>
      </form>
    </section>
  );
}
