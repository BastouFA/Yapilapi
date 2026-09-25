'use client';

import { useState } from 'react';
import { Button } from '@yapilapi/design-system';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';

/**
 * Starts an order. The idempotency key is created once per click so a retry
 * never charges twice. Payment is completed on the provider's hosted page;
 * in development the dev provider leaves the order pending until its webhook fires.
 */
export function BuyButton({ productId }: { productId: string }) {
  const { toast, flags } = useSession();
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
          toast(r.order.status === 'paid' ? 'Order confirmed' : 'Order created. Complete payment to confirm it.');
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
