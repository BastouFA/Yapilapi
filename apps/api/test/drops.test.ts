import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, tx } from '@yapilapi/database';
import { processJobs } from '../src/lib/jobs.ts';
import { DROP_END_JOB, DROP_OPEN_JOB, DROP_RELEASE_JOB, takeDropStock } from '../src/lib/drops.ts';
import type { BuiltApp } from '../src/app.ts';
import { as, signUp, testApp, type TestUser } from './helpers.ts';

let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.close();
});

const db = () => t.ctx.db;
const inMin = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
let seq = 0;
const key = () => `drop_${Date.now().toString(36)}_${++seq}`;

async function product(seller: TestUser, extra: Record<string, unknown> = {}) {
  const r = await as(t.app, seller).post('/v1/products', { title: `Print ${++seq}`, priceCents: 1500, ...extra });
  expect(r.status).toBe(201);
  return r.body.product.id as string;
}

/** A published drop starting in an hour. */
async function scheduled(seller: TestUser, items: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  const c = await as(t.app, seller).post('/v1/drops', { title: 'Autumn prints', description: 'Six new prints.', startsAt: inMin(60), items, ...extra });
  expect(c.status).toBe(201);
  const p = await as(t.app, seller).post(`/v1/drops/${c.body.drop.id}/publish`);
  expect(p.status).toBe(200);
  expect(p.body.drop.status).toBe('scheduled');
  return c.body.drop.id as string;
}

