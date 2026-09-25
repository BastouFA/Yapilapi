import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '@yapilapi/database';
import { Client, createTestApp, signup, uniq, type TestApp, type TestUser } from './helpers.js';
import { block, insertImage, teenBirth } from './entity-helpers.js';
import {
  US_ADDR,
  balanceOf,
  buy,
  checkout,
  devProvider,
  idem,
  key,
  mkProduct,
  payWith,
  sellerAccount,
  unbalancedTransactions,
} from './commerce-fixtures.js';
import { getDeletionHooks } from '../src/lib/hooks.js';
import { autoCompleteOrders, releaseExpiredReservations } from '../src/modules/commerce/index.js';
import { signDownloadToken } from '../src/modules/commerce/downloads.js';
import { getMediaRuntime } from '../src/modules/media/runtime.js';
import { newObjectKey } from '../src/modules/media/storage.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ PAYOUT_HOLD_DAYS: '0' });
});
afterAll(async () => {
  await t.close();
});

const anon = () => new Client(t);
const sql = (q: string, p: unknown[] = []) => t.ctx.db.query(q, p);
const stockOf = async (id: string) =>
  (await sql('SELECT stock, status FROM products WHERE id = $1', [id])).rows[0] as {
    stock: number | null;
    status: string;
  };

describe('products', () => {
  it('creates a draft, edits it, activates it and lists it; only the seller sees drafts', async () => {
    const seller = await signup(t);
    const other = await signup(t);
    const draft = await mkProduct(seller, {
      status: 'draft',
      title: 'Handmade mug',
      description: 'Blue',
      priceCents: 1800,
      stock: 10,
      taxBps: 800,
      delivery: { methods: ['post'], estimateDays: 3, shippingCents: 400 },
    });
    expect(draft).toMatchObject({
      status: 'draft',
      kind: 'physical',
      priceCents: 1800,
      currency: 'USD',
      taxBps: 800,
      stock: 10,
      inStock: true,
      viewer: { isSeller: true },
    });
    expect(draft.seller).toMatchObject({ type: 'user', id: seller.id });
    // Drafts are invisible to everyone else: 404, never 403.
    expect((await other.client.get(`/v1/products/${draft.id}`)).status).toBe(404);
    expect((await anon().get(`/v1/products/${draft.id}`)).status).toBe(404);
    expect((await other.client.get('/v1/products', { q: 'Handmade mug' })).body.items).toHaveLength(
      0,
    );
    expect(
      (await seller.client.get('/v1/me/products', { status: 'draft' })).body.items.map(
        (p: any) => p.id,
      ),
    ).toContain(draft.id);

    const patched = await seller.client.patch(`/v1/products/${draft.id}`, {
      status: 'active',
      priceCents: 1900,
    });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ status: 'active', priceCents: 1900 });
    const seen = await other.client.get(`/v1/products/${draft.id}`);
    expect(seen.status).toBe(200);
    expect(seen.body).not.toHaveProperty('stock'); // stock counts are seller-only; buyers see inStock
    expect(seen.body.viewer).toMatchObject({ isSeller: false });
    expect(
      (await anon().get('/v1/products', { q: 'handmade' })).body.items.map((p: any) => p.id),
    ).toContain(draft.id);
    const audit = await sql(
      `SELECT count(*)::int AS n FROM audit_logs WHERE target_id = $1 AND action IN ('product.created','product.updated')`,
      [draft.id],
    );
    expect(audit.rows[0].n).toBe(2);
  });

  it('validates input and enforces the seller rules', async () => {
    const seller = await signup(t);
    const post = (b: Record<string, unknown>) =>
      seller.client.post('/v1/products', {
        title: 'Thing here',
        priceCents: 500,
        currency: 'USD',
        ...b,
      });
    expect(
      (
        await anon().post('/v1/products', {
          kind: 'digital',
          title: 'x',
          priceCents: 1,
          currency: 'USD',
        })
      ).status,
    ).toBe(401);
    expect((await post({ kind: 'physical' })).status).toBe(400); // physical needs stock
    expect((await post({ kind: 'service', stock: 3 })).status).toBe(400); // only physical tracks stock
    expect((await post({ kind: 'ticket' })).status).toBe(400); // tickets come from events
    expect((await post({ kind: 'service', priceCents: 0 })).status).toBe(400);
    expect((await post({ kind: 'service', priceCents: 1.5 })).status).toBe(400);
    expect((await post({ kind: 'service', currency: 'XXX' })).status).toBe(400);
    expect((await post({ kind: 'digital', status: 'active' })).status).toBe(400); // no files yet
    expect((await post({ kind: 'service', taxBps: 99999 })).status).toBe(400);
    const teen = await signup(t, { birthDate: teenBirth() });
    expect(
      (
        await teen.client.post('/v1/products', {
          kind: 'service',
          title: 'Teen thing',
          priceCents: 500,
          currency: 'USD',
        })
      ).status,
    ).toBe(422);
    // A sold-out product flips automatically and back.
    const p = await mkProduct(seller, { stock: 1 });
    expect((await seller.client.patch(`/v1/products/${p.id}`, { stock: 0 })).body.status).toBe(
      'sold_out',
    );
    expect((await seller.client.patch(`/v1/products/${p.id}`, { stock: 4 })).body).toMatchObject({
      status: 'active',
      inStock: true,
    });
    expect((await seller.client.patch(`/v1/products/${p.id}`, {})).status).toBe(400);
  });

  it('authorization: other users cannot edit or delete (404), anonymous gets 401, delete is soft', async () => {
    const seller = await signup(t);
    const other = await signup(t);
    const p = await mkProduct(seller);
    expect((await other.client.patch(`/v1/products/${p.id}`, { title: 'Hijacked' })).status).toBe(
      404,
    );
    expect((await other.client.del(`/v1/products/${p.id}`)).status).toBe(404);
    expect((await other.client.put(`/v1/products/${p.id}/media`, { mediaIds: [] })).status).toBe(
      404,
    );
    expect((await anon().patch(`/v1/products/${p.id}`, { title: 'Hijacked' })).status).toBe(401);
    expect((await seller.client.del(`/v1/products/${p.id}`)).status).toBe(204);
    expect((await anon().get(`/v1/products/${p.id}`)).status).toBe(404);
    expect(
      (await sql('SELECT deleted_at FROM products WHERE id = $1', [p.id])).rows[0].deleted_at,
    ).not.toBeNull();
  });

  it("hides a blocked seller's products both ways", async () => {
    const seller = await signup(t);
    const buyer = await signup(t);
    const p = await mkProduct(seller);
    expect((await buyer.client.get(`/v1/products/${p.id}`)).status).toBe(200);
    await block(buyer, seller);
    expect((await buyer.client.get(`/v1/products/${p.id}`)).status).toBe(404);
    expect(
      (await buyer.client.get('/v1/products', { sellerId: seller.id })).body.items,
    ).toHaveLength(0);
    expect((await checkout(buyer, [{ productId: p.id, quantity: 1 }])).status).toBe(404);
  });

  it('business products: catalog permission (owner/admin/editor yes, support no), other users 404', async () => {
    const owner = await signup(t);
    const biz = (
      await owner.client.post('/v1/businesses', { name: `Shop ${uniq('b')}`, category: 'retail' })
    ).body;
    const mk = async (role: 'admin' | 'editor' | 'support') => {
      const u = await signup(t);
      expect(
        (
          await owner.client.post(`/v1/businesses/${biz.id}/invitations`, {
            username: u.username,
            role,
          })
        ).status,
      ).toBe(201);
      expect((await u.client.post(`/v1/businesses/${biz.id}/invitation/accept`)).status).toBe(200);
      return u;
    };
    const [admin, support] = [await mk('admin'), await mk('support')];
    const stranger = await signup(t);
    const create = (u: TestUser) =>
      u.client.post('/v1/products', {
        kind: 'service',
        title: 'Haircut deluxe',
        priceCents: 3000,
        currency: 'USD',
        businessId: biz.id,
        status: 'active',
      });
    expect((await create(stranger)).status).toBe(404);
    expect((await create(support)).status).toBe(403);
    const made = await create(admin);
    expect(made.status).toBe(201);
    expect(made.body.seller).toMatchObject({ type: 'business', id: biz.id });
    expect(
      (await owner.client.patch(`/v1/products/${made.body.id}`, { priceCents: 3500 })).status,
    ).toBe(200);
    expect(
      (await support.client.patch(`/v1/products/${made.body.id}`, { priceCents: 1 })).status,
    ).toBe(403);
    expect(
      (await stranger.client.patch(`/v1/products/${made.body.id}`, { priceCents: 1 })).status,
    ).toBe(404);
    expect(
      (await admin.client.get('/v1/me/products', { businessId: biz.id })).body.items,
    ).toHaveLength(1);
    expect((await stranger.client.get('/v1/me/products', { businessId: biz.id })).status).toBe(404);
  });

  it("media: only the seller's own public images, in order", async () => {
    const seller = await signup(t);
    const other = await signup(t);
    const p = await mkProduct(seller);
    const [a, b] = [await insertImage(t, seller.id), await insertImage(t, seller.id)];
    const foreign = await insertImage(t, other.id);
    const priv = await insertImage(t, seller.id, { purpose: 'attachment' });
    const ok = await seller.client.put(`/v1/products/${p.id}/media`, { mediaIds: [b, a] });
    expect(ok.status).toBe(200);
    expect(ok.body.media.map((m: any) => m.id)).toEqual([b, a]);
    expect(
      (await seller.client.put(`/v1/products/${p.id}/media`, { mediaIds: [foreign] })).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await seller.client.put(`/v1/products/${p.id}/media`, { mediaIds: [priv] })).status,
    ).toBeGreaterThanOrEqual(400);
    expect((await anon().get(`/v1/products/${p.id}`)).body.media).toHaveLength(2); // the failed calls changed nothing
  });

  it('lists with filters and keyset pagination', async () => {
    const seller = await signup(t);
    const tag = uniq('zz');
    for (let i = 0; i < 5; i++)
      await mkProduct(seller, {
        title: `${tag} item ${i}`,
        priceCents: 1000 + i * 100,
        kind: i % 2 ? 'service' : 'physical',
        ...(i % 2 ? { stock: null } : {}),
      });
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const r: any = await anon().get('/v1/products', {
        q: tag,
        limit: '2',
        ...(cursor ? { cursor } : {}),
      });
      expect(r.status).toBe(200);
      seen.push(...r.body.items.map((p: any) => p.id));
      cursor = r.body.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(5);
    expect((await anon().get('/v1/products', { q: tag, kind: 'service' })).body.items).toHaveLength(
      2,
    );
    expect(
      (await anon().get('/v1/products', { q: tag, minPriceCents: '1200', maxPriceCents: '1300' }))
        .body.items,
    ).toHaveLength(2);
    expect((await anon().get('/v1/products', { q: '%' })).body.items).toHaveLength(0); // wildcards are escaped
  });
});

