'use client';

import { useEffect, useState } from 'react';
import { BottomSheet, Button, Card, Select, TextField } from '@yapilapi/design-system';
import { formatMoney } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';

/**
 * Subscribe to or tip a creator. Payment is completed with the payment provider;
 * the subscription turns on when the provider confirms the charge.
 */
export function SupportCreator({ userId, name, isCreator }: { userId: string; name: string; isCreator: boolean }) {
  const { toast, locale, flags } = useSession();
  const [data, setData] = useState<Awaited<ReturnType<typeof api.economy.plans>> | null>(null);
  const [tipping, setTipping] = useState(false);
  const [amount, setAmount] = useState('300');
  const [currency, setCurrency] = useState('USD');
  const [message, setMessage] = useState('');

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
                    await api.economy.subscribe(p.id, crypto.randomUUID());
                    toast('Complete payment to start your subscription.');
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
      <BottomSheet open={tipping} onClose={() => setTipping(false)} title={`Tip ${name}`}>
        <form
          className="stack-sm"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api.economy.tip(userId, { amountCents: Math.round(Number(amount)), currency, message, idempotencyKey: crypto.randomUUID() });
              toast('Complete payment to send your tip.');
              setTipping(false);
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
            {['USD', 'EUR', 'GBP', 'NGN', 'XOF'].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </Select>
          <TextField label="Message (optional)" value={message} onChange={(e) => setMessage(e.currentTarget.value)} maxLength={200} />
          <Button type="submit">Continue to payment</Button>
        </form>
      </BottomSheet>
    </Card>
  );
}
