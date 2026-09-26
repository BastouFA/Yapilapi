'use client';

import { useEffect, useState } from 'react';
import { Button, EmptyState, List, ListItem, Select, Skeleton, Stat, TextField } from '@yapilapi/design-system';
import { CURRENCIES, currencyForCountry, formatMoney, formatRelativeTime } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { Campaigns } from '@/components/Campaigns';
import { VideoEditor } from '@/components/VideoEditor';
import { BoostsPanel, SalesPanel, ShopManager } from '@/components/StudioMoney';
import { useSession } from '../../providers';

/** Creator Studio: how your content performs over the last 28 days, and what you've earned. */
export default function Studio() {
  const { locale } = useSession();
  const [data, setData] = useState<Awaited<ReturnType<typeof api.creator.analytics>> | null>(null);
  const [earnings, setEarnings] = useState<{ currency: string; grossCents: number; feeCents: number; availableCents: number }[]>([]);
  useEffect(() => {
    api.creator.analytics().then(setData);
    api.raw
      .get<{ balances: typeof earnings }>('/v1/me/earnings')
      .then((r) => setEarnings(r.balances))
      .catch(() => {});
  }, []);
  if (!data) return <Skeleton height={240} />;
  const growth = data.followerGrowth.map((d) => Number(d.new_followers));
  const max = Math.max(1, ...growth);
  const w = 560;
  const h = 120;
  const pts = growth.map((v, i) => `${(i / Math.max(1, growth.length - 1)) * w},${h - (v / max) * (h - 12) - 6}`).join(' ');

  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>Studio</h1>
        <span className="muted">Last 28 days</span>
      </div>
      <div className="stats">
        <Stat label="Posts" value={data.totals.posts} />
        <Stat label="Likes" value={data.totals.likes} />
        <Stat label="Comments" value={data.totals.comments} />
        <Stat label="Saves" value={data.totals.saves} />
        <Stat label="Followers" value={data.totals.followers} delta={`+${growth.reduce((a, b) => a + b, 0)} this period`} />
      </div>
      <section className="stack-sm">
        <h2 className="section-title">New followers per day</h2>
        <div className="yp-card" style={{ padding: 16, overflowX: 'auto' }}>
          <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} role="img" aria-label={`New followers per day, peak ${max}`}>
            <line x1="0" x2={w} y1={h - 6} y2={h - 6} stroke="var(--line)" />
            <polyline points={`0,${h - 6} ${pts} ${w},${h - 6}`} fill="var(--yapi-soft)" stroke="none" />
            <polyline points={pts} fill="none" stroke="var(--yapi)" strokeWidth="2" />
          </svg>
        </div>
      </section>
      {earnings.length ? (
        <section className="stack-sm">
          <h2 className="section-title">Earnings</h2>
          <div className="stats">
            {earnings.map((e) => (
              <Stat
                key={e.currency}
                label={`Available (${e.currency})`}
                value={formatMoney(e.availableCents, e.currency, locale)}
                delta={`${formatMoney(e.grossCents, e.currency, locale)} gross, ${formatMoney(e.feeCents, e.currency, locale)} fees`}
              />
            ))}
          </div>
        </section>
      ) : null}
      <section className="stack-sm">
        <h2 className="section-title">Top posts</h2>
        {data.topPosts.length ? (
          <List>
            {data.topPosts.map((p) => (
              <ListItem
                key={p.id}
                primary={p.excerpt || `(${p.kind})`}
                secondary={formatRelativeTime(p.created_at, locale)}
                end={`${p.like_count} likes · ${p.comment_count} comments`}
              />
            ))}
          </List>
        ) : (
          <EmptyState title="No posts yet" body="Publish something from Create to see how it does." />
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
  const { me, toast, locale } = useSession();
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
      <h2 className="section-title">Subscriptions</h2>
      <p className="muted" style={{ margin: 0 }}>
        {subs ? `${subs.active} active subscriber${subs.active === 1 ? '' : 's'}.` : ''} Fans subscribe from your profile. With a plan, you can choose
        Subscribers when you post: everyone else sees a locked preview.
      </p>
      {plans.map((p) => (
        <div key={p.id} className="yp-card" style={{ padding: 12 }}>
          <strong>{p.name}</strong> · {formatMoney(p.priceCents, p.currency, locale)} a month
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
        <TextField label="Plan name" value={name} onChange={(e) => setName(e.currentTarget.value)} maxLength={60} />
        <TextField label="Monthly price" type="number" min={1} step="0.5" value={price} onChange={(e) => setPrice(e.currentTarget.value)} />
        <Select label="Currency" value={currency} onChange={(e) => setCurrency(e.currentTarget.value)}>
          {CURRENCIES.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </Select>
        <Button type="submit" disabled={!name.trim()} style={{ alignSelf: 'flex-end' }}>
          Add plan
        </Button>
      </form>
    </section>
  );
}