/** Move a drop's start (and its queued jobs) into the past, then run the jobs. */
async function openNow(id: string) {
  await db().query(`UPDATE drops SET starts_at = now() - interval '1 second' WHERE id = $1`, [id]);
  await db().query(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE kind = $1 AND payload->>'id' = $2 AND status = 'queued'`, [DROP_OPEN_JOB, id]);
  await processJobs(db(), t.ctx.jobs, 50);
}

async function scheduledAndOpen(seller: TestUser, items: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  const id = await scheduled(seller, items, extra);
  await openNow(id);
  return id;
}

const order = (buyer: TestUser, productId: string, quantity = 1) =>
  as(t.app, buyer).post('/v1/orders', { items: [{ productId, quantity }], idempotencyKey: key() });

const notes = async (userId: string, type: string) =>
  (await db().query(`SELECT entity_type, entity_id, actor_id, data FROM notifications WHERE user_id = $1 AND type = $2 ORDER BY created_at`, [userId, type]))
    .rows;

const taken = async (dropId: string, productId: string) =>
  (await db().query(`SELECT taken FROM drop_items WHERE drop_id = $1 AND product_id = $2`, [dropId, productId])).rows[0].taken as number;

describe('scheduling a drop', () => {
  it('checks the times, the products and who may sell', async () => {
    const seller = await signUp(t.app);
    const other = await signUp(t.app);
    const mine = await product(seller);
    const theirs = await product(other);
    const service = await product(seller, { kind: 'service' });
    const s = as(t.app, seller);
    const base = { title: 'Launch', startsAt: inMin(60), items: [{ productId: mine }] };

    expect((await s.post('/v1/drops', { ...base, startsAt: inMin(1) })).body.error.details.fields.startsAt).toMatch(/at least 5 minutes/);
    expect((await s.post('/v1/drops', { ...base, startsAt: inMin(-60) })).status).toBe(400);
    expect((await s.post('/v1/drops', { ...base, startsAt: inMin(200 * 24 * 60) })).status).toBe(400);
    expect((await s.post('/v1/drops', { ...base, endsAt: inMin(65) })).body.error.details.fields.endsAt).toMatch(/15 minutes after/);
    expect((await s.post('/v1/drops', { ...base, endsAt: inMin(30) })).status).toBe(400);
    expect((await s.post('/v1/drops', { ...base, items: [] })).status).toBe(400);
    expect((await s.post('/v1/drops', { ...base, items: [{ productId: mine }, { productId: mine }] })).status).toBe(400);
    expect((await s.post('/v1/drops', { ...base, items: [{ productId: theirs }] })).status).toBe(400);
    expect((await s.post('/v1/drops', { ...base, items: [{ productId: service }] })).status).toBe(400);
    expect((await s.post('/v1/drops', { ...base, items: [{ productId: mine, quantity: 0 }] })).status).toBe(400);

    const ok = await s.post('/v1/drops', { ...base, endsAt: inMin(24 * 60), items: [{ productId: mine, quantity: 20, perBuyerLimit: 2 }] });
    expect(ok.status).toBe(201);
    expect(ok.body.drop).toMatchObject({
      status: 'draft',
      isSeller: true,
      items: [{ productId: mine, quantity: 20, perBuyerLimit: 2, remaining: 20, soldOut: false }],
    });
    expect(ok.body.drop.stats).toMatchObject({ waiting: 0, orders: 0, unitsSold: 0 });
    // A product can only be in one drop that is still to come.
    expect((await s.post('/v1/drops', base)).status).toBe(409);

    // Drafts are yours alone.
    expect((await as(t.app, other).get(`/v1/drops/${ok.body.drop.id}`)).status).toBe(404);
    expect((await as(t.app, null).get(`/v1/drops/${ok.body.drop.id}`)).status).toBe(404);

    // Edits before it opens; a draft whose time passed can be fixed and then published.
    await db().query(`UPDATE drops SET starts_at = now() - interval '1 hour', ends_at = NULL WHERE id = $1`, [ok.body.drop.id]);
    expect((await s.post(`/v1/drops/${ok.body.drop.id}/publish`)).status).toBe(400);
    const fixed = await s.patch(`/v1/drops/${ok.body.drop.id}`, { startsAt: inMin(120), title: 'Launch day' });
    expect(fixed.status).toBe(200);
    expect(fixed.body.drop.title).toBe('Launch day');
    expect((await s.post(`/v1/drops/${ok.body.drop.id}/publish`)).body.drop.status).toBe('scheduled');
    expect((await s.post(`/v1/drops/${ok.body.drop.id}/publish`)).status).toBe(409);
    expect((await s.del(`/v1/drops/${ok.body.drop.id}`)).status).toBe(409);
  });

  it('is for adults only, like selling', async () => {
    const teen = await signUp(t.app, { birthDate: `${new Date().getFullYear() - 15}-03-01` });
    const r = await as(t.app, teen).post('/v1/drops', { title: 'x', startsAt: inMin(60), items: [{ productId: '00000000-0000-4000-8000-000000000001' }] });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('adults_only');
  });
});

describe('who can do what', () => {
  it('lets only the seller change, publish, cancel or see the numbers', async () => {
    const seller = await signUp(t.app);
    const stranger = await signUp(t.app);
    const productId = await product(seller);
    const draft = (await as(t.app, seller).post('/v1/drops', { title: 'Mine', startsAt: inMin(60), items: [{ productId }] })).body.drop.id;
    const x = as(t.app, stranger);
    expect((await x.patch(`/v1/drops/${draft}`, { title: 'Theirs' })).status).toBe(404);
    expect((await x.post(`/v1/drops/${draft}/publish`)).status).toBe(404);
    expect((await x.del(`/v1/drops/${draft}`)).status).toBe(404);
    expect((await as(t.app, null).post(`/v1/drops/${draft}/publish`)).status).toBe(401);

    await as(t.app, seller).post(`/v1/drops/${draft}/publish`);
    expect((await x.post(`/v1/drops/${draft}/cancel`)).status).toBe(404);
    expect((await x.put(`/v1/drops/${draft}/cover`, { mediaId: '00000000-0000-4000-8000-000000000001' })).status).toBe(404);
    // Others see the drop and its real quantities, but not how many are waiting.
    const seen = await x.get(`/v1/drops/${draft}`);
    expect(seen.status).toBe(200);
    expect(seen.body.drop.isSeller).toBe(false);
    expect(seen.body.drop.stats).toBeUndefined();
    expect((await as(t.app, seller).post(`/v1/drops/${draft}/remind`)).status).toBe(400);
  });

  it("hides drops from people who blocked or were blocked, and private accounts' drops from non-followers", async () => {
    const seller = await signUp(t.app);
    const blocked = await signUp(t.app);
    const follower = await signUp(t.app);
    const stranger = await signUp(t.app);
    const productId = await product(seller);
    const id = await scheduled(seller, [{ productId }]);
    await as(t.app, seller).post(`/v1/users/${blocked.id}/block`);
    expect((await as(t.app, blocked).get(`/v1/drops/${id}`)).status).toBe(404);
    expect((await as(t.app, blocked).post(`/v1/drops/${id}/remind`)).status).toBe(404);
    expect((await as(t.app, blocked).get(`/v1/users/${seller.id}/drops`)).body.items).toEqual([]);

    await as(t.app, follower).post(`/v1/users/${seller.id}/follow`);
    await db().query(`UPDATE profiles SET is_private = true WHERE user_id = $1`, [seller.id]);
    expect((await as(t.app, stranger).get(`/v1/drops/${id}`)).status).toBe(404);
    expect((await as(t.app, null).get(`/v1/public/drops/${id}`)).status).toBe(404);
    expect((await as(t.app, follower).get(`/v1/drops/${id}`)).status).toBe(200);
    expect((await as(t.app, follower).get('/v1/drops/following')).body.items.map((d: { id: string }) => d.id)).toContain(id);
    await db().query(`UPDATE profiles SET is_private = false WHERE user_id = $1`, [seller.id]);
    const pub = await as(t.app, null).get(`/v1/public/drops/${id}`);
    expect(pub.status).toBe(200);
    expect(pub.body.drop).toMatchObject({ id, title: 'Autumn prints', status: 'scheduled', itemCount: 1 });
    expect(pub.body.drop).not.toHaveProperty('waiting');

    // Blocked people can't buy once it opens either.
    await as(t.app, seller).del(`/v1/users/${blocked.id}/block`);
    await as(t.app, blocked).post(`/v1/users/${seller.id}/block`);
    await openNow(id);
    expect((await order(blocked, productId)).status).toBe(404);
  });

  it('lets people under 18 look and ask to be told', async () => {
    const seller = await signUp(t.app);
    const teen = await signUp(t.app, { birthDate: `${new Date().getFullYear() - 15}-03-01` });
    const productId = await product(seller);
    const id = await scheduled(seller, [{ productId }]);
    expect((await as(t.app, teen).get(`/v1/drops/${id}`)).status).toBe(200);
    expect((await as(t.app, teen).post(`/v1/drops/${id}/remind`)).body.reminded).toBe(true);
  });
});

describe('opening', () => {
  it('keeps products off sale until the start, then opens and tells everyone waiting', async () => {
    const seller = await signUp(t.app);
    const a = await signUp(t.app);
    const b = await signUp(t.app);
    const quiet = await signUp(t.app);
    const productId = await product(seller);
    const id = await scheduled(seller, [{ productId, quantity: 10 }]);

    expect((await order(a, productId)).body.error.code).toBe('drop_not_open');
    expect((await as(t.app, a).get(`/v1/users/${seller.id}/shop`)).body.items.map((p: { id: string }) => p.id)).not.toContain(productId);
    expect((await as(t.app, seller).get(`/v1/users/${seller.id}/shop`)).body.items.map((p: { id: string }) => p.id)).toContain(productId);

    expect((await as(t.app, a).post(`/v1/drops/${id}/remind`)).status).toBe(200);
    expect((await as(t.app, b).post(`/v1/drops/${id}/remind`)).status).toBe(200);
    expect((await as(t.app, b).post(`/v1/drops/${id}/remind`)).status).toBe(200);
    await as(t.app, quiet).post(`/v1/drops/${id}/remind`);
    await as(t.app, quiet).del(`/v1/drops/${id}/remind`);
    expect((await as(t.app, a).get(`/v1/drops/${id}`)).body.drop.reminded).toBe(true);
    expect((await as(t.app, seller).get(`/v1/drops/${id}`)).body.drop.stats.waiting).toBe(2);
    expect((await as(t.app, a).get('/v1/me/drop-activity')).body.items[0].drop.id).toBe(id);

    // A job that runs before the start time (the drop was moved later) does nothing.
    await db().query(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE kind = $1 AND payload->>'id' = $2 AND status = 'queued'`, [DROP_OPEN_JOB, id]);
    await processJobs(db(), t.ctx.jobs, 50);
    expect((await as(t.app, a).get(`/v1/drops/${id}`)).body.drop.status).toBe('scheduled');
    // Put the job back and open for real.
    await db().query(`INSERT INTO jobs (kind, payload, run_at) VALUES ($1, $2, now())`, [DROP_OPEN_JOB, { id }]);
    await openNow(id);

    const drop = (await as(t.app, a).get(`/v1/drops/${id}`)).body.drop;
    expect(drop.status).toBe('open');
    for (const u of [a, b]) {
      const n = await notes(u.id, 'drop_opened');
      expect(n).toHaveLength(1);
      expect(n[0]).toMatchObject({ entity_type: 'drop', entity_id: id, actor_id: seller.id, data: { title: 'Autumn prints' } });
    }
    expect(await notes(quiet.id, 'drop_opened')).toHaveLength(0);
    // Running again tells nobody twice.
    await db().query(`INSERT INTO jobs (kind, payload, run_at) VALUES ($1, $2, now())`, [DROP_OPEN_JOB, { id }]);
    await processJobs(db(), t.ctx.jobs, 50);
    expect(await notes(a.id, 'drop_opened')).toHaveLength(1);
    // Too late to ask to be told, and too late to change it.
    expect((await as(t.app, quiet).post(`/v1/drops/${id}/remind`)).status).toBe(409);
    expect((await as(t.app, seller).patch(`/v1/drops/${id}`, { title: 'Changed' })).status).toBe(409);

    // Now it sells through the usual checkout.
    const o = await order(a, productId, 2);
    expect(o.status).toBe(201);
    expect((await as(t.app, a).post('/v1/payments/dev/complete', { orderId: o.body.order.id })).body.status).toBe('paid');
    const after = (await as(t.app, seller).get(`/v1/drops/${id}`)).body.drop;
    expect(after.items[0]).toMatchObject({ remaining: 8, soldOut: false });
    expect(after.stats).toMatchObject({ orders: 1, unitsSold: 2, unitsHeld: 0, revenue: [{ currency: 'USD', grossCents: 3000 }] });
    const mine = (await as(t.app, a).get('/v1/me/drop-activity')).body.items.find((x: { drop: { id: string } }) => x.drop.id === id);
    expect(mine.purchases).toMatchObject([{ productId, quantity: 2, status: 'paid' }]);
    expect(mine.drop.items[0].yours).toBe(2);
  });

  it('ends at its end time', async () => {
    const seller = await signUp(t.app);
    const buyer = await signUp(t.app);
    const productId = await product(seller);
    const id = await scheduledAndOpen(seller, [{ productId }], { endsAt: inMin(120) });
    await db().query(`UPDATE drops SET ends_at = now() - interval '1 second' WHERE id = $1`, [id]);
    // Past its end, it can't be bought even before the job has run.
    expect((await order(buyer, productId)).body.error.code).toBe('drop_ended');
    await db().query(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE kind = $1 AND payload->>'id' = $2 AND status = 'queued'`, [DROP_END_JOB, id]);
    await processJobs(db(), t.ctx.jobs, 50);
    expect((await as(t.app, buyer).get(`/v1/drops/${id}`)).body.drop).toMatchObject({ status: 'ended', endReason: 'time' });
    expect((await order(buyer, productId)).body.error.code).toBe('drop_ended');
  });
});

describe('stock', () => {
  it('never sells more than there is, even with many orders at once', async () => {
    const seller = await signUp(t.app);
    const buyers = await Promise.all(Array.from({ length: 12 }, () => signUp(t.app)));
    const productId = await product(seller);
    const id = await scheduledAndOpen(seller, [{ productId, quantity: 5 }]);

    const results = await Promise.all(buyers.map((b) => order(b, productId)));
    const ok = results.filter((r) => r.status === 201);
    expect(ok).toHaveLength(5);
    expect(results.filter((r) => r.status === 409).every((r) => ['sold_out', 'out_of_stock'].includes(r.body.error.code))).toBe(true);
    expect(await taken(id, productId)).toBe(5);
    const held = await db().query(`SELECT coalesce(sum(quantity), 0)::int AS n FROM drop_orders WHERE drop_id = $1 AND status <> 'released'`, [id]);
    expect(held.rows[0].n).toBe(5);

    // Everything is taken: the drop ends and the seller hears about it.
    const drop = (await as(t.app, seller).get(`/v1/drops/${id}`)).body.drop;
    expect(drop).toMatchObject({ status: 'ended', endReason: 'sold_out' });
    expect(drop.items[0]).toMatchObject({ remaining: 0, soldOut: true });
    expect(drop.items[0].soldOutAt).toBeTruthy();
    expect(drop.stats.unitsHeld).toBe(5);
    expect(await notes(seller.id, 'drop_sold_out')).toHaveLength(1);
  });

  it('holds in SQL alone: parallel transactions with no other lock never take more than there is', async () => {
    const seller = await signUp(t.app);
    const buyers = await Promise.all(Array.from({ length: 8 }, () => signUp(t.app)));
    const productId = await product(seller);
    const id = await scheduledAndOpen(seller, [{ productId, quantity: 3 }]);
    // A pool of its own, so every transaction really runs at the same time as the others.
    const pool = createPool(process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/yapilapi_test', 10);
    try {
      const results = await Promise.allSettled(
        buyers.map((b) =>
          tx(pool, async (c) => {
            const o = await c.query(`INSERT INTO orders (buyer_id, total_cents, currency, idempotency_key) VALUES ($1, 1500, 'USD', $2) RETURNING id`, [
              b.id,
              key(),
            ]);
            await takeDropStock(c, t.ctx.realtime, { orderId: o.rows[0].id, buyerId: b.id, items: [{ productId, quantity: 1 }] });
            // Stay open a moment so the transactions overlap.
            await c.query(`SELECT pg_sleep(0.05)`);
          }),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
      expect(results.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason.code === 'sold_out')).toBe(true);
    } finally {
      await pool.end();
    }
    expect(await taken(id, productId)).toBe(3);
  });

  it('asks for more than is left with a plain answer', async () => {
    const seller = await signUp(t.app);
    const buyer = await signUp(t.app);
    const productId = await product(seller);
    await scheduledAndOpen(seller, [{ productId, quantity: 3 }]);
    const r = await order(buyer, productId, 5);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toBe('Only 3 are left.');
  });

  it('keeps each buyer within the limit, also with parallel orders', async () => {
    const seller = await signUp(t.app);
    const buyer = await signUp(t.app);
    const other = await signUp(t.app);
    const productId = await product(seller);
    const id = await scheduledAndOpen(seller, [{ productId, quantity: 50, perBuyerLimit: 2 }]);

    expect((await order(buyer, productId, 3)).body.error.code).toBe('drop_limit');
    // The amount can't be split over two lines of one order.
    const split = await as(t.app, buyer).post('/v1/orders', {
      items: [
        { productId, quantity: 2 },
        { productId, quantity: 1 },
      ],
      idempotencyKey: key(),
    });
    expect(split.status).toBe(400);
    const results = await Promise.all([1, 2, 3, 4].map(() => order(buyer, productId)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    const refused = results.filter((r) => r.status === 409);
    expect(refused).toHaveLength(2);
    expect(refused[0]!.body.error).toMatchObject({ code: 'drop_limit', message: 'You can buy up to 2 of this, and you already have 2.' });
    expect(await taken(id, productId)).toBe(2);
    // Someone else still can.
    expect((await order(other, productId, 2)).status).toBe(201);
  });

  it('gives units back when an order is not paid in time, and refunds a payment that comes too late', async () => {
    const seller = await signUp(t.app);
    const slow = await signUp(t.app);
    const fast = await signUp(t.app);
    const productId = await product(seller);
    const id = await scheduledAndOpen(seller, [{ productId, quantity: 1 }]);

    const first = await order(slow, productId);
    expect(first.status).toBe(201);
    expect((await order(fast, productId)).body.error.code).toBe('sold_out');
    // The hold ends.
    await db().query(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE kind = $1 AND payload->>'orderId' = $2 AND status = 'queued'`, [
      DROP_RELEASE_JOB,
      first.body.order.id,
    ]);
    await processJobs(db(), t.ctx.jobs, 50);
    expect((await as(t.app, slow).get(`/v1/orders/${first.body.order.id}`)).body.order.status).toBe('cancelled');
    expect(await taken(id, productId)).toBe(0);
    // The drop that had sold out is on sale again.
    expect((await as(t.app, fast).get(`/v1/drops/${id}`)).body.drop).toMatchObject({ status: 'open', items: [{ remaining: 1, soldOut: false }] });

    const second = await order(fast, productId);
    expect(second.status).toBe(201);
    // The first buyer's payment arrives now: the last one is gone, so the money goes back.
    await as(t.app, slow).post('/v1/payments/dev/complete', { orderId: first.body.order.id });
    expect((await as(t.app, slow).get(`/v1/orders/${first.body.order.id}`)).body.order.status).toBe('refunded');
    expect(await taken(id, productId)).toBe(1);
    // The second one pays and keeps it.
    expect((await as(t.app, fast).post('/v1/payments/dev/complete', { orderId: second.body.order.id })).body.status).toBe('paid');
    expect((await as(t.app, seller).get(`/v1/drops/${id}`)).body.drop.stats).toMatchObject({ orders: 1, unitsSold: 1 });
  });

  it('takes a late payment when the units are still there, and puts refunded units back', async () => {
    const seller = await signUp(t.app);
    const buyer = await signUp(t.app);
    const productId = await product(seller);
    const id = await scheduledAndOpen(seller, [{ productId, quantity: 4 }]);
    const o = await order(buyer, productId, 2);
    await db().query(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE kind = $1 AND payload->>'orderId' = $2 AND status = 'queued'`, [
      DROP_RELEASE_JOB,
      o.body.order.id,
    ]);
    await processJobs(db(), t.ctx.jobs, 50);
    expect(await taken(id, productId)).toBe(0);
    expect((await as(t.app, buyer).post('/v1/payments/dev/complete', { orderId: o.body.order.id })).body.status).toBe('paid');
    expect(await taken(id, productId)).toBe(2);

    const refund = await as(t.app, seller).post(`/v1/orders/${o.body.order.id}/refund`, { reason: 'Damaged' });
    expect(refund.body.status).toBe('succeeded');
    expect(await taken(id, productId)).toBe(0);
    expect((await as(t.app, seller).get(`/v1/drops/${id}`)).body.drop.stats).toMatchObject({ orders: 0, unitsSold: 0 });
  });
});

describe('cancelling', () => {
  it('tells everyone waiting and puts the products back in the shop', async () => {
    const seller = await signUp(t.app);
    const waiting = await signUp(t.app);
    const productId = await product(seller);
    const id = await scheduled(seller, [{ productId }]);
    await as(t.app, waiting).post(`/v1/drops/${id}/remind`);
    const r = await as(t.app, seller).post(`/v1/drops/${id}/cancel`);
    expect(r.status).toBe(200);
    expect(r.body.drop.status).toBe('cancelled');
    expect(await notes(waiting.id, 'drop_cancelled')).toMatchObject([{ entity_id: id, actor_id: seller.id, data: { title: 'Autumn prints' } }]);
    // Nothing was charged; the opening job does nothing now.
    await openNow(id);
    expect((await as(t.app, waiting).get(`/v1/drops/${id}`)).body.drop.status).toBe('cancelled');
    expect(await notes(waiting.id, 'drop_opened')).toHaveLength(0);
    expect((await as(t.app, seller).post(`/v1/drops/${id}/cancel`)).status).toBe(409);
    expect((await order(waiting, productId)).status).toBe(201);
  });

  it('after opening: cancels unpaid orders and leaves paid ones to the usual refunds', async () => {
    const seller = await signUp(t.app);
    const paid = await signUp(t.app);
    const unpaid = await signUp(t.app);
    const productId = await product(seller);
    const id = await scheduledAndOpen(seller, [{ productId, quantity: 10 }]);
    const p = await order(paid, productId);
    await as(t.app, paid).post('/v1/payments/dev/complete', { orderId: p.body.order.id });
    const u = await order(unpaid, productId);
    await as(t.app, seller).post(`/v1/drops/${id}/cancel`);
    expect((await as(t.app, unpaid).get(`/v1/orders/${u.body.order.id}`)).body.order.status).toBe('cancelled');
    expect((await as(t.app, paid).get(`/v1/orders/${p.body.order.id}`)).body.order.status).toBe('paid');
    // Paying the cancelled order afterwards gets the money back.
    await as(t.app, unpaid).post('/v1/payments/dev/complete', { orderId: u.body.order.id });
    expect((await as(t.app, unpaid).get(`/v1/orders/${u.body.order.id}`)).body.order.status).toBe('refunded');
  });

  it('deletes drafts, and lets people report a published drop', async () => {
    const seller = await signUp(t.app);
    const reporter = await signUp(t.app);
    const productId = await product(seller);
    const draft = (await as(t.app, seller).post('/v1/drops', { title: 'Draft', startsAt: inMin(60), items: [{ productId }] })).body.drop.id;
    expect((await as(t.app, reporter).post('/v1/reports', { targetType: 'drop', targetId: draft, reason: 'spam' })).status).toBe(404);
    expect((await as(t.app, seller).del(`/v1/drops/${draft}`)).status).toBe(200);
    const id = await scheduled(seller, [{ productId }]);
    expect((await as(t.app, reporter).post('/v1/reports', { targetType: 'drop', targetId: id, reason: 'spam' })).status).toBe(201);
  });
});
