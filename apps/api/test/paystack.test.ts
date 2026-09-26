import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { devPaymentProvider, paymentRegistry, paystackPaymentProvider, signPaystackWebhook } from '../src/lib/payments.ts';
import { loadConfig } from '../src/config.ts';
import { as, signUp, testApp } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';

const SECRET = 'sk_test_paystack_fake';
const PUBLIC = 'pk_test_paystack_fake';

/** A stand-in for api.paystack.co: records every call and answers like Paystack does. Nothing leaves the machine. */
function fakePaystack() {
  const calls: { url: string; auth: string | null; body: any }[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? '{}'));
    calls.push({ url, auth: new Headers(init?.headers).get('authorization'), body });
    if (url.endsWith('/transaction/initialize'))
      return Response.json({
        status: true,
        message: 'Authorization URL created',
        data: { authorization_url: `https://checkout.paystack.com/${body.reference}`, access_code: 'ac_1', reference: body.reference },
      });
    if (url.endsWith('/refund')) return Response.json({ status: true, message: 'Refund has been queued', data: { status: 'pending', amount: body.amount } });
    return Response.json({ status: false, message: 'Not found' }, { status: 404 });
  }) as typeof globalThis.fetch;
  return { calls, fetch: fakeFetch };
}

const chargeSuccess = (reference: string, amount: number, currency: string, id = Math.floor(Math.random() * 1e9)) =>
  JSON.stringify({ event: 'charge.success', data: { id, reference, amount, currency, status: 'success', channel: 'mobile_money' } });

describe('Paystack provider', () => {
  it('initializes a hosted checkout with the amount in the subunit, the currency and the buyer email', async () => {
    const fake = fakePaystack();
    const p = paystackPaymentProvider({ secretKey: SECRET, publicKey: PUBLIC, callbackUrl: 'https://yapilapi.test/checkout/done', fetch: fake.fetch });
    const orderId = '11111111-2222-3333-4444-555555555555';
    await expect(p.createIntent({ amountCents: 250_000, currency: 'NGN', orderId, idempotencyKey: 'k_12345678' })).rejects.toThrow();
    const intent = await p.createIntent({ amountCents: 250_000, currency: 'ngn', orderId, idempotencyKey: 'k_12345678', email: 'ada@example.test' });
    expect(intent).toEqual({ providerRef: `ypl-${orderId}`, status: 'requires_action', clientSecret: `https://checkout.paystack.com/ypl-${orderId}` });
    expect(fake.calls[0]).toEqual({
      url: 'https://api.paystack.co/transaction/initialize',
      auth: `Bearer ${SECRET}`,
      body: {
        email: 'ada@example.test',
        amount: 250_000,
        currency: 'NGN',
        reference: `ypl-${orderId}`,
        callback_url: 'https://yapilapi.test/checkout/done',
        metadata: { orderId },
      },
    });
    expect(p.currencies).toEqual(['NGN', 'GHS', 'KES', 'ZAR']);
    expect(p.publicConfig()).toEqual({ provider: 'paystack', publishableKey: PUBLIC });
  });

  it('checks the HMAC SHA512 signature of the raw body and maps charges and refunds', () => {
    const p = paystackPaymentProvider({ secretKey: SECRET, publicKey: PUBLIC, fetch: fakePaystack().fetch });
    const body = chargeSuccess('ypl-abc', 5000, 'ghs', 42);
    expect(p.verifyWebhook(body, { 'x-paystack-signature': signPaystackWebhook(SECRET, body) })).toEqual({
      id: 'paystack:charge.success:42',
      type: 'payment.succeeded',
      providerRef: 'ypl-abc',
      amountCents: 5000,
      currency: 'GHS',
    });
    expect(() => p.verifyWebhook(body, { 'x-paystack-signature': signPaystackWebhook('sk_wrong', body) })).toThrow();
    expect(() => p.verifyWebhook(body, {})).toThrow();
    // The signature covers the exact bytes: re-serialized JSON doesn't pass.
    expect(() => p.verifyWebhook(` ${body}`, { 'x-paystack-signature': signPaystackWebhook(SECRET, body) })).toThrow();
    const refund = JSON.stringify({ event: 'refund.processed', data: { id: 7, transaction_reference: 'ypl-abc', amount: 5000, currency: 'GHS' } });
    expect(p.verifyWebhook(refund, { 'x-paystack-signature': signPaystackWebhook(SECRET, refund) })).toMatchObject({
      type: 'refund.succeeded',
      providerRef: 'ypl-abc',
    });
    const other = JSON.stringify({ event: 'transfer.success', data: { id: 1 } });
    expect(p.verifyWebhook(other, { 'x-paystack-signature': signPaystackWebhook(SECRET, other) })).toBeNull();
  });

  it('refunds by transaction reference', async () => {
    const fake = fakePaystack();
    const p = paystackPaymentProvider({ secretKey: SECRET, publicKey: PUBLIC, fetch: fake.fetch });
    expect(await p.refund({ providerRef: 'ypl-abc', amountCents: 5000 })).toEqual({ status: 'succeeded' });
    expect(fake.calls[0]).toMatchObject({ url: 'https://api.paystack.co/refund', body: { transaction: 'ypl-abc', amount: 5000 } });
    const down = paystackPaymentProvider({
      secretKey: SECRET,
      publicKey: PUBLIC,
      fetch: (async () => Response.json({ status: false }, { status: 500 })) as typeof fetch,
    });
    expect(await down.refund({ providerRef: 'ypl-abc', amountCents: 5000 })).toEqual({ status: 'failed' });
  });

  it('is chosen by currency, with the default provider for everything else', () => {
    const dev = devPaymentProvider('s');
    const paystack = paystackPaymentProvider({ secretKey: SECRET, publicKey: PUBLIC });
    const reg = paymentRegistry(dev, [paystack]);
    expect(reg.forCurrency('NGN').name).toBe('paystack');
    expect(reg.forCurrency('kes').name).toBe('paystack');
    expect(reg.forCurrency('USD').name).toBe('dev');
    expect(reg.forCurrency('XOF').name).toBe('dev');
    expect(reg.byName('paystack')).toBe(paystack);
    expect(reg.byName('stripe')).toBeUndefined();
    expect(paymentRegistry(dev).publicConfig()).toEqual({ provider: 'dev' });
  });

  it('needs both keys', () => {
    const base = { DATABASE_URL: 'postgres://x/y' };
    expect(() => loadConfig({ ...base, PAYSTACK_SECRET_KEY: SECRET })).toThrow(/PAYSTACK_PUBLIC_KEY/);
    expect(loadConfig({ ...base, PAYSTACK_SECRET_KEY: SECRET, PAYSTACK_PUBLIC_KEY: PUBLIC }).PAYSTACK_PUBLIC_KEY).toBe(PUBLIC);
  });
});

