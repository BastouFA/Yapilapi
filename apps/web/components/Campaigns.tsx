'use client';

import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, List, ListItem, Select, TextField } from '@yapilapi/design-system';
import type { AdCampaign } from '@yapilapi/api-client';
import { formatMoney, type Post } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';

const STATUS_LABEL: Record<AdCampaign['status'], string> = {
  active: 'Running',
  draft: 'Draft',
  pending_review: 'In review',
  paused: 'Paused',
  ended: 'Ended',
  rejected: 'Not approved',
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
  const { me, toast, locale, flags } = useSession();
  const [items, setItems] = useState<AdCampaign[] | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [postId, setPostId] = useState('');
  const [name, setName] = useState('');
  const [topics, setTopics] = useState('');
  const [cpm, setCpm] = useState('500');
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
    <Card title="Promote" subtitle="Sponsored posts are labelled, reach only adults who turned advertising on, and can always be hidden.">
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
                    {c.name} <Badge tone={STATUS_TONE[c.status]}>{STATUS_LABEL[c.status]}</Badge>
                  </span>
                }
                secondary={`${c.impressions.toLocaleString(locale)} impressions · ${c.clicks} clicks · ${c.ctr}% · ${formatMoney(c.spentCents, c.currency, locale)} of ${formatMoney(c.budgetCents, c.currency, locale)}${c.refundedCents ? ` · ${formatMoney(c.refundedCents, c.currency, locale)} refunded` : ''}`}
              />
            ))}
          </List>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            No campaigns yet.
          </p>
        )}

        {open && stats ? (
          <div className="family-controls">
            <strong>{stats.campaign.name}</strong>
            {stats.campaign.status === 'pending_review' ? (
              <p className="muted" style={{ margin: 0 }}>
                A moderator checks every new ad, and any ad whose post was edited, before it runs. You&apos;ll get a notification.
              </p>
            ) : null}
            {stats.campaign.status === 'rejected' && stats.campaign.reviewNote ? (
              <Alert tone="danger" title="Not approved">
                {stats.campaign.reviewNote}
              </Alert>
            ) : null}
            {stats.days.length ? (
              <div className="usage" aria-label="Impressions per day">
                {stats.days.slice(-14).map((d) => (
                  <div key={d.day} className="usage__day" title={`${d.impressions} impressions, ${d.clicks} clicks, ${d.reach} people`}>
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
                No impressions yet.
              </p>
            )}
            <div className="row">
              <Button size="sm" variant="secondary" onClick={() => act(() => api.ads.fund(open, 2000, crypto.randomUUID()), 'Complete payment to add budget.')}>
                Add {formatMoney(2000, stats.campaign.currency, locale)}
              </Button>
              {stats.campaign.status === 'active' ? (
                <Button size="sm" variant="secondary" onClick={() => act(() => api.ads.setStatus(open, 'paused'), 'Paused')}>
                  Pause
                </Button>
              ) : stats.campaign.status === 'draft' || stats.campaign.status === 'paused' ? (
                <Button
                  size="sm"
                  onClick={() =>
                    act(async () => {
                      const r = await api.ads.setStatus(open, 'active');
                      toast(
                        r.campaign.status === 'pending_review' ? 'Sent for review' : r.campaign.status === 'rejected' ? 'Not approved' : 'Campaign started',
                      );
                      setStats(await api.ads.stats(open));
                    })
                  }
                >
                  {stats.campaign.approvedAt ? 'Resume' : 'Submit for review'}
                </Button>
              ) : null}
              {stats.campaign.status !== 'ended' && stats.campaign.status !== 'rejected' ? (
                <Button size="sm" variant="ghost" onClick={() => act(() => api.ads.setStatus(open, 'ended'), 'Campaign ended')}>
                  End campaign
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
                  topics: topics
                    .split(',')
                    .map((t) => t.trim().replace(/^#/, ''))
                    .filter(Boolean),
                }),
              'Campaign created. Add budget to start it.',
            ).then(() => setName(''));
          }}
        >
          <Select label="Post to promote" value={postId} onChange={(e) => setPostId(e.currentTarget.value)} required>
            <option value="">Choose a public post</option>
            {posts.map((p) => (
              <option key={p.id} value={p.id}>
                {p.body.slice(0, 60) || 'Photo post'}
              </option>
            ))}
          </Select>
          <TextField label="Campaign name" value={name} onChange={(e) => setName(e.currentTarget.value)} maxLength={80} required />
          <TextField
            label="Topics (optional)"
            hint="Only show it to people who follow these topics, separated by commas."
            value={topics}
            onChange={(e) => setTopics(e.currentTarget.value)}
          />
          <Select label="Price per 1,000 views" value={cpm} onChange={(e) => setCpm(e.currentTarget.value)}>
            {[300, 500, 1000, 2000].map((c) => (
              <option key={c} value={c}>
                {formatMoney(c, 'USD', locale)}
              </option>
            ))}
          </Select>
          <Button type="submit" size="sm" disabled={!postId || !name.trim()}>
            Create campaign
          </Button>
        </form>
      </div>
    </Card>
  );
}