describe('orders: server-side pricing and idempotency', () => {
  it('prices on the server (client-sent prices are ignored), with explicit shipping and tax placeholders and the platform fee on the subtotal', async () => {
    const seller = await signup(t);
    const buyer = await signup(t);
    const p = await mkProduct(seller, {
      priceCents: 2000,
      stock: 10,
      taxBps: 1000,
      delivery: { methods: ['post'], shippingCents: 500 },
    });
    const r = await checkout(
      buyer,
      [{ productId: p.id, quantity: 2, unitPriceCents: 1, priceCents: 1 }],
      { extra: { totalCents: 1 } },
    );
    expect(r.status).toBe(201);
    // 2 x 20.00 = 40.00 + 10% tax (4.00) + flat shipping 5.00
    expect(r.body.order).toMatchObject({
      status: 'pending_payment',
      subtotalCents: 4000,
      taxCents: 400,
      shippingCents: 500,
      totalCents: 4900,
      currency: 'USD',
      refundedCents: 0,
    });
    expect(r.body.order.items[0]).toMatchObject({
      quantity: 2,
      unitPriceCents: 2000,
      lineTotalCents: 4000,
    });
    expect(r.body.order).not.toHaveProperty('platformFeeCents'); // buyers never see the seller's fee
    const row = (
      await sql(
        'SELECT platform_fee_cents, total_cents, reserved_until FROM orders WHERE id = $1',
        [r.body.order.id],
      )
    ).rows[0];
    expect(row.platform_fee_cents).toBe(200); // 5% of the 4000 subtotal only
    expect(row.reserved_until).not.toBeNull();
    expect((await stockOf(p.id)).stock).toBe(8); // reserved immediately
    // price changes after checkout do not change the order
    await seller.client.patch(`/v1/products/${p.id}`, { priceCents: 9999 });
    expect((await buyer.client.get(`/v1/orders/${r.body.order.id}`)).body.totalCents).toBe(4900);
  });

  it('is idempotent: same key + same payload returns the same order; different payload is 409; the key is required', async () => {
    const seller = await signup(t);
    const buyer = await signup(t);
    const p = await mkProduct(seller, { stock: 3 });
    const k = key();
    const a = await checkout(buyer, [{ productId: p.id, quantity: 1 }], { key: k });
    const b = await checkout(buyer, [{ quantity: 1, productId: p.id }], { key: k }); // same content, different key order
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({ replayed: true });
    expect(b.body.order.id).toBe(a.body.order.id);
    expect(b.headers['idempotent-replayed']).toBe('true');
    const clash = await checkout(buyer, [{ productId: p.id, quantity: 2 }], { key: k });
    expect(clash.status).toBe(409);
    expect(clash.body.error.details).toMatchObject({ reason: 'idempotency_key_reuse' });
    expect((await stockOf(p.id)).stock).toBe(2); // one unit reserved, not two
    expect(
      Number(
        (await sql('SELECT count(*)::int AS n FROM orders WHERE buyer_id = $1', [buyer.id])).rows[0]
          .n,
      ),
    ).toBe(1);
    const noKey = await buyer.client.post('/v1/orders', {
      items: [{ productId: p.id, quantity: 1 }],
      shippingAddress: US_ADDR,
    });
    expect(noKey.status).toBe(400);
    expect(
      (
        await buyer.client.request('POST', '/v1/orders', {
          headers: idem('short'),
          body: { items: [{ productId: p.id }], shippingAddress: US_ADDR },
        })
      ).status,
    ).toBe(400);
    // Another user with the same key gets their own order (keys are per buyer).
    const other = await signup(t);
    const c = await checkout(other, [{ productId: p.id, quantity: 1 }], { key: k });
    expect(c.status).toBe(201);
    expect(c.body.order.id).not.toBe(a.body.order.id);
  });

  it('concurrent identical requests with one key create exactly one order and reserve stock once', async () => {
    const seller = await signup(t);
    const buyer = await signup(t);
    const p = await mkProduct(seller, { stock: 5 });
    const k = key();
    const rs = await Promise.all(
      Array.from({ length: 6 }, () =>
        checkout(buyer, [{ productId: p.id, quantity: 2 }], { key: k }),
      ),
    );
    expect(rs.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(new Set(rs.map((r) => r.body.order.id)).size).toBe(1);
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect((await stockOf(p.id)).stock).toBe(3);
  });

  it('rejects invalid carts', async () => {
    const seller = await signup(t);
    const seller2 = await signup(t);
    const buyer = await signup(t);
    const a = await mkProduct(seller);
    const b = await mkProduct(seller2);
    const draft = await mkProduct(seller, { status: 'draft' });
    const svc = await mkProduct(seller, { kind: 'service', stock: null });
    expect((await anon().post('/v1/orders', { items: [{ productId: a.id }] })).status).toBe(401);
    expect((await checkout(buyer, [])).status).toBe(400);
    expect((await checkout(buyer, [{ productId: a.id, quantity: 0 }])).status).toBe(400);
    expect(
      (
        await checkout(buyer, [
          { productId: a.id, quantity: 1 },
          { productId: a.id, quantity: 1 },
        ])
      ).status,
    ).toBe(400);
    expect(
      (await checkout(buyer, [{ productId: '00000000-0000-4000-8000-000000000000' }])).status,
    ).toBe(404);
    expect((await checkout(buyer, [{ productId: draft.id }])).status).toBe(404);
    const mixed = await checkout(buyer, [{ productId: a.id }, { productId: b.id }]);
    expect(mixed.status).toBe(422);
    expect(mixed.body.error.details).toMatchObject({ reason: 'mixed_sellers' });
    const noAddr = await checkout(buyer, [{ productId: a.id }], { shipping: null });
    expect(noAddr.status).toBe(422);
    expect(noAddr.body.error.details).toMatchObject({ reason: 'shipping_address_required' });
    expect((await checkout(buyer, [{ productId: a.id, quantity: 6 }])).status).toBe(409); // only 5 in stock
    expect((await checkout(seller, [{ productId: a.id }])).status).toBe(403); // cannot buy from yourself
    expect(
      (await checkout(buyer, [{ productId: svc.id, quantity: 2 }], { shipping: null })).status,
    ).toBe(400); // services are bought one at a time
    const teen = await signup(t, { birthDate: teenBirth() });
    expect((await checkout(teen, [{ productId: a.id }])).status).toBe(403);
  });

  it('never oversells: 10 buyers race for the last unit and exactly one wins', async () => {
    const seller = await signup(t);
    const p = await mkProduct(seller, { stock: 1 });
    const buyers = await Promise.all(Array.from({ length: 10 }, () => signup(t)));
    const rs = await Promise.all(
      buyers.map((b) => checkout(b, [{ productId: p.id, quantity: 1 }])),
    );
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(9);
    expect(rs.find((r) => r.status === 409)!.body.error.details).toMatchObject({
      reason: 'out_of_stock',
    });
    expect(await stockOf(p.id)).toEqual({ stock: 0, status: 'sold_out' });
    expect(
      Number(
        (
          await sql(
            `SELECT COALESCE(sum(quantity),0)::int AS n FROM order_items WHERE product_id = $1`,
            [p.id],
          )
        ).rows[0].n,
      ),
    ).toBe(1);
  });

  it('never oversells with bigger quantities either (stock 7, 6 buyers x 2)', async () => {
    const seller = await signup(t);
    const p = await mkProduct(seller, { stock: 7 });
    const buyers = await Promise.all(Array.from({ length: 6 }, () => signup(t)));
    const rs = await Promise.all(
      buyers.map((b) => checkout(b, [{ productId: p.id, quantity: 2 }])),
    );
    expect(rs.filter((r) => r.status === 201)).toHaveLength(3);
    expect((await stockOf(p.id)).stock).toBe(1);
  });

  it('cancel gives the stock back; expired reservations are released by the job (idempotently)', async () => {
    const seller = await signup(t);
    const buyer = await signup(t);
    const p = await mkProduct(seller, { stock: 2 });
    const o1 = (await checkout(buyer, [{ productId: p.id, quantity: 1 }])).body.order;
    expect((await stockOf(p.id)).stock).toBe(1);
    expect((await (await signup(t)).client.post(`/v1/orders/${o1.id}/cancel`)).status).toBe(404);
    const cancelled = await buyer.client.post(`/v1/orders/${o1.id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ status: 'cancelled', cancelReason: 'buyer_cancelled' });
    expect((await stockOf(p.id)).stock).toBe(2);
    expect((await buyer.client.post(`/v1/orders/${o1.id}/cancel`)).status).toBe(409);
    expect((await payWith(buyer, o1.id)).status).toBe(409); // cancelled orders cannot be paid

    const o2 = (await checkout(buyer, [{ productId: p.id, quantity: 2 }])).body.order;
    expect((await stockOf(p.id)).stock).toBe(0);
    expect(await releaseExpiredReservations(t.ctx)).toBe(0); // still inside the window
    const later = new Date(Date.now() + 3 * 3_600_000);
    expect(await releaseExpiredReservations(t.ctx, later)).toBeGreaterThanOrEqual(1);
    expect(await releaseExpiredReservations(t.ctx, later)).toBe(0); // idempotent
    expect((await buyer.client.get(`/v1/orders/${o2.id}`)).body).toMatchObject({
      status: 'cancelled',
      cancelReason: 'reservation_expired',
    });
    expect(await stockOf(p.id)).toEqual({ stock: 2, status: 'active' });
    expect(
      (
        await sql(
          `SELECT count(*)::int AS n FROM audit_logs WHERE action = 'order.reservation_expired' AND target_id = $1`,
          [o2.id],
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it('concurrent releases and payments cannot double-release stock', async () => {
    const seller = await signup(t);
    const buyer = await signup(t);
    const p = await mkProduct(seller, { stock: 3 });
    await checkout(buyer, [{ productId: p.id, quantity: 3 }]);
    const later = new Date(Date.now() + 3 * 3_600_000);
    await Promise.all([
      releaseExpiredReservations(t.ctx, later),
      releaseExpiredReservations(t.ctx, later),
      releaseExpiredReservations(t.ctx, later),
    ]);
    expect((await stockOf(p.id)).stock).toBe(3);
  });
});

describe('order visibility and the order life cycle', () => {
  it('buyers see their orders, sellers only paid orders containing their items, nobody else anything', async () => {
    const seller = await signup(t);
    const buyer = await signup(t);
    const other = await signup(t);
    const p = await mkProduct(seller);
    const o = (await checkout(buyer, [{ productId: p.id, quantity: 1 }])).body.order;
    const get = (u: Client) => u.get(`/v1/orders/${o.id}`);
    expect((await get(buyer.client)).status).toBe(200);
    expect((await get(seller.client)).status).toBe(404); // unpaid: the seller cannot see it yet
    expect((await get(other.client)).status).toBe(404);
    expect((await get(anon())).status).toBe(401);
    expect((await seller.client.get('/v1/seller/orders')).body.items).toHaveLength(0);
    expect((await payWith(buyer, o.id)).status).toBe(201);
    const s = await get(seller.client);
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({
      status: 'paid',
      platformFeeCents: 100,
      buyer: { id: buyer.id },
    });
    expect((await get(other.client)).status).toBe(404);
    expect((await seller.client.get('/v1/seller/orders')).body.items.map((x: any) => x.id)).toEqual(
      [o.id],
    );
    expect((await other.client.get('/v1/seller/orders')).body.items).toHaveLength(0);
    expect((await buyer.client.get('/v1/orders')).body.items.map((x: any) => x.id)).toEqual([o.id]);
    expect((await other.client.get('/v1/orders')).body.items).toHaveLength(0);
    expect((await buyer.client.get('/v1/orders', { status: 'cancelled' })).body.items).toHaveLength(
      0,
    );
  });

  it('paid -> fulfilled (seller) -> completed (buyer), enforced by the state machine; cancelling a paid order is refused', async () => {
    const seller = await signup(t);
    const buyer = await signup(t);
    const other = await signup(t);
    const p = await mkProduct(seller);
    const { orderId } = await buy(buyer, [{ productId: p.id, quantity: 1 }]);
    expect((await buyer.client.post(`/v1/orders/${orderId}/complete`)).status).toBe(409); // not fulfilled yet
    expect((await buyer.client.post(`/v1/orders/${orderId}/cancel`)).status).toBe(409); // paid orders are refunded, not cancelled
    expect((await buyer.client.post(`/v1/orders/${orderId}/fulfil`, {})).status).toBe(404); // the buyer is not the seller
    expect((await other.client.post(`/v1/orders/${orderId}/fulfil`, {})).status).toBe(404);
    expect((await anon().post(`/v1/orders/${orderId}/fulfil`, {})).status).toBe(401);
    const f = await seller.client.post(`/v1/orders/${orderId}/fulfil`, {
      carrier: 'PostCo',
      trackingNumber: 'PC123',
    });
    expect(f.status).toBe(200);
    expect(f.body).toMatchObject({
      status: 'fulfilled',
      tracking: { carrier: 'PostCo', trackingNumber: 'PC123' },
    });
    expect((await seller.client.post(`/v1/orders/${orderId}/fulfil`, {})).status).toBe(409); // already fulfilled
    expect((await other.client.post(`/v1/orders/${orderId}/complete`)).status).toBe(404);
    const c = await buyer.client.post(`/v1/orders/${orderId}/complete`);
    expect(c.status).toBe(200);
    expect(c.body.status).toBe('completed');
    expect((await buyer.client.post(`/v1/orders/${orderId}/complete`)).status).toBe(409);
    const actions = (
      await sql(`SELECT action FROM audit_logs WHERE target_type = 'order' AND target_id = $1`, [
        orderId,
      ])
    ).rows.map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining(['order.created', 'order.fulfilled', 'order.completed']),
    );
  });

  it('auto-completes fulfilled orders after the window, but not ones with an open refund request', async () => {
    const seller = await signup(t);
    const buyer = await signup(t);
    const p = await mkProduct(seller, { stock: 5 });
    const a = await buy(buyer, [{ productId: p.id, quantity: 1 }]);
    const b = await buy(buyer, [{ productId: p.id, quantity: 1 }]);
    for (const o of [a, b])
      expect((await seller.client.post(`/v1/orders/${o.orderId}/fulfil`, {})).status).toBe(200);
    expect(
      (await buyer.client.post(`/v1/orders/${b.orderId}/refunds`, { reason: 'It arrived broken' }))
        .status,
    ).toBe(201);
    const future = new Date(Date.now() + 40 * 86_400_000);
    await autoCompleteOrders(t.ctx, future);
    expect((await buyer.client.get(`/v1/orders/${a.orderId}`)).body.status).toBe('completed');
    expect((await buyer.client.get(`/v1/orders/${b.orderId}`)).body.status).toBe('fulfilled');
  });

  it('services are fulfilled by the seller, digital-only orders fulfil themselves', async () => {
    const seller = await signup(t);
    const buyer = await signup(t);
    const svc = await mkProduct(seller, {
      kind: 'service',
      stock: null,
      priceCents: 7500,
      title: 'Logo design',
    });
    const { orderId } = await buy(buyer, [{ productId: svc.id, quantity: 1 }], { shipping: null });
    expect((await buyer.client.get(`/v1/orders/${orderId}`)).body.status).toBe('paid');
    expect((await seller.client.post(`/v1/orders/${orderId}/fulfil`, {})).body.status).toBe(
      'fulfilled',
    );
  });
});

describe('digital products: files reach paid buyers only, through short-lived authorised links', () => {
  async function digitalProduct(seller: TestUser) {
    const storageKey = newObjectKey('m', 'pdf');
    await getMediaRuntime(t.ctx).adapter.put(
      storageKey,
      Buffer.from('%PDF-1.4 secret ebook contents'),
      { contentType: 'application/pdf' },
    );
    const { rows } = await sql(
      `INSERT INTO media (owner_id, kind, storage_key, mime_type, size_bytes, status, purpose) VALUES ($1,'file',$2,'application/pdf',30,'ready','attachment') RETURNING id`,
      [seller.id, storageKey],
    );
    const p = await mkProduct(seller, {
      kind: 'digital',
      stock: null,
      status: 'draft',
      priceCents: 900,
      title: 'The Ebook',
    });
    const set = await seller.client.put(`/v1/products/${p.id}/files`, { mediaIds: [rows[0].id] });
    expect(set.status).toBe(200);
    expect((await seller.client.patch(`/v1/products/${p.id}`, { status: 'active' })).status).toBe(
      200,
    );
    return { product: p, mediaId: rows[0].id as string };
  }

  it('rejects public media as a sellable file, and the download flow works end to end', async () => {
    const seller = await signup(t);
    const buyer = await signup(t);
    const other = await signup(t);
    const pub = await insertImage(t, seller.id);
    const draft = await mkProduct(seller, { kind: 'digital', stock: null, status: 'draft' });
    const bad = await seller.client.put(`/v1/products/${draft.id}/files`, { mediaIds: [pub] });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details).toMatchObject({ reason: 'file_not_private' });

    const { product } = await digitalProduct(seller);
    // Before purchase nobody but the seller can even learn that files exist.
    expect((await buyer.client.get(`/v1/products/${product.id}/downloads`)).status).toBe(404);
    expect((await anon().get(`/v1/products/${product.id}/downloads`)).status).toBe(401);
    expect((await seller.client.get(`/v1/products/${product.id}/downloads`)).status).toBe(200);
    const o = await checkout(buyer, [{ productId: product.id }], { shipping: null });
    expect((await buyer.client.get(`/v1/products/${product.id}/downloads`)).status).toBe(404); // ordered but unpaid
    expect((await payWith(buyer, o.body.order.id)).status).toBe(201);
    expect((await buyer.client.get(`/v1/orders/${o.body.order.id}`)).body).toMatchObject({
      status: 'fulfilled',
      items: [{ entitlement: { kind: 'digital', status: 'granted' } }],
    });
    expect((await checkout(buyer, [{ productId: product.id }], { shipping: null })).status).toBe(
      409,
    ); // already owned

    const links = await buyer.client.get(`/v1/products/${product.id}/downloads`);
    expect(links.status).toBe(200);
    expect(links.body.files).toHaveLength(1);
    const url = links.body.files[0].url as string;
    expect(new Date(links.body.files[0].expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(
      t.ctx.config.DOWNLOAD_URL_TTL_SEC * 1000,
    );
    const got = await t.app.inject({
      method: 'GET',
      url,
      headers: { cookie: [...buyer.client.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
    });
    expect(got.statusCode).toBe(200);
    expect(got.body).toContain('secret ebook contents');
    expect(got.headers['cache-control']).toBe('private, no-store');
    expect(String(got.headers['content-disposition'])).toMatch(/^attachment;/);
    // A leaked link is useless to anyone else, unauthenticated, tampered with or expired.
    expect((await other.client.get(url)).status).toBe(404);
    expect((await anon().get(url)).status).toBe(401);
    expect((await buyer.client.get(`${url.slice(0, -3)}AAA`)).status).toBe(404);
    const stale = signDownloadToken(
      t.ctx,
      { u: buyer.id, p: product.id, m: links.body.files[0].id },
      Date.now() - 3_600_000,
    );
    expect((await buyer.client.get('/v1/downloads', { token: stale.token })).status).toBe(404);
    // Refund revokes access even for an already-issued link.
    const refund = await buyer.client.post(`/v1/orders/${o.body.order.id}/refunds`, {
      reason: 'Changed my mind',
    });
    expect(refund.status).toBe(201);
    expect(
      (await seller.client.post(`/v1/refunds/${refund.body.id}/approve`, {})).body.status,
    ).toBe('succeeded');
    expect((await buyer.client.get(url)).status).toBe(404);
    expect((await buyer.client.get(`/v1/products/${product.id}/downloads`)).status).toBe(404);
  });
});

describe('verified-purchaser reviews', () => {
  it('only buyers review, once per product, with transactional aggregates; refunds remove the right to review', async () => {
    const seller = await signup(t);
    const buyer = await signup(t);
    const buyer2 = await signup(t);
    const stranger = await signup(t);
    const p = await mkProduct(seller, { stock: 10 });
    const body = { rating: 5, body: 'Lovely' };
    expect((await stranger.client.post(`/v1/products/${p.id}/reviews`, body)).status).toBe(403);
    expect((await anon().post(`/v1/products/${p.id}/reviews`, body)).status).toBe(401);
    expect((await seller.client.post(`/v1/products/${p.id}/reviews`, body)).status).toBe(403);
    const unpaid = (await checkout(buyer, [{ productId: p.id }])).body.order;
    expect((await buyer.client.post(`/v1/products/${p.id}/reviews`, body)).status).toBe(403); // ordered but not paid
    await payWith(buyer, unpaid.id);
    const first = await buyer.client.post(`/v1/products/${p.id}/reviews`, body);
    expect(first.status).toBe(201);
    expect(
      (await buyer.client.post(`/v1/products/${p.id}/reviews`, { rating: 1, body: 'again' }))
        .status,
    ).toBe(409);
    expect(
      (await buyer.client.post(`/v1/products/${p.id}/reviews`, { rating: 9, body: 'x' })).status,
    ).toBe(400);
    await buy(buyer2, [{ productId: p.id }]);
    expect(
      (await buyer2.client.post(`/v1/products/${p.id}/reviews`, { rating: 2, body: 'Meh' })).status,
    ).toBe(201);
    let d = (await anon().get(`/v1/products/${p.id}`)).body;
    expect(d.rating).toEqual({ average: 3.5, count: 2 });
    expect(
      (await buyer.client.patch(`/v1/products/${p.id}/reviews/mine`, { rating: 4 })).status,
    ).toBe(200);
    d = (await anon().get(`/v1/products/${p.id}`)).body;
    expect(d.rating).toEqual({ average: 3, count: 2 });
    const list = await anon().get(`/v1/products/${p.id}/reviews`);
    expect(list.body.items).toHaveLength(2);
    expect(list.body.items[0]).toMatchObject({ verifiedPurchase: true });
    expect(
      (await stranger.client.patch(`/v1/products/${p.id}/reviews/mine`, { rating: 1 })).status,
    ).toBe(404);
    expect((await buyer2.client.del(`/v1/products/${p.id}/reviews/mine`)).status).toBe(204);
    d = (await anon().get(`/v1/products/${p.id}`)).body;
    expect(d.rating).toEqual({ average: 4, count: 1 });
    expect(
      (
        await buyer2.client.post(`/v1/products/${p.id}/reviews`, {
          rating: 5,
          body: 'Better on reflection',
        })
      ).status,
    ).toBe(201); // may review again after deleting
    // Concurrent reviews from one user: exactly one survives and the aggregate stays correct.
    const buyer3 = await signup(t);
    await buy(buyer3, [{ productId: p.id }]);
    const rs = await Promise.all(
      [1, 2, 3].map((n) =>
        buyer3.client.post(`/v1/products/${p.id}/reviews`, { rating: n + 1, body: 'race' }),
      ),
    );
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    const agg = (
      await sql(
        `SELECT rating_count, (SELECT count(*)::int FROM reviews WHERE target_id = $1 AND deleted_at IS NULL) AS real FROM products WHERE id = $1`,
        [p.id],
      )
    ).rows[0];
    expect(agg.rating_count).toBe(agg.real);
  });
});

describe('product-linked posts', () => {
  it('lets the seller promote a live product; posts.product_id links to it', async () => {
    const seller = await signup(t);
    const other = await signup(t);
    const p = await mkProduct(seller);
    const draft = await mkProduct(seller, { status: 'draft' });
    const r = await seller.client.post(`/v1/products/${p.id}/posts`, { body: 'New in the shop!' });
    expect(r.status).toBe(201);
    expect(r.body.post).toMatchObject({ body: 'New in the shop!' });
    const row = (
      await sql('SELECT product_id, kind, author_id FROM posts WHERE id = $1', [r.body.post.id])
    ).rows[0];
    expect(row).toMatchObject({ product_id: p.id, kind: 'product', author_id: seller.id });
    expect((await other.client.post(`/v1/products/${p.id}/posts`, { body: 'hijack' })).status).toBe(
      404,
    );
    expect((await anon().post(`/v1/products/${p.id}/posts`, { body: 'x' })).status).toBe(401);
    expect(
      (await seller.client.post(`/v1/products/${draft.id}/posts`, { body: 'not yet' })).status,
    ).toBe(409);
  });
});

describe('feature flag and account deletion', () => {
  it('COMMERCE off => every commerce endpoint is 404; on again => works', async () => {
    const seller = await signup(t);
    const buyer = await signup(t);
    const p = await mkProduct(seller);
    const o = (await checkout(buyer, [{ productId: p.id }])).body.order;
    await sql(`UPDATE feature_flags SET enabled = false WHERE key = 'COMMERCE'`);
    t.ctx.flags.invalidate();
    try {
      const calls: Array<[string, () => Promise<{ status: number }>]> = [
        ['browse', () => anon().get('/v1/products')],
        ['detail', () => buyer.client.get(`/v1/products/${p.id}`)],
        [
          'create',
          () =>
            seller.client.post('/v1/products', {
              kind: 'service',
              title: 'Nope nope',
              priceCents: 100,
              currency: 'USD',
            }),
        ],
        ['orders', () => buyer.client.get('/v1/orders')],
        ['order', () => buyer.client.get(`/v1/orders/${o.id}`)],
        ['checkout', () => checkout(buyer, [{ productId: p.id }])],
        ['cancel', () => buyer.client.post(`/v1/orders/${o.id}/cancel`)],
        ['reviews', () => buyer.client.get(`/v1/products/${p.id}/reviews`)],
        ['downloads', () => buyer.client.get(`/v1/products/${p.id}/downloads`)],
        ['seller orders', () => seller.client.get('/v1/seller/orders')],
      ];
      for (const [name, call] of calls)
        expect({ name, status: (await call()).status }).toEqual({ name, status: 404 });
    } finally {
      await sql(`UPDATE feature_flags SET enabled = true WHERE key = 'COMMERCE'`);
      t.ctx.flags.invalidate();
    }
    expect((await buyer.client.get(`/v1/orders/${o.id}`)).status).toBe(200);
  });

  it('account deletion archives listings and releases unpaid orders, keeping paid orders (financial records)', async () => {
    const seller = await signup(t);
    const buyer = await signup(t);
    const p = await mkProduct(seller, { stock: 4 });
    const paid = await buy(buyer, [{ productId: p.id, quantity: 1 }]);
    const unpaid = (await checkout(buyer, [{ productId: p.id, quantity: 2 }])).body.order;
    expect((await stockOf(p.id)).stock).toBe(1);
    for (const hook of getDeletionHooks())
      await withTransaction(t.ctx.db, (tx) => hook(t.ctx, tx, seller.id));
    expect(
      (await sql('SELECT status, deleted_at FROM products WHERE id = $1', [p.id])).rows[0],
    ).toMatchObject({ status: 'archived' });
    expect((await sql('SELECT status FROM orders WHERE id = $1', [unpaid.id])).rows[0].status).toBe(
      'cancelled',
    );
    expect(
      (await sql('SELECT status FROM orders WHERE id = $1', [paid.orderId])).rows[0].status,
    ).toBe('paid');
  });
});

describe('ledger invariants across everything above', () => {
  it('is balanced, and the seller balance equals net sales', async () => {
    expect(await unbalancedTransactions(t)).toEqual([]);
    const seller = await signup(t);
    const buyer = await signup(t);
    const p = await mkProduct(seller, { priceCents: 1234, stock: 3 });
    await buy(buyer, [{ productId: p.id, quantity: 3 }]);
    // 3 x 12.34 = 37.02; fee = floor/half-up of 5% = 1.851 -> 185 cents (integer minor units)
    expect(await balanceOf(t, sellerAccount(seller.id))).toBe(3702 - 185);
    expect(devProvider(t).name).toBe('dev');
  });
});
