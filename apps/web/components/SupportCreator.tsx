'use client';

import { useEffect, useState } from 'react';
import { BottomSheet, Button, Card, Select, TextField } from '@yapilapi/design-system';
import { CURRENCIES, CURRENCY_SCALE, formatMoney, type Currency } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';
import { useCheckout } from './Checkout';

/**
 * Subscribe to or tip a creator. Payment is completed with the payment provider;
 * the subscription turns on when the provider confirms the charge.
 */
export function SupportCreator({
  userId,
  name,
  isCreator,
  onSubscribed,
}: {
  userId: string;
  name: string;
  isCreator: boolean;
  /** Called once a subscription is paid (e.g. to reload posts for subscribers). */
  onSubscribed?: () => void;
}) {
  const { toast, locale, flags, t } = useSession();
  const checkout = useCheckout();
  const [data, setData] = useState<Awaited<ReturnType<typeof api.economy.plans>> | null>(null);
  const [tipping, setTipping] = useState(false);

  useEffect(() => {
    api.economy.plans(userId).then(setData, () => {});
  }, [userId]);

  if (flags.COMMERCE === false || !data || (!data.items.length && !isCreator)) return null;
  const sub = data.mySubscription;

  return (
    <Card title={t('m.money.supportTitle', { name })} subtitle={t('support.subtitle')}>
      <div className="stack-sm">
        {data.items.map((p) => (
          <div key={p.id} className="row" style={{ justifyContent: 'space-between' }}>
            <span>
              <strong>{p.name}</strong> · {t('m.money.perMonth', { price: formatMoney(p.priceCents, p.currency, locale) })}
              {p.description ? <span className="muted"> · {p.description}</span> : null}
            </span>
            {sub?.plan_id === p.id ? (
              <span className="muted">{sub.status === 'active' ? t('m.money.subscribed') : t('m.money.waitingPayment')}</span>
            ) : (
              <Button
                size="sm"
                disabled={!!sub}
                onClick={async () => {
                  try {
                    const r = await api.economy.subscribe(p.id, crypto.randomUUID());
                    checkout({
                      orderId: r.payment.orderId,
                      clientSecret: r.payment.clientSecret,
                      provider: r.payment.provider,
                      label: t('support.planLabel', { plan: p.name, name, price: formatMoney(p.priceCents, p.currency, locale) }),
                      onPaid: async () => {
                        setData(await api.economy.plans(userId));
                        onSubscribed?.();
                      },
                    });
                    setData(await api.economy.plans(userId));
                  } catch (e) {
                    toast(errorMessage(e));
                  }
                }}
              >
                {t('support.subscribe')}
              </Button>
            )}
          </div>
        ))}
        <Button variant="secondary" size="sm" onClick={() => setTipping(true)}>
          {t('m.money.tip')}
        </Button>
      </div>
      <TipSheet open={tipping} onClose={() => setTipping(false)} userId={userId} name={name} />
    </Card>
  );
}

/** Send a tip. With a liveId it's a gift: once paid, it appears in that live's chat for everyone watching. */
export function TipSheet({
  open,
  onClose,
  userId,
  name,
  liveId,
  postId,
}: {
  open: boolean;
  onClose: () => void;
  userId: string;
  name: string;
  liveId?: string;
  /** A tip for one of their posts. */
  postId?: string;
}) {
  const { toast, locale, t } = useSession();
  const checkout = useCheckout();
  // The choice is in US cents; each currency scales it so the amounts are worth about the same everywhere (and never below the smallest tip).
  const [amount, setAmount] = useState('300');
  const [currency, setCurrency] = useState<Currency>('USD');
  const [message, setMessage] = useState('');
  const cents = (usCents: number) => usCents * CURRENCY_SCALE[currency];
  return (
    <BottomSheet open={open} onClose={onClose} title={liveId ? t('support.giftTitle', { name }) : t('support.tipTitle', { name })}>
      <form
        className="stack-sm"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const r = await api.economy.tip(userId, {
              amountCents: cents(Number(amount)),
              currency,
              message,
              liveId,
              postId,
              idempotencyKey: crypto.randomUUID(),
            });
            setMessage('');
            onClose();
            const price = formatMoney(cents(Number(amount)), currency, locale);
            checkout({
              orderId: r.payment.orderId,
              clientSecret: r.payment.clientSecret,
              provider: r.payment.provider,
              label: liveId ? t('support.giftLabel', { name, amount: price }) : t('support.tipLabel', { name, amount: price }),
              onPaid: () => toast(liveId ? t('support.giftSent') : t('support.tipSent')),
            });
          } catch (err) {
            toast(errorMessage(err));
          }
        }}
      >
        <Select label={t('support.amount')} value={amount} onChange={(e) => setAmount(e.currentTarget.value)}>
          {[100, 300, 500, 1000, 2000].map((c) => (
            <option key={c} value={c}>
              {formatMoney(cents(c), currency, locale)}
            </option>
          ))}
        </Select>
        <Select label={t('m.drops.form.currency')} value={currency} onChange={(e) => setCurrency(e.currentTarget.value as Currency)}>
          {CURRENCIES.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </Select>
        <TextField label={t('support.messageOptional')} value={message} onChange={(e) => setMessage(e.currentTarget.value)} maxLength={200} />
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          {t('m.money.fee')}
        </p>
        <Button type="submit">{t('shop.continuePayment')}</Button>
      </form>
    </BottomSheet>
  );
}
