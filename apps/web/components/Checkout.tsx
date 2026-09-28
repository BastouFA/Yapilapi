'use client';

import dynamic from 'next/dynamic';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, BottomSheet, Button } from '@yapilapi/design-system';
import type { PaymentsConfig } from '@yapilapi/api-client';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';
import { LoadingBlock } from './Loading';

// Stripe's form downloads when a Stripe payment opens; the stand-in is about the card form's height.
const StripeStep = dynamic(() => import('./CheckoutStripe').then((m) => m.StripeStep), {
  ssr: false,
  loading: () => <LoadingBlock height={240} />,
});

interface PayRequest {
  orderId: string;
  clientSecret: string;
  /** The provider the API chose for this order's currency (e.g. 'paystack' for NGN). Defaults to the server's default provider. */
  provider?: string;
  /** What the person is paying for, e.g. "Tip for Ada, $3.00". */
  label: string;
  onPaid?: () => void;
}

const Ctx = createContext<(r: PayRequest) => void>(() => {});
/** Open checkout for an order the API just created. */
export const useCheckout = () => useContext(Ctx);

/** Paystack's hosted checkout. Anything else in clientSecret is not opened. */
const PAYSTACK_CHECKOUT = /^https:\/\/checkout\.paystack\.com\//;

/**
 * One checkout for everything that costs money (products, downloads,
 * services, tickets, tips, subscriptions, boosts, ad budget). With Stripe,
 * card details go straight to Stripe's Payment Element; with Paystack (local
 * currencies such as NGN, GHS, KES and ZAR) the person pays on Paystack's own
 * page with a card, bank or mobile money; with the development provider there
 * is a clearly labelled test payment instead. Either way the order is only
 * paid once the provider's signed webhook says so, which this sheet waits for.
 */
export function CheckoutProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<PayRequest | null>(null);
  const [config, setConfig] = useState<PaymentsConfig | null>(null);
  const { t } = useSession();
  useEffect(() => {
    api.payments.config().then(setConfig, () => setConfig({ provider: 'unavailable' }));
  }, []);
  const open = useCallback((r: PayRequest) => setReq(r), []);
  return (
    <Ctx.Provider value={open}>
      {children}
      <BottomSheet open={!!req} onClose={() => setReq(null)} title={t('checkout.title')}>
        {req && config ? <CheckoutBody key={req.orderId} req={req} config={config} onClose={() => setReq(null)} /> : null}
      </BottomSheet>
    </Ctx.Provider>
  );
}

function CheckoutBody({ req, config, onClose }: { req: PayRequest; config: PaymentsConfig; onClose: () => void }) {
  const { t } = useSession();
  const provider = req.provider ?? config.provider;
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
    // Mobile money is approved on the phone, which can take a few minutes.
    const tries = provider === 'paystack' ? 160 : 40;
    for (let i = 0; i < tries && !stop.current; i++) {
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
      setError(t('checkout.stillConfirming'));
    }
  }, [req, provider, t]);

  if (state === 'paid')
    return (
      <div className="stack-sm">
        <Alert tone="success" title={t('m.drops.purchase.paid')}>
          {req.label}
        </Alert>
        <Button onClick={onClose}>{t('m.common.done')}</Button>
      </div>
    );

  return (
    <div className="stack-sm">
      <p style={{ margin: 0, fontWeight: 600 }}>{req.label}</p>
      {error ? <Alert tone={state === 'error' ? 'warning' : 'danger'}>{error}</Alert> : null}
      {provider === 'paystack' ? (
        <PaystackStep url={req.clientSecret} waiting={state === 'confirming'} onOpened={confirm} />
      ) : provider === 'stripe' && config.provider === 'stripe' && config.publishableKey ? (
        <StripeStep publishableKey={config.publishableKey} clientSecret={req.clientSecret} busy={state === 'confirming'} onPaid={confirm} onError={setError} />
      ) : provider === 'dev' ? (
        <>
          <Alert tone="info" title={t('checkout.testTitle')}>
            {t('checkout.testBody')}
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
            {t('checkout.payTest')}
          </Button>
        </>
      ) : (
        <Alert tone="danger">{t('checkout.unavailable')}</Alert>
      )}
    </div>
  );
}

/**
 * Paystack: the person pays on Paystack's page (a new window), then comes back
 * here while we wait for Paystack's webhook. If the window is blocked, the
 * link still works.
 */
function PaystackStep({ url, waiting, onOpened }: { url: string; waiting: boolean; onOpened: () => void }) {
  const { t } = useSession();
  if (!PAYSTACK_CHECKOUT.test(url)) return <Alert tone="danger">{t('checkout.unavailable')}</Alert>;
  return (
    <>
      <p className="muted" style={{ margin: 0 }}>
        {t('checkout.paystackIntro')}
      </p>
      {waiting ? (
        <Alert tone="info" title={t('checkout.paystackWaitingTitle')}>
          {t('checkout.paystackWaiting')}{' '}
          <a href={url} target="_blank" rel="noopener noreferrer">
            {t('checkout.paystackReopen')}
          </a>
        </Alert>
      ) : (
        <Button
          onClick={() => {
            const w = window.open(url, 'paystack', 'popup,width=480,height=760');
            // Blocked pop-up: go to Paystack in this tab; its return page brings the person back.
            if (!w) window.location.assign(url);
            onOpened();
          }}
        >
          {t('checkout.paystackContinue')}
        </Button>
      )}
    </>
  );
}
