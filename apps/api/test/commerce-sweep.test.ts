import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signDevWebhook } from '../src/lib/payments.ts';
import { as, signUp, testApp } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';

/** Fixes from the commerce and money sweep: retried checkouts, subscriptions that ran out, refunds and stock, blocks, prices without cents. */
let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
  await t.ctx.db.query(`INSERT INTO feature_flags (key, enabled) VALUES ('ADS', true) ON CONFLICT (key) DO UPDATE SET enabled = true`);
});
afterAll(async () => {
  await t.ctx.db.query(`DELETE FROM feature_flags WHERE key = 'ADS'`);
  await t.close();
});

const db = () => t.ctx.db;
const key = () => `k_${Math.random().toString(36).slice(2)}${Date.now()}`;
const adult = () => signUp(t.app, { birthDate: '1990-04-02' });

/** The development provider's signed webhook saying an order was paid. */
async function paid(orderId: string) {
  const pay = (await db().query(`SELECT provider_ref, amount_cents FROM payments WHERE order_id = $1`, [orderId])).rows[0];
  const payload = JSON.stringify({ id: `evt_${key()}`, type: 'payment.succeeded', providerRef: pay.provider_ref, amountCents: pay.amount_cents });
  const r = await t.app.inject({
    method: 'POST',
    url: '/v1/payments/webhook/dev',
    payload,
    headers: { 'content-type': 'application/json', 'x-signature': signDevWebhook(t.ctx.config.PAYMENTS_WEBHOOK_SECRET, payload) },
  });
  expect(r.statusCode).toBe(200);
}

describe('retried checkouts', () => {
  it('answers a repeated tip, subscription or ad budget key with a plain 409 instead of a server error', async () => {
    const creator = await adult();
    const fan = await adult();
    const k = key();
    const tip = { amountCents: 500, currency: 'USD', idempotencyKey: k };
    expect((await as(t.app, fan).post(`/v1/users/${creator.id}/tips`, tip)).status).toBe(201);
    const again = await as(t.app, fan).post(`/v1/users/${creator.id}/tips`, tip);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('conflict');
    // Nothing was made twice.
    expect((await db().query(`SELECT count(*)::int AS n FROM tips WHERE from_id = $1`, [fan.id])).rows[0].n).toBe(1);

    const plan = (await as(t.app, creator).post('/v1/creator/plans', { name: 'Club', priceCents: 300 })).body.plan;
    const sk = key();
    expect((await as(t.app, fan).post(`/v1/creator/plans/${plan.id}/subscribe`, { idempotencyKey: sk })).status).toBe(201);
    expect((await as(t.app, fan).post(`/v1/creator/plans/${plan.id}/subscribe`, { idempotencyKey: sk })).status).toBe(409);

    const post = (await as(t.app, creator).post('/v1/posts', { kind: 'text', body: 'Sponsored soon', visibility: 'public' })).body.post;
    const camp = (await as(t.app, creator).post('/v1/ads/campaigns', { postId: post.id, name: 'Spring' })).body.campaign;
    const fk = key();
    expect((await as(t.app, creator).post(`/v1/ads/campaigns/${camp.id}/fund`, { amountCents: 2000, idempotencyKey: fk })).status).toBe(201);
    expect((await as(t.app, creator).post(`/v1/ads/campaigns/${camp.id}/fund`, { amountCents: 2000, idempotencyKey: fk })).status).toBe(409);
  });
});

