import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signDevWebhook } from '../src/lib/payments.ts';
import { as, signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';

/** Ways money could leak: payouts beyond earnings, lost or repeated webhooks, refunds outside the app, overselling. */
let t: BuiltApp;
let admin: TestUser;
beforeAll(async () => {
  t = await testApp();
  await t.ctx.db.query(`INSERT INTO feature_flags (key, enabled) VALUES ('ADS', true) ON CONFLICT (key) DO UPDATE SET enabled = true`);
  admin = await signUp(t.app, { birthDate: '1985-01-01' });
  await t.ctx.db.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [admin.id]);
});
afterAll(async () => {
  await t.ctx.db.query(`DELETE FROM feature_flags WHERE key = 'ADS'`);
  await t.close();
});

const ADULT = '1990-04-02';
const db = () => t.ctx.db;
const key = () => `k_${Math.random().toString(36).slice(2)}${Date.now()}`;
const adult = () => signUp(t.app, { birthDate: ADULT });
const orderStatus = async (id: string) => (await db().query(`SELECT status FROM orders WHERE id = $1`, [id])).rows[0].status as string;

/** Send the development provider's signed webhook about an order's payment. */
async function webhook(orderId: string, type: string, id = `evt_${type}_${key()}`) {
  const pay = (await db().query(`SELECT provider_ref, amount_cents FROM payments WHERE order_id = $1`, [orderId])).rows[0];
  const payload = JSON.stringify({ id, type, providerRef: pay.provider_ref, amountCents: pay.amount_cents });
  const sig = signDevWebhook(t.ctx.config.PAYMENTS_WEBHOOK_SECRET, payload);
  const r = await t.app.inject({
    method: 'POST',
    url: '/v1/payments/webhook/dev',
    payload,
    headers: { 'content-type': 'application/json', 'x-signature': sig },
  });
  return { status: r.statusCode, body: r.json() };
}

async function product(seller: TestUser, extra: Record<string, unknown> = {}) {
  const r = await as(t.app, seller).post('/v1/products', { title: `Thing ${key()}`, priceCents: 1000, ...extra });
  expect(r.status).toBe(201);
  return r.body.product.id as string;
}

async function order(buyer: TestUser, items: { productId: string; quantity?: number }[]) {
  const r = await as(t.app, buyer).post('/v1/orders', { items: items.map((i) => ({ quantity: 1, ...i })), idempotencyKey: key() });
  expect(r.status).toBe(201);
  return r.body.order.id as string;
}

describe('payouts', () => {
  it('pays out only what was earned, one request at a time, and checks again before it is verified', async () => {
    const seller = await adult();
    await db().query(`UPDATE users SET email_verified_at = now() WHERE id = $1`, [seller.id]);
    const buyer = await adult();
    // Nothing earned yet: nothing to pay out.
    const early = await as(t.app, seller).post('/v1/me/payouts', { amountCents: 10_000_000, currency: 'USD' });
    expect(early.status).toBe(400);
    expect(early.body.error.details).toEqual({ availableCents: 0 });

    const o = await order(buyer, [{ productId: await product(seller) }]);
    expect((await webhook(o, 'payment.succeeded')).status).toBe(200);
    // $10 less the 5% fee and processing (2.9% + 30¢), held for a week after the sale so an early refund or chargeback comes out of it.
    expect((await as(t.app, seller).get('/v1/me/earnings')).body.balances).toEqual([
      { currency: 'USD', grossCents: 1000, feeCents: 109, heldCents: 891, availableCents: 0 },
    ]);
    expect((await as(t.app, seller).post('/v1/me/payouts', { amountCents: 891, currency: 'USD' })).status).toBe(400);
    await db().query(`UPDATE orders SET paid_at = now() - interval '7 days 1 minute' WHERE id = $1`, [o]);
    expect((await as(t.app, seller).get('/v1/me/earnings')).body.balances).toEqual([
      { currency: 'USD', grossCents: 1000, feeCents: 109, heldCents: 0, availableCents: 891 },
    ]);
    expect((await as(t.app, seller).post('/v1/me/payouts', { amountCents: 892, currency: 'USD' })).status).toBe(400);
    // Two requests at once can't both spend the same balance.
    const both = await Promise.all([1, 2].map(() => as(t.app, seller).post('/v1/me/payouts', { amountCents: 891, currency: 'USD' })));
    expect(both.map((r) => r.status).sort()).toEqual([201, 400]);
    const payoutId = both.find((r) => r.status === 201)!.body.payout.id;
    expect((await as(t.app, seller).get('/v1/me/earnings')).body.balances[0].availableCents).toBe(0);

    // Refunded after the request: there's nothing left to cover it, so it can't be verified.
    expect((await as(t.app, seller).post(`/v1/orders/${o}/refund`, { reason: 'Changed my mind' })).body.status).toBe('succeeded');
    const listed = (await as(t.app, admin).get('/v1/admin/payouts')).body.items.find((p: any) => p.id === payoutId);
    expect(listed).toMatchObject({ amount_cents: 891, available_cents: -891 });
    expect((await as(t.app, admin).post(`/v1/admin/payouts/${payoutId}/verify`)).status).toBe(400);
    expect((await db().query(`SELECT status FROM payouts WHERE id = $1`, [payoutId])).rows[0].status).toBe('pending');
  });
});

