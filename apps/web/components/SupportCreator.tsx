'use client';

import { useEffect, useState } from 'react';
import { BottomSheet, Button, Card, Select, TextField } from '@yapilapi/design-system';
import { CURRENCIES, formatMoney } from '@yapilapi/shared';
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
  const { toast, locale, flags } = useSession();
  const checkout = useCheckout();
  const [data, setData] = useState<Awaited<ReturnType<typeof api.economy.plans>> | null>(null);
  const [tipping, setTipping] = useState(false);

  useEffect(() => {
    api.economy.plans(userId).then(setData, () => {});
  }, [userId]);

  if (flags.COMMERCE === false || !data || (!data.items.length && !isCreator)) return null;
  const sub = data.mySubscription;

  return (
    <Card title={`Support ${name}`} subtitle="A 5% platform fee applies. You can cancel a subscription any time.">
      <div className="stack-sm">
        {data.items.map((p) => (
          <div key={p.id} className="row" style={{ justifyContent: 'space-between' }}>
            <span>
              <strong>{p.name}</strong> · {formatMoney(p.priceCents, p.currency, locale)} a month
              {p.description ? <span className="muted"> · {p.description}</span> : null}
            </span>
            {sub?.plan_id === p.id ? (
              <span className="muted">{sub.status === 'active' ? 'Subscribed' : 'Waiting for payment'}</span>
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
                      label: `${p.name} for ${name}, ${formatMoney(p.priceCents, p.currency, locale)} a month`,
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
                Subscribe
              </Button>
            )}
          </div>
        ))}
        <Button variant="secondary" size="sm" onClick={() => setTipping(true)}>
          Send a tip
        </Button>
      </div>
      <TipSheet open={tipping} onClose={() => setTipping(false)} userId={userId} name={name} />
    </Card>
  );
}

/** Send a tip. With a liveId it's a gift: once paid, it appears in that live's chat for everyone watching. */
export function TipSheet({ open, onClose, userId, name, liveId }: { open: boolean; onClose: () => void; userId: string; name: string; liveId?: string }) {
  const { toast, locale } = useSession();
  const checkout = useCheckout();
  const [amount, setAmount] = useState('300');
  const [currency, setCurrency] = useState('USD');
  const [message, setMessage] = useState('');
  return (
    <BottomSheet open={open} onClose={onClose} title={liveId ? `Send ${name} a gift` : `Tip ${name}`}>
      <form
        className="stack-sm"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const r = await api.economy.tip(userId, {
              amountCents: Math.round(Number(amount)),
              currency,
              message,
              liveId,
              idempotencyKey: crypto.randomUUID(),
            });
            setMessage('');
            onClose();
            checkout({
              orderId: r.payment.orderId,
              clientSecret: r.payment.clientSecret,
              provider: r.payment.provider,
              label: `${liveId ? 'Gift' : 'Tip'} for ${name}, ${formatMoney(Math.round(Number(amount)), currency, locale)}`,
              onPaid: () => toast(liveId ? 'Your gift is in the chat.' : 'Tip sent. Thank you.'),
            });
          } catch (err) {
            toast(errorMessage(err));
          }
        }}
      >
        <Select label="Amount" value={amount} onChange={(e) => setAmount(e.currentTarget.value)}>
          {[100, 300, 500, 1000, 2000].map((c) => (
            <option key={c} value={c}>
              {formatMoney(c, currency, locale)}
            </option>
          ))}
        </Select>
        <Select label="Currency" value={currency} onChange={(e) => setCurrency(e.currentTarget.value)}>
          {CURRENCIES.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </Select>
        <TextField label="Message (optional)" value={message} onChange={(e) => setMessage(e.currentTarget.value)} maxLength={200} />
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          A 5% platform fee applies.
        </p>
        <Button type="submit">Continue to payment</Button>
      </form>
    </BottomSheet>
  );
}