describe('creator subscriptions', () => {
  it('a month that ran out is over: it leaves your list and you can subscribe again', async () => {
    const creator = await adult();
    const fan = await adult();
    const plan = (await as(t.app, creator).post('/v1/creator/plans', { name: 'Notes', priceCents: 300 })).body.plan;
    const first = await as(t.app, fan).post(`/v1/creator/plans/${plan.id}/subscribe`, { idempotencyKey: key() });
    await paid(first.body.payment.orderId);
    expect((await as(t.app, fan).get('/v1/me/subscriptions')).body.items).toHaveLength(1);
    expect((await as(t.app, creator).get('/v1/creator/subscribers')).body.active).toBe(1);
    expect((await as(t.app, fan).post(`/v1/creator/plans/${plan.id}/subscribe`, { idempotencyKey: key() })).status).toBe(409);

    // Nothing renews on its own: 30 days later it has ended.
    await db().query(`UPDATE creator_subscriptions SET current_period_end = now() - interval '1 minute' WHERE subscriber_id = $1`, [fan.id]);
    expect((await as(t.app, fan).get('/v1/me/subscriptions')).body.items).toEqual([]);
    expect((await as(t.app, fan).get(`/v1/users/${creator.id}/plans`)).body.mySubscription).toBeNull();
    expect((await as(t.app, creator).get('/v1/creator/subscribers')).body.active).toBe(0);

    const second = await as(t.app, fan).post(`/v1/creator/plans/${plan.id}/subscribe`, { idempotencyKey: key() });
    expect(second.status).toBe(201);
    await paid(second.body.payment.orderId);
    const statuses = (await db().query(`SELECT status FROM creator_subscriptions WHERE subscriber_id = $1 ORDER BY created_at`, [fan.id])).rows;
    expect(statuses.map((r) => r.status)).toEqual(['expired', 'active']);
  });
});

describe('orders', () => {
  it('a seller refunding an order puts its units back on sale', async () => {
    const seller = await adult();
    const buyer = await adult();
    const p = (await as(t.app, seller).post('/v1/products', { title: 'Jar', priceCents: 1200, inventory: 2 })).body.product;
    const o = await as(t.app, buyer).post('/v1/orders', { items: [{ productId: p.id, quantity: 2 }], idempotencyKey: key() });
    await paid(o.body.order.id);
    const stock = async () => (await db().query(`SELECT inventory FROM products WHERE id = $1`, [p.id])).rows[0].inventory;
    expect(await stock()).toBe(0);
    expect((await as(t.app, seller).post(`/v1/orders/${o.body.order.id}/refund`, {})).body).toEqual({ status: 'succeeded' });
    expect(await stock()).toBe(2);
    // A second refund changes nothing.
    expect((await as(t.app, seller).post(`/v1/orders/${o.body.order.id}/refund`, {})).status).toBe(400);
    expect(await stock()).toBe(2);
  });

  it('refuses a price checkout could never charge in a currency without cents', async () => {
    const seller = await adult();
    const half = await as(t.app, seller).post('/v1/products', { title: 'Basket', priceCents: 50_050, currency: 'XOF' });
    expect(half.status).toBe(400);
    expect(half.body.error.message).toBe('XOF amounts must be whole units.');
    expect((await as(t.app, seller).post('/v1/products', { title: 'Basket', priceCents: 50_000, currency: 'XOF' })).status).toBe(201);
    expect((await as(t.app, seller).post('/v1/creator/plans', { name: 'Club', priceCents: 100_050, currency: 'XOF' })).status).toBe(400);
  });

  it('blocks work both ways for buying from a shop by its address', async () => {
    const seller = await adult();
    const buyer = await adult();
    const p = (await as(t.app, seller).post('/v1/products', { title: 'Mug', priceCents: 1500 })).body.product;
    await as(t.app, seller).post(`/v1/users/${buyer.id}/block`);
    const refused = await as(t.app, buyer).post('/v1/orders', { items: [{ productId: p.id, quantity: 1 }], idempotencyKey: key() });
    expect(refused.status).toBe(404);
    await as(t.app, seller).del(`/v1/users/${buyer.id}/block`);
    await as(t.app, buyer).post(`/v1/users/${seller.id}/block`);
    expect((await as(t.app, buyer).post('/v1/orders', { items: [{ productId: p.id, quantity: 1 }], idempotencyKey: key() })).status).toBe(404);
    await as(t.app, buyer).del(`/v1/users/${seller.id}/block`);
    expect((await as(t.app, buyer).post('/v1/orders', { items: [{ productId: p.id, quantity: 1 }], idempotencyKey: key() })).status).toBe(201);
  });
});
