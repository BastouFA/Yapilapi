'use client';

import { useState } from 'react';
import { Button } from '@yapilapi/design-system';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';
import { formatMoney } from '@yapilapi/shared';
import { useCheckout } from './Checkout';

/**
 * Starts an order and opens checkout for it. The idempotency key is created
 * once per click so a retry never charges twice.
 */
export function BuyButton({ productId, onPaid }: { productId: string; onPaid?: () => void }) {
  const { toast, flags } = useSession();
  const checkout = useCheckout();
  const [busy, setBusy] = useState(false);
  if (flags.COMMERCE === false) return null;
  return (
    <Button
      size="sm"
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const r = await api.orders.create([{ productId, quantity: 1 }], crypto.randomUUID());
          if (r.order.status === 'paid' || !r.payment) toast('Order confirmed');
          else
            checkout({
              orderId: r.order.id,
              clientSecret: r.payment.clientSecret,
              provider: r.payment.provider,
              label: `${(r.order.items as { title: string }[] | null)?.[0]?.title ?? 'Your order'}, ${formatMoney(r.order.totalCents, r.order.currency)}`,
              onPaid,
            });
        } catch (e) {
          toast(errorMessage(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      Buy
    </Button>
  );
}
