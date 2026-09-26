'use client';

import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, BottomSheet, Button } from '@yapilapi/design-system';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';

interface PayRequest {
  orderId: string;
  clientSecret: string;
  /** What the person is paying for, e.g. "Tip for Ada, $3.00". */
  label: string;
  onPaid?: () => void;
}

const Ctx = createContext<(r: PayRequest) => void>(() => {});
/** Open checkout for an order the API just created. */
export const useCheckout = () => useContext(Ctx);

let stripePromise: Promise<Stripe | null> | null = null;

/**
 * One checkout for everything that costs money (products, tickets, tips,
 * subscriptions, ad budget). With Stripe, card details go straight to Stripe's
 * Payment Element; with the development provider there is a clearly labelled
 * test payment instead. Either way the order is only paid once the provider's
 * signed webhook says so, which this sheet waits for.
 */
export function CheckoutProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<PayRequest | null>(null);
  const [config, setConfig] = useState<{ provider: string; publishableKey?: string } | null>(null);
  useEffect(() => {
    api.payments.config().then(setConfig, () => setConfig({ provider: 'unavailable' }));
  }, []);
  const open = useCallback((r: PayRequest) => setReq(r), []);
  return (
    <Ctx.Provider value={open}>
      {children}
      <BottomSheet open={!!req} onClose={() => setReq(null)} title="Checkout">
        {req && config ? <CheckoutBody key={req.orderId} req={req} config={config} onClose={() => setReq(null)} /> : null}
      </BottomSheet>
    </Ctx.Provider>
  );
}

function CheckoutBody({ req, config, onClose }: { req: PayRequest; config: { provider: string; publishableKey?: string }; onClose: () => void }) {
  const [state, setState] = useState<'ready' | 'confirming' | 'paid' | 'error'>('ready');
  const [error, setError] = useState<string | null>(null);
  // Stops the confirmation loop when the sheet closes. Reset on mount: React may mount, clean up and mount again.
  const stop = useRef(false);
  useEffect(() => {
    stop.current = false;
    return () => {
      stop.current = true;
    };
  }, []);

  /** The provider has taken the payment; wait for its webhook to mark the order paid. */
  const confirm = useCallback(async () => {
    setState('confirming');
    for (let i = 0; i < 40 && !stop.current; i++) {
      const o = await api.orders.get(req.orderId).catch(() => null);
      if (o?.order.status === 'paid') {
        setState('paid');
        req.onPaid?.();
        return;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (!stop.current) {
      setState('error');
      setError('Your payment is still being confirmed. You will get a notification when it is; you can close this.');
    }
  }, [req]);

  if (state === 'paid')
    return (
      <div className="stack-sm">
        <Alert tone="success" title="Paid">
          {req.label}
        </Alert>
        <Button onClick={onClose}>Done</Button>
      </div>
    );

  return (
    <div className="stack-sm">
      <p style={{ margin: 0, fontWeight: 600 }}>{req.label}</p>
      {error ? <Alert tone={state === 'error' ? 'warning' : 'danger'}>{error}</Alert> : null}
      {config.provider === 'stripe' && config.publishableKey ? (
        <Elements stripe={(stripePromise ??= loadStripe(config.publishableKey))} options={{ clientSecret: req.clientSecret }}>
          <StripeForm busy={state === 'confirming'} onPaid={confirm} onError={setError} />
        </Elements>
      ) : config.provider === 'dev' ? (
        <>
          <Alert tone="info" title="Test payment">
            This server uses the development payment provider. No money moves and no card is needed.
          </Alert>
          <Button
            loading={state === 'confirming'}
            onClick={async () => {
              setError(null);
              try {
                await api.payments.devComplete(req.orderId);
                await confirm();
              } catch (e) {
                setError(errorMessage(e));
                setState('ready');
              }
            }}
          >
            Pay (test)
          </Button>
        </>
      ) : (
        <Alert tone="danger">Payments aren&apos;t available right now. Try again later.</Alert>
      )}
    </div>
  );
}

function StripeForm({ busy, onPaid, onError }: { busy: boolean; onPaid: () => void; onError: (m: string | null) => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const { toast } = useSession();
  return (
    <form
      className="stack-sm"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!stripe || !elements) return;
        onError(null);
        const { error } = await stripe.confirmPayment({ elements, redirect: 'if_required', confirmParams: { return_url: window.location.href } });
        if (error) {
          onError(error.message ?? "The payment didn't go through.");
          return;
        }
        toast('Payment sent');
        onPaid();
      }}
    >
      <PaymentElement />
      <Button type="submit" loading={busy} disabled={!stripe || !elements}>
        Pay
      </Button>
    </form>
  );
}
