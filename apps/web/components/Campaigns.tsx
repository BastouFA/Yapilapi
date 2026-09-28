'use client';

import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, List, ListItem, Select, TextField } from '@yapilapi/design-system';
import type { AdCampaign } from '@yapilapi/api-client';
import { formatMoney, type MessageKey, type Post } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';
import { useCheckout } from './Checkout';

const STATUS_LABEL: Record<AdCampaign['status'], MessageKey> = {
  active: 'm.boost.status.active',
  draft: 'm.drafts.draft',
  pending_review: 'm.boost.status.pending_review',
  paused: 'm.boost.status.paused',
  ended: 'm.boost.status.ended',
  rejected: 'm.boost.status.rejected',
};

const STATUS_TONE: Record<AdCampaign['status'], 'success' | 'neutral' | 'warning' | 'danger'> = {
  active: 'success',
  draft: 'neutral',
  pending_review: 'warning',
  paused: 'warning',
  ended: 'neutral',
  rejected: 'danger',
};

/**
 * Promote one of your public posts. Budget is paid up front; each impression
 * is charged at your CPM. Ads only reach adults who turned advertising on.
 */
export function Campaigns() {
  const { me, toast, locale, flags, t, tp } = useSession();
  const checkout = useCheckout();
  const [items, setItems] = useState<AdCampaign[] | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [postId, setPostId] = useState('');
  const [name, setName] = useState('');
  const [topics, setTopics] = useState('');
  const [cpm, setCpm] = useState('500');
  const [businesses, setBusinesses] = useState<{ id: string; name: string }[]>([]);
  const [businessId, setBusinessId] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [stats, setStats] = useState<Awaited<ReturnType<typeof api.ads.stats>> | null>(null);

  const load = () =>
    api.ads.campaigns().then(
      (r) => setItems(r.items),
      () => setItems([]),
    );
  useEffect(() => {
    if (!flags.ADS || !me) return;
    void load();
    api.businesses.mine().then(
      (r) => setBusinesses(r.items),
      () => {},
    );
    api.users.posts(me.username).then(
      (r) => setPosts(r.items.filter((p) => p.visibility === 'public')),
      () => {},
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flags.ADS, me?.username]);

  if (!flags.ADS || !items) return null;
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    try {
      await fn();
      if (done) toast(done);
      await load();
    } catch (e) {
      toast(errorMessage(e));
    }
  };

  return (
    <Card title={t('ads.promote')} subtitle={t('ads.promoteBody')}>
      <div className="stack">
        {items.length ? (
          <List>
            {items.map((c) => (
              <ListItem
                key={c.id}
                onClick={async () => {
                  setOpen(open === c.id ? null : c.id);
                  setStats(open === c.id ? null : await api.ads.stats(c.id).catch(() => null));
                }}
                primary={
                  <span className="row">
                    {c.name} <Badge tone={STATUS_TONE[c.status]}>{t(STATUS_LABEL[c.status])}</Badge>
                  </span>
                }
                secondary={[
                  tp('ads.impressions', c.impressions, { number: c.impressions.toLocaleString(locale) }),
                  tp('ads.clicks', c.clicks, { number: c.clicks.toLocaleString(locale) }),
                  `${c.ctr}%`,
                  t('m.boost.spentOf', { spent: formatMoney(c.spentCents, c.currency, locale), budget: formatMoney(c.budgetCents, c.currency, locale) }),
                  ...(c.refundedCents ? [t('m.boost.refunded', { amount: formatMoney(c.refundedCents, c.currency, locale) })] : []),
                ].join(' · ')}
              />
            ))}
          </List>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            {t('ads.none')}
          </p>
        )}

        {open && stats ? (
          <div className="family-controls">
            <strong>{stats.campaign.name}</strong>
            {stats.campaign.status === 'pending_review' ? (
              <p className="muted" style={{ margin: 0 }}>
                {t('ads.pendingNote')}
              </p>
            ) : null}
            {stats.campaign.status === 'rejected' && stats.campaign.reviewNote ? (
              <Alert tone="danger" title={t('m.boost.status.rejected')}>
                {stats.campaign.reviewNote}
              </Alert>
            ) : null}
            {stats.days.length ? (
              <div className="usage" aria-label={t('ads.perDay')}>
                {stats.days.slice(-14).map((d) => (
                  <div
                    key={d.day}
                    className="usage__day"
                    title={[
                      tp('ads.impressions', d.impressions, { number: d.impressions.toLocaleString(locale) }),
                      tp('ads.clicks', d.clicks, { number: d.clicks.toLocaleString(locale) }),
                      tp('ads.people', d.reach, { number: d.reach.toLocaleString(locale) }),
                    ].join(', ')}
                  >
                    <span
                      className="usage__bar"
                      style={{ height: `${Math.max(4, (d.impressions / Math.max(1, ...stats.days.map((x) => x.impressions))) * 64)}px` }}
                    />
                    <span className="usage__label">{new Date(d.day).getDate()}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted" style={{ margin: 0 }}>
                {t('ads.noImpressions')}
              </p>
            )}
            <div className="row">
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  act(async () => {
                    const r = await api.ads.fund(open, 2000, crypto.randomUUID());
                    checkout({
                      orderId: r.payment.orderId,
                      clientSecret: r.payment.clientSecret,
                      provider: r.payment.provider,
                      label: t('ads.fundLabel', { name: stats.campaign.name, amount: formatMoney(2000, stats.campaign.currency, locale) }),
                      onPaid: async () => {
                        await load();
                        setStats(await api.ads.stats(open));
                      },
                    });
                  })
                }
              >
                {t('ads.addAmount', { amount: formatMoney(2000, stats.campaign.currency, locale) })}
              </Button>
              {stats.campaign.status === 'active' ? (
                <Button size="sm" variant="secondary" onClick={() => act(() => api.ads.setStatus(open, 'paused'), t('m.boost.status.paused'))}>
                  {t('m.common.pause')}
                </Button>
              ) : stats.campaign.status === 'draft' || stats.campaign.status === 'paused' ? (
                <Button
                  size="sm"
                  onClick={() =>
                    act(async () => {
                      const r = await api.ads.setStatus(open, 'active');
                      toast(
                        r.campaign.status === 'pending_review'
                          ? t('ads.sentForReview')
                          : r.campaign.status === 'rejected'
                            ? t('m.boost.status.rejected')
                            : t('ads.started'),
                      );
                      setStats(await api.ads.stats(open));
                    })
                  }
                >
                  {stats.campaign.approvedAt ? t('ads.resume') : t('ads.submit')}
                </Button>
              ) : null}
              {stats.campaign.status !== 'ended' && stats.campaign.status !== 'rejected' ? (
                <Button size="sm" variant="ghost" onClick={() => act(() => api.ads.setStatus(open, 'ended'), t('ads.ended'))}>
                  {t('ads.end')}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        <form
          className="stack-sm"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              () =>
                api.ads.create({
                  postId,
                  name,
                  cpmCents: Number(cpm),
                  businessId: businessId || undefined,
                  topics: topics
                    .split(',')
                    .map((t) => t.trim().replace(/^#/, ''))
                    .filter(Boolean),
                }),
              t('ads.created'),
            ).then(() => setName(''));
          }}
        >
          <Select label={t('ads.post')} value={postId} onChange={(e) => setPostId(e.currentTarget.value)} required>
            <option value="">{t('ads.choosePost')}</option>
            {posts.map((p) => (
              <option key={p.id} value={p.id}>
                {p.body.slice(0, 60) || t('ads.photoPost')}
              </option>
            ))}
          </Select>
          {businesses.length ? (
            <Select label={t('ads.for')} value={businessId} onChange={(e) => setBusinessId(e.currentTarget.value)} hint={t('ads.forHint')}>
              <option value="">{t('ads.justMe')}</option>
              {businesses.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          ) : null}
          <TextField label={t('ads.name')} value={name} onChange={(e) => setName(e.currentTarget.value)} maxLength={80} required />
          <TextField label={t('compose.topics')} hint={t('ads.topicsHint')} value={topics} onChange={(e) => setTopics(e.currentTarget.value)} />
          <Select label={t('ads.cpm')} value={cpm} onChange={(e) => setCpm(e.currentTarget.value)}>
            {[300, 500, 1000, 2000].map((c) => (
              <option key={c} value={c}>
                {formatMoney(c, 'USD', locale)}
              </option>
            ))}
          </Select>
          <Button type="submit" size="sm" disabled={!postId || !name.trim()}>
            {t('ads.create')}
          </Button>
        </form>
      </div>
    </Card>
  );
}
