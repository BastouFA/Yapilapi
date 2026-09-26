import Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stripePaymentProvider } from '../src/lib/payments.ts';
import { as, signUp, testApp } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';

let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.close();
});

describe('checkout with the development provider', () => {
  it('tells the browser which provider to use and completes only your own test payments', async () => {
    expect((await as(t.app, null).get('/v1/payments/config')).body).toEqual({ provider: 'dev' });
    const seller = await signUp(t.app);
    const buyer = await signUp(t.app);
    const other = await signUp(t.app);
    const product = (await as(t.app, seller).post('/v1/products', { title: 'Linen tote', priceCents: 2500 })).body.product;
    const order = await as(t.app, buyer).post('/v1/orders', { items: [{ productId: product.id, quantity: 1 }], idempotencyKey: `k_${Date.now()}` });
    expect(order.body.order.status).toBe('pending');
    expect(order.body.payment.clientSecret).toBeTruthy();

    expect((await as(t.app, other).post('/v1/payments/dev/complete', { orderId: order.body.order.id })).status).toBe(404);
    const done = await as(t.app, buyer).post('/v1/payments/dev/complete', { orderId: order.body.order.id });
    expect(done.body.status).toBe('paid');
    expect((await as(t.app, buyer).get(`/v1/orders/${order.body.order.id}`)).body.order.status).toBe('paid');
    // Completing again is harmless.
    expect((await as(t.app, buyer).post('/v1/payments/dev/complete', { orderId: order.body.order.id })).body.status).toBe('paid');
  });
});

describe('Stripe provider', () => {
  const secret = 'whsec_test_secret';
  const provider = stripePaymentProvider({ secretKey: 'sk_test_offline', webhookSecret: secret, publishableKey: 'pk_test_x' });
  const sign = (payload: string) => new Stripe('sk_test_offline').webhooks.generateTestHeaderString({ payload, secret });
  const event = (type: string, object: object) => JSON.stringify({ id: `evt_${type}`, object: 'event', type, data: { object } });

  it('verifies signatures and maps payment events', () => {
    const body = event('payment_intent.succeeded', { id: 'pi_1', object: 'payment_intent', amount: 2500, amount_received: 2500, currency: 'usd' });
    expect(provider.verifyWebhook(body, { 'stripe-signature': sign(body) })).toEqual({
      id: 'evt_payment_intent.succeeded',
      type: 'payment.succeeded',
      providerRef: 'pi_1',
      amountCents: 2500,
    });
    expect(() => provider.verifyWebhook(body, { 'stripe-signature': 't=1,v1=bad' })).toThrow();
    expect(provider.publicConfig()).toEqual({ provider: 'stripe', publishableKey: 'pk_test_x' });
  });

  it('converts zero-decimal currencies back to hundredths and ignores other events', () => {
    const xof = event('payment_intent.succeeded', { id: 'pi_2', object: 'payment_intent', amount: 5000, amount_received: 5000, currency: 'xof' });
    expect(provider.verifyWebhook(xof, { 'stripe-signature': sign(xof) })?.amountCents).toBe(500_000);
    const refund = event('charge.refunded', { id: 'ch_1', object: 'charge', payment_intent: 'pi_2' });
    expect(provider.verifyWebhook(refund, { 'stripe-signature': sign(refund) })).toMatchObject({ type: 'refund.succeeded', providerRef: 'pi_2' });
    const other = event('customer.created', { id: 'cus_1', object: 'customer' });
    expect(provider.verifyWebhook(other, { 'stripe-signature': sign(other) })).toBeNull();
  });
});