describe('payment webhooks', () => {
  it('runs an event again when handling it failed the first time', async () => {
    const seller = await adult();
    const buyer = await adult();
    const o = await order(buyer, [{ productId: await product(seller) }]);
    // Handling fails once, as it would on a deadlock or a restart.
    await db().query(`CREATE OR REPLACE FUNCTION ypl_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$`);
    await db().query(`CREATE TRIGGER ypl_test_fail BEFORE UPDATE ON orders FOR EACH ROW WHEN (OLD.id = '${o}') EXECUTE FUNCTION ypl_test_fail()`);
    const id = `evt_retry_${key()}`;
    try {
      expect((await webhook(o, 'payment.succeeded', id)).status).toBe(500);
    } finally {
      await db().query(`DROP TRIGGER ypl_test_fail ON orders`);
      await db().query(`DROP FUNCTION ypl_test_fail()`);
    }
    expect(await orderStatus(o)).toBe('pending');
    // The provider's retry of the same event now goes through, and only once.
    expect((await webhook(o, 'payment.succeeded', id)).body).toEqual({ ok: true });
    expect(await orderStatus(o)).toBe('paid');
    expect((await webhook(o, 'payment.succeeded', id)).body).toEqual({ ok: true, duplicate: true });
  });

  it('refunds an order that sold out while its payment was on its way', async () => {
    const seller = await adult();
    const productId = await product(seller, { inventory: 1 });
    const [a, b] = [await adult(), await adult()];
    // Both could order the last one; only the first payment gets it.
    const first = await order(a, [{ productId }]);
    const second = await order(b, [{ productId }]);
    expect((await webhook(first, 'payment.succeeded')).status).toBe(200);
    expect((await webhook(second, 'payment.succeeded')).status).toBe(200);
    expect(await orderStatus(first)).toBe('paid');
    expect(await orderStatus(second)).toBe('refunded');
    expect((await db().query(`SELECT inventory FROM products WHERE id = $1`, [productId])).rows[0].inventory).toBe(0);
    const refund = await db().query(`SELECT r.reason, r.status FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE p.order_id = $1`, [second]);
    expect(refund.rows).toEqual([{ reason: 'Sold out before the payment arrived', status: 'succeeded' }]);
  });

  it('undoes an order refunded or disputed at the provider, once, and leaves refunds made here alone', async () => {
    const seller = await adult();
    const buyer = await adult();
    const productId = await product(seller);
    const refunded = await order(buyer, [{ productId }]);
    await webhook(refunded, 'payment.succeeded');
    // Refunded from the provider's dashboard: the order is undone and no longer counts as earnings.
    const id = `evt_refund_${key()}`;
    expect((await webhook(refunded, 'refund.succeeded', id)).status).toBe(200);
    expect(await orderStatus(refunded)).toBe('refunded');
    expect((await as(t.app, seller).get('/v1/me/earnings')).body.balances).toEqual([]);
    expect((await webhook(refunded, 'refund.succeeded', id)).body).toEqual({ ok: true, duplicate: true });

    // A chargeback does the same.
    const disputed = await order(buyer, [{ productId }]);
    await webhook(disputed, 'payment.succeeded');
    await webhook(disputed, 'payment.disputed');
    expect(await orderStatus(disputed)).toBe('refunded');

    // A refund made in the app is followed by the provider's own notice: nothing is refunded twice.
    const here = await order(buyer, [{ productId }]);
    await webhook(here, 'payment.succeeded');
    expect((await as(t.app, seller).post(`/v1/orders/${here}/refund`, {})).body.status).toBe('succeeded');
    await webhook(here, 'refund.succeeded');
    const rows = (
      await db().query(`SELECT r.reason FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE p.order_id = ANY($1) ORDER BY r.created_at`, [
        [refunded, disputed, here],
      ])
    ).rows;
    expect(rows.map((r) => r.reason)).toEqual(['Refunded at the payment provider', 'The buyer disputed the payment', null]);
  });

  it('refunds a subscription paid after it was cancelled or replaced', async () => {
    const creator = await adult();
    const fan = await adult();
    const planId = (await as(t.app, creator).post('/v1/creator/plans', { name: 'Supporters', priceCents: 500 })).body.plan.id;
    const first = (await as(t.app, fan).post(`/v1/creator/plans/${planId}/subscribe`, { idempotencyKey: key() })).body.payment.orderId;
    // Started again before paying: the first one is cancelled, but its payment could still go through.
    const second = (await as(t.app, fan).post(`/v1/creator/plans/${planId}/subscribe`, { idempotencyKey: key() })).body.payment.orderId;
    await webhook(first, 'payment.succeeded');
    expect(await orderStatus(first)).toBe('refunded');
    await webhook(second, 'payment.succeeded');
    expect(await orderStatus(second)).toBe('paid');
    const subs = await db().query(`SELECT order_id, status FROM creator_subscriptions WHERE subscriber_id = $1 ORDER BY created_at`, [fan.id]);
    expect(subs.rows).toEqual([
      { order_id: first, status: 'cancelled' },
      { order_id: second, status: 'active' },
    ]);
  });
});