describe('checkout with Paystack for local currencies', () => {
  let t: BuiltApp;
  const fake = fakePaystack();
  const key = () => `k_${Math.random().toString(36).slice(2)}${Date.now()}`;
  beforeAll(async () => {
    t = await testApp({ PAYSTACK_SECRET_KEY: SECRET, PAYSTACK_PUBLIC_KEY: PUBLIC, WEB_ORIGIN: 'https://yapilapi.test' }, { paystackFetch: fake.fetch });
  });
  afterAll(async () => {
    await t.close();
  });

  const webhook = (body: string, secret = SECRET) =>
    t.app.inject({
      method: 'POST',
      url: '/v1/payments/webhook/paystack',
      payload: body,
      headers: { 'content-type': 'application/json', 'x-paystack-signature': signPaystackWebhook(secret, body) },
    });

  it('tells the browser about both providers', async () => {
    expect((await as(t.app, null).get('/v1/payments/config')).body).toEqual({
      provider: 'dev',
      providers: [{ provider: 'paystack', publishableKey: PUBLIC, currencies: ['NGN', 'GHS', 'KES', 'ZAR'] }],
    });
  });

  it('takes an NGN order through Paystack, reconciles amount and currency, and refunds through Paystack', async () => {
    const seller = await signUp(t.app);
    const buyer = await signUp(t.app);
    const product = (await as(t.app, seller).post('/v1/products', { kind: 'product', title: 'Ankara tote', priceCents: 1_200_000, currency: 'NGN' })).body
      .product;
    const order = await as(t.app, buyer).post('/v1/orders', { items: [{ productId: product.id, quantity: 1 }], idempotencyKey: key() });
    expect(order.status).toBe(201);
    const orderId = order.body.order.id;
    expect(order.body.payment).toEqual({ provider: 'paystack', clientSecret: `https://checkout.paystack.com/ypl-${orderId}`, orderId });
    const init = fake.calls.find((c) => c.body.reference === `ypl-${orderId}`)!;
    expect(init.body).toMatchObject({ email: buyer.email, amount: 1_200_000, currency: 'NGN', callback_url: 'https://yapilapi.test/checkout/done' });
    // The development shortcut only completes development payments.
    expect((await as(t.app, buyer).post('/v1/payments/dev/complete', { orderId })).status).toBe(404);

    const status = async () => (await as(t.app, buyer).get(`/v1/orders/${orderId}`)).body.order.status;
    // A forged signature is refused.
    expect((await webhook(chargeSuccess(`ypl-${orderId}`, 1_200_000, 'NGN'), 'sk_attacker')).statusCode).toBe(400);
    expect(await status()).toBe('pending');
    // The right amount in the wrong currency, or the wrong amount, isn't a payment for this order.
    expect((await webhook(chargeSuccess(`ypl-${orderId}`, 1_200_000, 'GHS'))).statusCode).toBe(200);
    expect(await status()).toBe('pending');
    expect((await webhook(chargeSuccess(`ypl-${orderId}`, 100, 'NGN'))).statusCode).toBe(200);
    expect(await status()).toBe('pending');
    const audits = await t.ctx.db.query(
      `SELECT action FROM audit_logs WHERE entity_id IN (SELECT id::text FROM payments WHERE order_id = $1) ORDER BY created_at`,
      [orderId],
    );
    expect(audits.rows.map((r) => r.action)).toEqual(['payment.currency_mismatch', 'payment.amount_mismatch']);

    const paid = chargeSuccess(`ypl-${orderId}`, 1_200_000, 'NGN', 777);
    expect((await webhook(paid)).json()).toEqual({ ok: true });
    expect(await status()).toBe('paid');
    // Paystack retries webhooks; a repeat is acknowledged and ignored.
    expect((await webhook(paid)).json()).toEqual({ ok: true, duplicate: true });

    expect((await as(t.app, seller).post(`/v1/orders/${orderId}/refund`, { reason: 'Out of stock' })).body.status).toBe('succeeded');
    expect(fake.calls.at(-1)).toMatchObject({ url: 'https://api.paystack.co/refund', body: { transaction: `ypl-${orderId}`, amount: 1_200_000 } });
    expect(await status()).toBe('refunded');
  });

  it('keeps other currencies on the default provider, and uses Paystack for tips and plans in local currency', async () => {
    const seller = await signUp(t.app);
    const buyer = await signUp(t.app);
    const usd = (await as(t.app, seller).post('/v1/products', { title: 'Print', priceCents: 2000, currency: 'USD' })).body.product;
    const order = await as(t.app, buyer).post('/v1/orders', { items: [{ productId: usd.id, quantity: 1 }], idempotencyKey: key() });
    expect(order.body.payment.provider).toBe('dev');
    expect((await as(t.app, buyer).post('/v1/payments/dev/complete', { orderId: order.body.order.id })).body.status).toBe('paid');

    const tip = await as(t.app, buyer).post(`/v1/users/${seller.id}/tips`, { amountCents: 2_000, currency: 'GHS', idempotencyKey: key() });
    expect(tip.status).toBe(201);
    expect(tip.body.payment.provider).toBe('paystack');
    const plan = (await as(t.app, seller).post('/v1/creator/plans', { name: 'Fans', priceCents: 50_000, currency: 'KES' })).body.plan;
    const sub = await as(t.app, buyer).post(`/v1/creator/plans/${plan.id}/subscribe`, { idempotencyKey: key() });
    expect(sub.body.payment).toMatchObject({ provider: 'paystack', clientSecret: `https://checkout.paystack.com/ypl-${sub.body.payment.orderId}` });
    expect((await webhook(chargeSuccess(`ypl-${sub.body.payment.orderId}`, 50_000, 'KES'))).statusCode).toBe(200);
    expect((await as(t.app, buyer).get(`/v1/users/${seller.id}/plans`)).body.mySubscription.status).toBe('active');
    // Local prices can be much larger numbers than USD ones, within a sensible limit.
    expect((await as(t.app, seller).post('/v1/creator/plans', { name: 'Big', priceCents: 5_000_000, currency: 'NGN' })).status).toBe(201);
    expect((await as(t.app, seller).post('/v1/creator/plans', { name: 'Too big', priceCents: 5_000_000, currency: 'USD' })).status).toBe(400);
    expect((await as(t.app, seller).post('/v1/products', { title: 'Odd', priceCents: 100, currency: 'ABC' })).status).toBe(400);
  });
});
