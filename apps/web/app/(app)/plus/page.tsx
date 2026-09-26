'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Icon, List, ListItem, PlusBadge, Skeleton, type IconName } from '@yapilapi/design-system';
import { formatMoney } from '@yapilapi/shared';
import type { PlusInfo } from '@yapilapi/api-client';
import { api, errorMessage } from '@/lib/api';
import { useCheckout } from '@/components/Checkout';
import { useSession } from '../../providers';

const ICON: Record<PlusInfo['benefits'][number]['id'], IconName> = { no_ads: 'shield', long_reels: 'create', big_uploads: 'image', badge: 'sparkle' };

/**
 * YAPILAPI Plus: what it gives, what it costs, and when yours ends. It is
 * bought 30 days at a time and never renews on its own.
 */
export default function PlusPage() {
  const { t, locale, toast, refresh } = useSession();
  const checkout = useCheckout();
  const [info, setInfo] = useState<PlusInfo | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      api.plus.get().then(
        (r) => setInfo(r),
        (e) => toast(errorMessage(e)),
      ),
    [toast],
  );
  useEffect(() => {
    void load();
  }, [load]);

  if (!info)
    return (
      <div className="yp-shell__inner">
        <Skeleton height={40} />
        <Skeleton height={260} />
      </div>
    );

  const price = formatMoney(info.priceCents, info.currency, locale);
  const date = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(new Date(iso));
  const status = info.status;

  async function buy() {
    setBusy(true);
    try {
      const r = await api.plus.checkout(crypto.randomUUID());
      checkout({
        orderId: r.payment.orderId,
        clientSecret: r.payment.clientSecret,
        label: t('plus.checkoutLabel', { price }),
        onPaid: async () => {
          toast(t('plus.paid'));
          await Promise.all([load(), refresh()]);
        },
      });
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const benefitText = (b: PlusInfo['benefits'][number]) => {
    switch (b.id) {
      case 'no_ads':
        return { title: t('plus.benefit.noAds'), body: t('plus.benefit.noAds.body') };
      case 'long_reels':
        return { title: t('plus.benefit.longReels'), body: t('plus.benefit.longReels.body', { minutes: b.minutes, standard: b.standardMinutes }) };
      case 'big_uploads':
        return { title: t('plus.benefit.bigUploads'), body: t('plus.benefit.bigUploads.body', { size: b.megabytes, standard: b.standardMegabytes }) };
      case 'badge':
        return { title: t('plus.benefit.badge'), body: t('plus.benefit.badge.body') };
    }
  };

  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>
          {t('plus.title')} <PlusBadge label={t('plus.badge.label')} />
        </h1>
      </div>
      <p style={{ margin: 0 }}>{t('plus.intro')}</p>

      <Card title={t('plus.price', { price })} subtitle={t('plus.noRenew')}>
        <div className="stack-sm">
          {status?.active && status.until ? (
            <Alert tone="success" title={t('plus.status.active', { date: date(status.until) })}>
              {t('plus.status.ends')}
            </Alert>
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              {t('plus.status.none')}
            </p>
          )}
          {status && !status.canExtend ? (
            <p className="muted" style={{ margin: 0 }}>
              {t('plus.maxed')}
            </p>
          ) : (
            <Button onClick={buy} loading={busy}>
              {status?.active ? t('plus.extend', { price }) : t('plus.buy', { price })}
            </Button>
          )}
        </div>
      </Card>

      <Card title={t('plus.benefits.title')}>
        <ul className="stack-sm" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {info.benefits.map((b) => {
            const text = benefitText(b);
            return (
              <li key={b.id} className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
                <Icon name={ICON[b.id]} size={20} />
                <span>
                  <strong>{text.title}</strong>
                  <br />
                  <span className="muted">{text.body}</span>
                </span>
              </li>
            );
          })}
        </ul>
      </Card>

      <p style={{ margin: 0 }}>
        {t('plus.inviteHint')} <Link href="/invite">{t('invite.title')}</Link>
      </p>

      {info.history.length ? (
        <Card title={t('plus.history')}>
          <List>
            {info.history.map((h) => (
              <ListItem
                key={h.createdAt + h.source}
                primary={h.source === 'purchase' ? t('plus.history.purchase', { days: h.days }) : t('plus.history.referral', { days: h.days })}
                secondary={`${date(h.startsAt)} – ${date(h.endsAt)}`}
              />
            ))}
          </List>
        </Card>
      ) : null}
    </div>
  );
}