describe('refunds', () => {
  it('lets a seller refund only an order that is all theirs', async () => {
    const [mine, theirs, buyer] = [await adult(), await adult(), await adult()];
    const o = await order(buyer, [{ productId: await product(mine, { priceCents: 100 }) }, { productId: await product(theirs, { priceCents: 50_000 }) }]);
    await webhook(o, 'payment.succeeded');
    expect((await as(t.app, mine).post(`/v1/orders/${o}/refund`, {})).status).toBe(404);
    expect(await orderStatus(o)).toBe('paid');
    expect((await as(t.app, admin).post(`/v1/orders/${o}/refund`, {})).body.status).toBe('succeeded');
  });
});

describe('currencies', () => {
  it('charges currencies without a minor unit in whole units', async () => {
    const seller = await adult();
    const buyer = await adult();
    const odd = await product(seller, { priceCents: 1_000_050, currency: 'XOF' });
    const r = await as(t.app, buyer).post('/v1/orders', { items: [{ productId: odd, quantity: 1 }], idempotencyKey: key() });
    expect(r.status).toBe(400);
    expect(await order(buyer, [{ productId: await product(seller, { priceCents: 1_000_000, currency: 'XOF' }) }])).toBeTruthy();
    // Paid items start at about $1 in every currency; free ones are fine.
    expect((await as(t.app, seller).post('/v1/products', { title: 'Sticker', priceCents: 50 })).status).toBe(400);
    expect((await as(t.app, seller).post('/v1/products', { title: 'Sticker', priceCents: 0 })).status).toBe(201);
  });

  it('takes processing on top of the platform fee, and starts tips at about $1 in every currency', async () => {
    const creator = await adult();
    const fan = await adult();
    const tip = (amountCents: number, currency: string) =>
      as(t.app, fan).post(`/v1/users/${creator.id}/tips`, { amountCents, currency, idempotencyKey: key() });
    // ₦500 is about 30 US cents: processing would eat it, and tiny payments are how stolen cards get tested.
    expect((await tip(50_000, 'NGN')).status).toBe(400);
    const ok = await tip(100_000, 'NGN');
    expect(ok.status).toBe(201);
    const o = (await db().query(`SELECT platform_fee_cents, processing_fee_cents FROM orders WHERE id = $1`, [ok.body.payment.orderId])).rows[0];
    // 5% and Paystack's 1.5% (its ₦100 only starts at ₦2,500).
    expect(o).toEqual({ platform_fee_cents: 5_000, processing_fee_cents: 1_500 });
    const usd = await tip(100, 'USD');
    expect((await db().query(`SELECT processing_fee_cents FROM orders WHERE id = $1`, [usd.body.payment.orderId])).rows[0].processing_fee_cents).toBe(33);
  });

  it('keeps ad bids and budgets to about the same worth in every currency', async () => {
    const shop = await adult();
    const post = (await as(t.app, shop).post('/v1/posts', { body: 'Fresh bread every morning' })).body.post;
    const create = (body: Record<string, unknown>) => as(t.app, shop).post('/v1/ads/campaigns', { postId: post.id, name: 'Bread', ...body });
    // 10,000 kobo is about 7 US cents per 1,000 impressions: far below the least a USD campaign can bid.
    expect((await create({ currency: 'NGN', cpmCents: 10_000 })).status).toBe(400);
    expect((await create({ currency: 'XYZ' })).status).toBe(400);
    const ngn = await create({ currency: 'NGN' });
    expect(ngn.status).toBe(201);
    expect(ngn.body.campaign.cpmCents).toBe(500_000);
    const fund = (amountCents: number) => as(t.app, shop).post(`/v1/ads/campaigns/${ngn.body.campaign.id}/fund`, { amountCents, idempotencyKey: key() });
    expect((await fund(1000)).status).toBe(400);
    expect((await fund(500_000)).status).toBe(201);
  });
});
