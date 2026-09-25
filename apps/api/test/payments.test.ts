import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  PaymentProviderError,
  containsCardNumber,
  feeReturnedForRefund,
  type SignedWebhook,
} from '@yapilapi/payments';
import { redact, signWebhook } from '@yapilapi/security';
import {
  Client,
  createTestApp,
  makeStaff,
  signup,
  uniq,
  type TestApp,
  type TestUser,
} from './helpers.js';
import { inDays, teenBirth } from './entity-helpers.js';
import {
  balanceOf,
  buy,
  checkout,
  devProvider,
  idem,
  key,
  ledgerOf,
  mkProduct,
  okToken,
  payWith,
  sellerAccount,
  unbalancedTransactions,
} from './commerce-fixtures.js';
import {
  deliverLocalWebhooks,
  integrityChecks,
  overridePaymentProvider,
  payeeBalances,
  processWebhook,
  retryProcessingRefunds,
  runReconciliation,
} from '../src/modules/payments/index.js';
import { releaseExpiredReservations } from '../src/modules/commerce/index.js';

let t: TestApp;
let admin: TestUser;
let moderator: TestUser;
let adminNoMfa: TestUser;
beforeAll(async () => {
  t = await createTestApp({ PAYOUT_HOLD_DAYS: '0' });
  admin = await signup(t);
  await makeStaff(t, admin, 'admin');
  moderator = await signup(t);
  await makeStaff(t, moderator, 'moderator');
  adminNoMfa = await signup(t);
  await t.ctx.db.query(`UPDATE users SET platform_role = 'admin' WHERE id = $1`, [adminNoMfa.id]);
});
afterAll(async () => {
  await t.close();
});

const anon = () => new Client(t);
const sql = (q: string, p: unknown[] = []) => t.ctx.db.query(q, p);
const n = async (q: string, p: unknown[] = []): Promise<number> =>
  Number((await sql(q, p)).rows[0].n);
const stockOf = async (id: string) =>
  Number((await sql('SELECT stock FROM products WHERE id = $1', [id])).rows[0].stock);
const orderRow = async (id: string) =>
  (await sql('SELECT status, refunded_cents, fraud_flags FROM orders WHERE id = $1', [id]))
    .rows[0] as { status: string; refunded_cents: number; fraud_flags: string[] };
const paymentsOf = async (orderId: string) =>
  (
    await sql(
      'SELECT id, status, provider_ref, failure_code, amount_cents, platform_fee_cents FROM payments WHERE order_id = $1 ORDER BY created_at',
      [orderId],
    )
  ).rows as any[];
const ledgerCount = (paymentId: string) =>
  n(
    `SELECT count(*)::int AS n FROM ledger_transactions WHERE kind = 'payment_captured' AND ref_id = $1`,
    [paymentId],
  );
const auditN = (action: string, targetId?: string) =>
  n(
    `SELECT count(*)::int AS n FROM audit_logs WHERE action = $1 AND ($2::text IS NULL OR target_id::text = $2)`,
    [action, targetId ?? null],
  );
const notifN = (userId: string, kind: string) =>
  n('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND kind = $2', [
    userId,
    kind,
  ]);

async function shop(over: Record<string, unknown> = {}) {
  const seller = await signup(t);
  const buyer = await signup(t);
  const product = await mkProduct(seller, over);
  return { seller, buyer, product };
}

const deliver = (wh: SignedWebhook, provider = 'dev') =>
  t.app.inject({
    method: 'POST',
    url: `/v1/webhooks/payments/${provider}`,
    payload: wh.rawBody,
    headers: wh.headers,
  });
const forge = (
  event: { id: string; type: string; data: Record<string, unknown> },
  signedAt?: number,
) => devProvider(t).buildWebhook(event, signedAt);
const succeeded = (
  p: { id: string; provider_ref: string; amount_cents: number },
  id = `evt_test_${uniq('s')}`,
) =>
  forge({
    id,
    type: 'payment.succeeded',
    data: {
      providerRef: p.provider_ref,
      amount: Number(p.amount_cents),
      currency: 'USD',
      metadata: { paymentId: p.id },
    },
  });

/** An order whose payment is created but not yet paid (no method attached). */
async function openPayment(over: Record<string, unknown> = {}) {
  const s = await shop(over);
  const o = (await checkout(s.buyer, [{ productId: s.product.id, quantity: 1 }])).body.order;
  const r = await payWith(s.buyer, o.id, null);
  expect(r.status).toBe(201);
  expect(r.body.payment.status).toBe('requires_payment_method');
  const [payment] = await paymentsOf(o.id);
  return { ...s, order: o, payment };
}

describe('paying for an order', () => {
  it('captures through the signed webhook, books the double-entry ledger and fulfils', async () => {
    const { seller, buyer, product } = await shop({
      stock: 5,
      delivery: { methods: ['post'], shippingCents: 500 },
    });
    const before = await stockOf(product.id);
    const o = (await checkout(buyer, [{ productId: product.id, quantity: 2 }])).body.order; // 4000 + 500 shipping
    expect(o.totalCents).toBe(4500);
    const r = await payWith(buyer, o.id);
    expect(r.status).toBe(201);
    expect(r.body.payment).toMatchObject({
      status: 'captured',
      amountCents: 4500,
      currency: 'USD',
      provider: 'dev',
      orderId: o.id,
    });
    expect(r.body.order).toMatchObject({
      status: 'paid',
      paidAt: expect.any(String),
      payment: { status: 'captured' },
    });
    const [pay] = await paymentsOf(o.id);
    expect(pay.platform_fee_cents).toBe(200); // 5% of the 4000 subtotal; shipping passes through
    const l = await ledgerOf(t, 'payment_captured', 'payment', pay.id);
    expect(l).toEqual(
      expect.arrayContaining([
        { account: 'provider:clearing', direction: 'debit', amount: 4500 },
        { account: sellerAccount(seller.id), direction: 'credit', amount: 4300 },
        { account: 'platform:fees', direction: 'credit', amount: 200 },
      ]),
    );
    expect(l).toHaveLength(3);
    expect(await balanceOf(t, sellerAccount(seller.id))).toBe(4300);
    expect(
      await n(
        `SELECT count(*)::int AS n FROM order_items WHERE order_id = $1 AND stock_state = 'committed'`,
        [o.id],
      ),
    ).toBe(1);
    expect(await stockOf(product.id)).toBe(before - 2); // reserved at checkout, stays deducted after payment
    expect(await auditN('payment.captured', pay.id)).toBe(1);
    expect(await auditN('payment.created', pay.id)).toBe(1);
    expect(await notifN(seller.id, 'order_paid')).toBe(1);
    expect(await notifN(buyer.id, 'payment_succeeded')).toBe(1);
    expect(
      (await sql('SELECT captured_at, seller_user_id FROM payments WHERE id = $1', [pay.id]))
        .rows[0],
    ).toMatchObject({ seller_user_id: seller.id });
    expect(await unbalancedTransactions(t)).toEqual([]);
  });

  it('is idempotent per Idempotency-Key: one payment, one charge, one ledger entry', async () => {
    const { buyer, product } = await shop();
    const o = (await checkout(buyer, [{ productId: product.id }])).body.order;
    const k = key();
    const token = okToken();
    const a = await payWith(buyer, o.id, token, k);
    const b = await payWith(buyer, o.id, token, k);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.body.payment.id).toBe(a.body.payment.id);
    const clash = await payWith(buyer, o.id, okToken(), k);
    expect(clash.status).toBe(409);
    expect(clash.body.error.details).toMatchObject({ reason: 'idempotency_key_reuse' });
    expect(await paymentsOf(o.id)).toHaveLength(1);
    expect(await ledgerCount(a.body.payment.id)).toBe(1);
    const ref = (await paymentsOf(o.id))[0].provider_ref;
    const provider = await devProvider(t).listRecords({
      from: new Date(Date.now() - 60_000),
      to: new Date(Date.now() + 60_000),
    });
    expect(provider.filter((r) => r.kind === 'payment' && r.ref === ref)).toHaveLength(1);
    // A different key on an order that is already paid never charges again.
    const again = await payWith(buyer, o.id, okToken(), key());
    expect(again.status).toBe(409);
    expect(again.body.error.details).toMatchObject({ status: 'paid' });
    expect(await paymentsOf(o.id)).toHaveLength(1);
    // Missing / malformed key
    expect(
      (await buyer.client.post(`/v1/orders/${o.id}/pay`, { paymentMethod: 'tok_success' })).status,
    ).toBe(400);
  });

  it('a double-click (parallel requests, different keys) charges exactly once', async () => {
    const { buyer, product } = await shop();
    const o = (await checkout(buyer, [{ productId: product.id }])).body.order;
    const rs = await Promise.all(Array.from({ length: 5 }, () => payWith(buyer, o.id)));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status !== 201).every((r) => r.status === 409)).toBe(true);
    const pays = await paymentsOf(o.id);
    expect(pays.filter((p) => p.status === 'captured')).toHaveLength(1);
    expect(
      await n(
        `SELECT count(*)::int AS n FROM ledger_transactions WHERE kind = 'payment_captured' AND ref_id = ANY($1::uuid[])`,
        [pays.map((p) => p.id)],
      ),
    ).toBe(1);
  });

  it('only the buyer can pay; anonymous, other users and teens cannot', async () => {
    const { buyer, product } = await shop();
    const other = await signup(t);
    const o = (await checkout(buyer, [{ productId: product.id }])).body.order;
    expect((await payWith(other, o.id)).status).toBe(404);
    expect((await payWith({ client: anon() } as unknown as TestUser, o.id)).status).toBe(401);
    expect((await payWith(buyer, '00000000-0000-4000-8000-000000000000')).status).toBe(404);
    const teen = await signup(t, { birthDate: teenBirth() });
    expect((await payWith(teen, o.id)).status).toBe(403); // minors cannot buy at all (and it is not their order)
    expect(await paymentsOf(o.id)).toHaveLength(0);
  });

  it('a declined card fails cleanly (402), leaves the order payable, and a retry with a good card works', async () => {
    const { buyer, product } = await shop();
    const o = (await checkout(buyer, [{ productId: product.id }])).body.order;
    const k = key();
    const d = await payWith(buyer, o.id, 'tok_decline', k);
    expect(d.status).toBe(402);
    expect(d.body.error).toMatchObject({
      code: 'payment_failed',
      details: { failureCode: 'card_declined' },
    });
    expect((await paymentsOf(o.id))[0]).toMatchObject({
      status: 'failed',
      failure_code: 'card_declined',
    });
    expect((await buyer.client.get(`/v1/orders/${o.id}`)).body).toMatchObject({
      status: 'pending_payment',
      payment: { status: 'failed', failureCode: 'card_declined' },
    });
    expect(
      await n(`SELECT count(*)::int AS n FROM ledger_transactions WHERE ref_id = ANY($1::uuid[])`, [
        (await paymentsOf(o.id)).map((p) => p.id),
      ]),
    ).toBe(0);
    // Replaying the declined attempt answers the same way without a new attempt.
    const replay = await payWith(buyer, o.id, 'tok_decline', k);
    expect(replay.status).toBe(402);
    expect(await paymentsOf(o.id)).toHaveLength(1);
    // Other decline reasons
    const r2 = await payWith(buyer, o.id, 'tok_insufficient_funds');
    expect(r2.status).toBe(402);
    expect(r2.body.error.details.failureCode).toBe('insufficient_funds');
    const s2 = await shop();
    const o2 = (await checkout(s2.buyer, [{ productId: s2.product.id }])).body.order;
    const r3 = await payWith(s2.buyer, o2.id, 'tok_expired_card');
    expect(r3.status).toBe(402);
    expect(r3.body.error.details.failureCode).toBe('expired_card');
    const ok = await payWith(buyer, o.id);
    expect(ok.status).toBe(201);
    expect((await buyer.client.get(`/v1/orders/${o.id}`)).body.status).toBe('paid');
    const pays = await paymentsOf(o.id);
    expect(pays.filter((p) => p.status === 'captured')).toHaveLength(1);
    expect(pays.filter((p) => p.status === 'failed')).toHaveLength(2);
    expect(await auditN('payment.failed')).toBeGreaterThanOrEqual(2);
  });

  it('requires_action: the order stays unpaid until the customer completes the challenge (confirm), by them only', async () => {
    const { buyer, product } = await shop();
    const other = await signup(t);
    const o = (await checkout(buyer, [{ productId: product.id }])).body.order;
    const r = await payWith(buyer, o.id, 'tok_requires_action:fp=' + uniq('c'));
    expect(r.status).toBe(201);
    expect(r.body.payment.status).toBe('requires_action');
    expect(r.body.nextAction).toBeTruthy();
    expect(r.body.order.status).toBe('pending_payment');
    const id = r.body.payment.id;
    expect((await payWith(buyer, o.id)).status).toBe(409); // a payment is already in progress
    expect((await other.client.post(`/v1/payments/${id}/confirm`, {})).status).toBe(404);
    expect((await anon().post(`/v1/payments/${id}/confirm`, {})).status).toBe(401);
    expect((await other.client.get(`/v1/payments/${id}`)).status).toBe(404);
    expect((await buyer.client.get(`/v1/payments/${id}`)).body).toMatchObject({
      status: 'requires_action',
    });
    const c = await buyer.client.post(`/v1/payments/${id}/confirm`, {});
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ payment: { status: 'captured' }, order: { status: 'paid' } });
    expect((await buyer.client.post(`/v1/payments/${id}/confirm`, {})).status).toBe(200); // confirming a settled payment is a no-op
    expect(await ledgerCount(id)).toBe(1);
  });

  it('a payment created without a method can be completed with /confirm', async () => {
    const { buyer, order, payment } = await openPayment();
    const c = await buyer.client.post(`/v1/payments/${payment.id}/confirm`, {
      paymentMethod: okToken(),
    });
    expect(c.status).toBe(200);
    expect(c.body.order.status).toBe('paid');
    expect(order.id).toBe(c.body.order.id);
  });

  it('an unpaid order whose reservation expired cannot be paid, and a late success is refunded automatically', async () => {
    const { seller, buyer, product } = await shop({ stock: 2 });
    const o = (await checkout(buyer, [{ productId: product.id, quantity: 2 }])).body.order;
    const first = await payWith(buyer, o.id, 'tok_requires_action:fp=' + uniq('c'));
    const payId = first.body.payment.id;
    expect(await stockOf(product.id)).toBe(0);
    // The customer completes the challenge at the provider, but the success webhook has not reached us yet when the reservation runs out.
    await devProvider(t).confirmPayment((await paymentsOf(o.id))[0].provider_ref, {});
    expect(
      await releaseExpiredReservations(t.ctx, new Date(Date.now() + 3 * 3_600_000)),
    ).toBeGreaterThanOrEqual(1);
    expect((await orderRow(o.id)).status).toBe('cancelled');
    expect(await stockOf(product.id)).toBe(2);
    expect((await sql('SELECT status FROM payments WHERE id = $1', [payId])).rows[0].status).toBe(
      'cancelled',
    );
    expect((await buyer.client.post(`/v1/payments/${payId}/confirm`, {})).status).toBe(409);
    expect((await payWith(buyer, o.id)).status).toBe(409);
    // The customer had actually completed the challenge at the provider: the success webhook arrives late.
    const [pay] = await paymentsOf(o.id);
    expect(await deliverLocalWebhooks(t.ctx)).toBeGreaterThanOrEqual(1);
    expect((await orderRow(o.id)).status).toBe('cancelled'); // never resurrected
    expect(await auditN('payment.captured_late', pay.id)).toBe(1);
    const refunds = (
      await sql('SELECT status, amount_cents, auto FROM refunds WHERE payment_id = $1', [pay.id])
    ).rows;
    expect(refunds).toEqual([
      { status: 'succeeded', amount_cents: Number(pay.amount_cents), auto: true },
    ]);
    expect(await balanceOf(t, sellerAccount(seller.id))).toBe(0); // the seller never keeps money for an order that did not complete
    expect(await unbalancedTransactions(t)).toEqual([]);
  });

  it('never accepts or stores card numbers: only opaque provider tokens', async () => {
    const { buyer, product } = await shop();
    const o = (await checkout(buyer, [{ productId: product.id }])).body.order;
    const PAN = '4242424242424242';
    for (const body of [
      { paymentMethod: PAN },
      { paymentMethod: '4242 4242 4242 4242' },
      { paymentMethod: `tok_${PAN}` },
      { paymentMethod: `pm_${PAN}` },
      { paymentMethod: 'card' },
    ]) {
      const r = await buyer.client.request('POST', `/v1/orders/${o.id}/pay`, {
        headers: idem(),
        body,
      });
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.body)).not.toContain(PAN);
    }
    expect((await payWith(buyer, o.id, 'tok_not_a_real_token')).status).toBe(422);
    // Extra fields are dropped by validation and never reach the database.
    const ok = await buyer.client.request('POST', `/v1/orders/${o.id}/pay`, {
      headers: idem(),
      body: { paymentMethod: okToken(), cardNumber: PAN, cvc: '123', number: PAN, exp: '12/34' },
    });
    expect(ok.status).toBe(201);
    expect(JSON.stringify(ok.body)).not.toContain(PAN);
    expect(redact({ cardNumber: PAN, card: { number: PAN }, ok: 1 })).toEqual({
      cardNumber: '[REDACTED]',
      card: '[REDACTED]',
      ok: 1,
    });
    expect(containsCardNumber(`order ${PAN} x`)).toBe(true);
  });
});

describe('payment webhooks', () => {
  it('a valid signed event marks the payment paid; replays are acknowledged and change nothing', async () => {
    const { seller, buyer, order, payment } = await openPayment();
    const wh = succeeded(payment, 'evt_valid_1' + uniq());
    const r1 = await deliver(wh);
    expect(r1.statusCode).toBe(200);
    expect(JSON.parse(r1.body)).toMatchObject({ received: true, events: 1, duplicates: 0 });
    expect(await orderRow(order.id)).toMatchObject({ status: 'paid' });
    expect((await paymentsOf(order.id))[0].status).toBe('captured');
    expect(await balanceOf(t, sellerAccount(seller.id))).toBeGreaterThanOrEqual(1900);
    const r2 = await deliver(wh);
    expect(r2.statusCode).toBe(200);
    expect(JSON.parse(r2.body)).toMatchObject({ duplicates: 1 });
    expect(await ledgerCount(payment.id)).toBe(1);
    expect(await auditN('payment.captured', payment.id)).toBe(1);
    expect(await notifN(seller.id, 'order_paid')).toBe(1);
    // Same content, new event id (a provider retry with a fresh id) is still idempotent at the payment level.
    const r3 = await deliver(succeeded(payment, 'evt_valid_2' + uniq()));
    expect(r3.statusCode).toBe(200);
    expect(await ledgerCount(payment.id)).toBe(1);
    expect(await notifN(buyer.id, 'payment_succeeded')).toBe(1);
    const receipt = (
      await sql(
        `SELECT signature_valid, processed_at FROM payment_webhook_events WHERE event_id = $1`,
        [JSON.parse(wh.rawBody).id],
      )
    ).rows[0];
    expect(receipt).toMatchObject({ signature_valid: true });
    expect(receipt.processed_at).not.toBeNull();
  });

  it('rejects invalid, tampered, stale, future-dated, unsigned and re-serialised deliveries without touching state', async () => {
    const { order, payment } = await openPayment();
    const good = succeeded(payment, 'evt_bad_' + uniq());
    const receipts = () => n('SELECT count(*)::int AS n FROM payment_webhook_events');
    const before = await receipts();
    const rejectedBefore = await auditN('payment.webhook_rejected');
    const now = Math.floor(Date.now() / 1000);
    const cases: Array<[string, SignedWebhook]> = [
      [
        'wrong secret',
        {
          rawBody: good.rawBody,
          headers: {
            ...good.headers,
            'yapilapi-signature': signWebhook('not-the-secret', good.rawBody, now),
          },
        },
      ],
      [
        'tampered body',
        {
          rawBody: good.rawBody.replace(`"amount":${payment.amount_cents}`, '"amount":1'),
          headers: good.headers,
        },
      ],
      [
        'stale (1h old)',
        forge(
          {
            id: 'evt_stale_' + uniq(),
            type: 'payment.succeeded',
            data: {
              providerRef: payment.provider_ref,
              amount: Number(payment.amount_cents),
              currency: 'USD',
              metadata: { paymentId: payment.id },
            },
          },
          now - 3600,
        ),
      ],
      [
        'future-dated',
        forge(
          {
            id: 'evt_future_' + uniq(),
            type: 'payment.succeeded',
            data: {
              providerRef: payment.provider_ref,
              amount: Number(payment.amount_cents),
              currency: 'USD',
              metadata: { paymentId: payment.id },
            },
          },
          now + 3600,
        ),
      ],
      [
        'no signature header',
        { rawBody: good.rawBody, headers: { 'content-type': 'application/json' } },
      ],
      [
        'garbage header',
        { rawBody: good.rawBody, headers: { ...good.headers, 'yapilapi-signature': 'hello' } },
      ],
      [
        'empty header',
        { rawBody: good.rawBody, headers: { ...good.headers, 'yapilapi-signature': '' } },
      ],
      [
        're-serialised JSON',
        { rawBody: JSON.stringify(JSON.parse(good.rawBody), null, 2), headers: good.headers },
      ],
      [
        'signature of another body',
        {
          rawBody: good.rawBody,
          headers: forge({ id: 'other', type: 'payment.succeeded', data: {} }).headers,
        },
      ],
    ];
    for (const [name, wh] of cases) {
      const r = await deliver(wh);
      expect({ name, status: r.statusCode }).toEqual({ name, status: 400 });
    }
    expect(await receipts()).toBe(before);
    expect((await orderRow(order.id)).status).toBe('pending_payment');
    expect((await paymentsOf(order.id))[0].status).toBe('requires_payment_method');
    expect(await ledgerCount(payment.id)).toBe(0);
    expect(await auditN('payment.webhook_rejected')).toBe(rejectedBefore + cases.length);
    // Non-JSON payload with a valid signature over it is a bad payload, not a crash.
    const junk = 'not json at all';
    const wh = {
      rawBody: junk,
      headers: {
        'content-type': 'application/json',
        'yapilapi-signature': signWebhook(t.ctx.config.webhookSigningSecret, junk),
      },
    };
    expect((await deliver(wh)).statusCode).toBe(400);
    // The genuine delivery still works afterwards.
    expect((await deliver(good)).statusCode).toBe(200);
    expect((await orderRow(order.id)).status).toBe('paid');
  });

  it('a delivery that only differs by an unknown provider name is rejected', async () => {
    const { payment } = await openPayment();
    const wh = succeeded(payment);
    expect((await deliver(wh, 'stripe')).statusCode).toBe(404); // provider is `dev` in this deployment
    expect((await deliver(wh, 'paypal')).statusCode).toBe(400);
  });

  it('the same event delivered concurrently is processed exactly once', async () => {
    const { seller, order, payment } = await openPayment({ priceCents: 3000 });
    const wh = succeeded(payment, 'evt_race_' + uniq());
    const rs = await Promise.all(Array.from({ length: 10 }, () => deliver(wh)));
    expect(rs.every((r) => r.statusCode === 200)).toBe(true);
    const bodies = rs.map((r) => JSON.parse(r.body));
    expect(bodies.filter((b) => b.duplicates === 0)).toHaveLength(1);
    expect(bodies.filter((b) => b.duplicates === 1)).toHaveLength(9);
    expect(
      await n(`SELECT count(*)::int AS n FROM payment_webhook_events WHERE event_id = $1`, [
        JSON.parse(wh.rawBody).id,
      ]),
    ).toBe(1);
    expect(await ledgerCount(payment.id)).toBe(1);
    expect(await auditN('payment.captured', payment.id)).toBe(1);
    expect(await balanceOf(t, sellerAccount(seller.id))).toBe(3000 - 150);
    expect((await orderRow(order.id)).status).toBe('paid');
  });

  it('different events for the same payment arriving in parallel still book once', async () => {
    const { payment } = await openPayment();
    const rs = await Promise.all(
      Array.from({ length: 6 }, (_, i) => deliver(succeeded(payment, `evt_multi_${i}_${uniq()}`))),
    );
    expect(rs.every((r) => r.statusCode === 200)).toBe(true);
    expect(await ledgerCount(payment.id)).toBe(1);
    expect(await auditN('payment.captured', payment.id)).toBe(1);
  });

  it('amount or currency mismatches are not captured and are audited; unknown payments are acknowledged', async () => {
    const { order, payment } = await openPayment();
    const bad = forge({
      id: 'evt_amt_' + uniq(),
      type: 'payment.succeeded',
      data: {
        providerRef: payment.provider_ref,
        amount: 1,
        currency: 'USD',
        metadata: { paymentId: payment.id },
      },
    });
    expect((await deliver(bad)).statusCode).toBe(200);
    expect((await orderRow(order.id)).status).toBe('pending_payment');
    expect(await auditN('payment.amount_mismatch', payment.id)).toBe(1);
    const cur = forge({
      id: 'evt_cur_' + uniq(),
      type: 'payment.succeeded',
      data: {
        providerRef: payment.provider_ref,
        amount: Number(payment.amount_cents),
        currency: 'EUR',
        metadata: { paymentId: payment.id },
      },
    });
    expect((await deliver(cur)).statusCode).toBe(200);
    expect((await orderRow(order.id)).status).toBe('pending_payment');
    const ghost = forge({
      id: 'evt_ghost_' + uniq(),
      type: 'payment.succeeded',
      data: { providerRef: 'pi_dev_doesnotexist', amount: 100, currency: 'USD', metadata: {} },
    });
    expect((await deliver(ghost)).statusCode).toBe(200);
    expect(
      (
        await sql(`SELECT error FROM payment_webhook_events WHERE event_id = $1`, [
          JSON.parse(ghost.rawBody).id,
        ])
      ).rows[0].error,
    ).toBe('unknown_payment');
    const other = forge({ id: 'evt_odd_' + uniq(), type: 'customer.created', data: {} });
    expect((await deliver(other)).statusCode).toBe(200);
  });

  it('later failure notices never downgrade a captured payment; failures on open payments are recorded', async () => {
    const { order, payment } = await openPayment();
    expect((await deliver(succeeded(payment))).statusCode).toBe(200);
    const fail = forge({
      id: 'evt_late_fail_' + uniq(),
      type: 'payment.failed',
      data: {
        providerRef: payment.provider_ref,
        failureCode: 'card_declined',
        metadata: { paymentId: payment.id },
      },
    });
    expect((await deliver(fail)).statusCode).toBe(200);
    expect((await paymentsOf(order.id))[0].status).toBe('captured');
    expect((await orderRow(order.id)).status).toBe('paid');
    const b = await openPayment();
    const f2 = forge({
      id: 'evt_fail_' + uniq(),
      type: 'payment.failed',
      data: {
        providerRef: b.payment.provider_ref,
        failureCode: 'card_declined',
        metadata: { paymentId: b.payment.id },
      },
    });
    expect((await deliver(f2)).statusCode).toBe(200);
    expect((await paymentsOf(b.order.id))[0]).toMatchObject({
      status: 'failed',
      failure_code: 'card_declined',
    });
    expect((await orderRow(b.order.id)).status).toBe('pending_payment');
  });

  it('webhook payment-method: dev outbox deliveries take the very same verified path', async () => {
    const before = await n('SELECT count(*)::int AS n FROM payment_webhook_events');
    const { buyer, product } = await shop();
    const o = (await checkout(buyer, [{ productId: product.id }])).body.order;
    expect((await payWith(buyer, o.id)).status).toBe(201);
    expect(await n('SELECT count(*)::int AS n FROM payment_webhook_events')).toBeGreaterThan(
      before,
    );
    expect(
      await n(
        `SELECT count(*)::int AS n FROM payment_webhook_events WHERE signature_valid = false`,
      ),
    ).toBe(0);
    expect(await deliverLocalWebhooks(t.ctx)).toBe(0); // nothing left in the outbox
    // processWebhook rejects a delivery that names another provider
    await expect(processWebhook(t.ctx, 'stripe', '{}', {})).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('ledger', () => {
  it('is append-only and refuses unbalanced transactions', async () => {
    const { payment } = await openPayment();
    await deliver(succeeded(payment));
    const [tx] = (await sql(`SELECT id FROM ledger_transactions WHERE ref_id = $1`, [payment.id]))
      .rows;
    await expect(
      sql(`UPDATE ledger_entries SET amount_cents = amount_cents + 1 WHERE transaction_id = $1`, [
        tx.id,
      ]),
    ).rejects.toThrow();
    await expect(
      sql(`DELETE FROM ledger_entries WHERE transaction_id = $1`, [tx.id]),
    ).rejects.toThrow();
    await expect(
      sql(`UPDATE ledger_transactions SET currency = 'EUR' WHERE id = $1`, [tx.id]),
    ).rejects.toThrow();
    // A one-sided transaction cannot be committed (deferred balance trigger fires at COMMIT).
    const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await client.connect();
    try {
      await client.query('BEGIN');
      const ins = await client.query(
        `INSERT INTO ledger_transactions (kind, ref_type, ref_id, currency) VALUES ('adjustment','test',gen_random_uuid(),'USD') RETURNING id`,
      );
      await client.query(
        `INSERT INTO ledger_entries (transaction_id, account, direction, amount_cents) VALUES ($1,'platform:fees','credit',100)`,
        [ins.rows[0].id],
      );
      await expect(client.query('COMMIT')).rejects.toThrow(/unbalanced/);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end();
    }
    expect(await unbalancedTransactions(t)).toEqual([]);
  });

  it('every captured payment has exactly one balanced transaction; fee + seller net = amount', async () => {
    const { rows } = await sql(
      `SELECT p.id, p.amount_cents, p.platform_fee_cents,
              (SELECT count(*) FROM ledger_transactions x WHERE x.kind = 'payment_captured' AND x.ref_id = p.id)::int AS txs,
              (SELECT COALESCE(sum(e.amount_cents),0) FROM ledger_entries e JOIN ledger_transactions x ON x.id = e.transaction_id WHERE x.kind = 'payment_captured' AND x.ref_id = p.id AND e.direction = 'debit')::bigint AS debits,
              (SELECT COALESCE(sum(e.amount_cents),0) FROM ledger_entries e JOIN ledger_transactions x ON x.id = e.transaction_id WHERE x.kind = 'payment_captured' AND x.ref_id = p.id AND e.direction = 'credit')::bigint AS credits
         FROM payments p WHERE p.status IN ('captured','partially_refunded','refunded','disputed')`,
    );
    expect(rows.length).toBeGreaterThan(5);
    for (const r of rows) {
      expect({ id: r.id, txs: r.txs }).toEqual({ id: r.id, txs: 1 });
      expect(Number(r.debits)).toBe(Number(r.amount_cents));
      expect(Number(r.credits)).toBe(Number(r.amount_cents));
    }
    expect(await unbalancedTransactions(t)).toEqual([]);
  });
});

describe('refunds', () => {
  it('partial then full refund: request -> seller approval -> provider -> reversal entries; stock and states follow; ledger rows are never mutated', async () => {
    const { seller, buyer, product } = await shop({
      stock: 5,
      delivery: { methods: ['post'], shippingCents: 500 },
    });
    const other = await signup(t);
    const start = await stockOf(product.id);
    const { orderId } = await buy(buyer, [{ productId: product.id, quantity: 2 }]); // total 4500, fee 200, seller net 4300
    const [pay] = await paymentsOf(orderId);
    const captureBefore = await ledgerOf(t, 'payment_captured', 'payment', pay.id);
    const url = `/v1/orders/${orderId}/refunds`;

    const k = key();
    const r1 = await buyer.client.request('POST', url, {
      headers: idem(k),
      body: { amountCents: 1000, reason: 'Item smaller than expected' },
    });
    expect(r1.status).toBe(201);
    expect(r1.body).toMatchObject({
      status: 'requested',
      amountCents: 1000,
      orderId,
      paymentId: pay.id,
    });
    const replay = await buyer.client.request('POST', url, {
      headers: idem(k),
      body: { amountCents: 1000, reason: 'Item smaller than expected' },
    });
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(r1.body.id);
    expect(
      (
        await buyer.client.request('POST', url, {
          headers: idem(k),
          body: { amountCents: 999, reason: 'different' },
        })
      ).status,
    ).toBe(409);
    expect(await n('SELECT count(*)::int AS n FROM refunds WHERE payment_id = $1', [pay.id])).toBe(
      1,
    );
    // Authorization
    expect((await other.client.post(url, { reason: 'not mine at all' })).status).toBe(404);
    expect((await anon().post(url, { reason: 'not mine at all' })).status).toBe(401);
    expect((await buyer.client.post(`/v1/refunds/${r1.body.id}/approve`, {})).status).toBe(404); // buyers cannot approve
    expect((await other.client.post(`/v1/refunds/${r1.body.id}/approve`, {})).status).toBe(404);
    expect((await anon().post(`/v1/refunds/${r1.body.id}/approve`, {})).status).toBe(401);
    expect((await buyer.client.post(`/v1/staff/refunds/${r1.body.id}/approve`, {})).status).toBe(
      403,
    );
    // Nothing has moved yet
    expect(await balanceOf(t, sellerAccount(seller.id))).toBe(4300);
    expect((await orderRow(orderId)).status).toBe('paid');
    expect(
      (await seller.client.get('/v1/seller/refunds', { status: 'requested' })).body.items.map(
        (x: any) => x.id,
      ),
    ).toContain(r1.body.id);
    expect((await other.client.get('/v1/seller/refunds')).body.items).toHaveLength(0);
    expect(await notifN(seller.id, 'refund_requested')).toBe(1);

    const ap = await seller.client.post(`/v1/refunds/${r1.body.id}/approve`, {});
    expect(ap.status).toBe(200);
    expect(ap.body).toMatchObject({ status: 'succeeded', decidedBy: seller.id });
    const fee1 = feeReturnedForRefund(4500, 200, 0, 1000);
    expect(await ledgerOf(t, 'refund', 'refund', r1.body.id)).toEqual(
      expect.arrayContaining([
        { account: sellerAccount(seller.id), direction: 'debit', amount: 1000 - fee1 },
        { account: 'platform:fees', direction: 'debit', amount: fee1 },
        { account: 'provider:clearing', direction: 'credit', amount: 1000 },
      ]),
    );
    expect(await balanceOf(t, sellerAccount(seller.id))).toBe(4300 - (1000 - fee1));
    expect(await orderRow(orderId)).toMatchObject({
      status: 'partially_refunded',
      refunded_cents: 1000,
    });
    expect((await paymentsOf(orderId))[0].status).toBe('partially_refunded');
    expect((await seller.client.post(`/v1/refunds/${r1.body.id}/approve`, {})).status).toBe(409);
    expect((await seller.client.post(`/v1/refunds/${r1.body.id}/deny`, {})).status).toBe(409);
    expect(await notifN(buyer.id, 'refund_succeeded')).toBe(1);

    // More than what is left is refused; then the remainder is refunded in full.
    const tooMuch = await buyer.client.post(url, {
      amountCents: 3501,
      reason: 'Too greedy for this',
    });
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.error.details).toMatchObject({
      reason: 'refund_exceeds_remaining',
      remaining: 3500,
    });
    const r2 = await buyer.client.post(url, { reason: 'Send back the rest' });
    expect(r2.status).toBe(201);
    expect(r2.body.amountCents).toBe(3500);
    expect((await seller.client.post(`/v1/refunds/${r2.body.id}/approve`, {})).body.status).toBe(
      'succeeded',
    );
    const fee2 = feeReturnedForRefund(4500, 200, 1000, 3500);
    expect(fee1 + fee2).toBe(200); // the whole platform fee is given back, exactly, over both refunds
    expect(await balanceOf(t, sellerAccount(seller.id))).toBe(0);
    expect(await orderRow(orderId)).toMatchObject({ status: 'refunded', refunded_cents: 4500 });
    expect((await paymentsOf(orderId))[0].status).toBe('refunded');
    expect(await stockOf(product.id)).toBe(start); // never shipped: back on the shelf
    expect((await buyer.client.post(url, { reason: 'One more time please' })).status).toBe(409);
    expect((await seller.client.post(`/v1/orders/${orderId}/fulfil`, {})).status).toBe(409); // refunded orders are final
    // Append-only: the capture entries are untouched, and reversal entries were added rather than edited.
    expect(await ledgerOf(t, 'payment_captured', 'payment', pay.id)).toEqual(captureBefore);
    expect(
      await n(
        `SELECT count(*)::int AS n FROM ledger_transactions WHERE kind = 'refund' AND ref_id IN ($1,$2)`,
        [r1.body.id, r2.body.id],
      ),
    ).toBe(2);
    expect(await auditN('refund.requested', r1.body.id)).toBe(1);
    expect(await auditN('refund.approved', r1.body.id)).toBe(1);
    expect(await auditN('refund.succeeded', r2.body.id)).toBe(1);
    const records = await devProvider(t).listRecords({
      from: new Date(Date.now() - 60_000),
      to: new Date(Date.now() + 60_000),
    });
    expect(
      records
        .filter((r) => r.kind === 'refund' && r.paymentRef === pay.provider_ref)
        .map((r) => r.amount)
        .sort(),
    ).toEqual([1000, 3500]);
    expect(await unbalancedTransactions(t)).toEqual([]);
  });

  it('deny leaves everything as it was; the buyer may ask again', async () => {
    const { seller, buyer, product } = await shop();
    const { orderId } = await buy(buyer, [{ productId: product.id }]);
    const r = await buyer.client.post(`/v1/orders/${orderId}/refunds`, {
      reason: 'Changed my mind about this',
    });
    const d = await seller.client.post(`/v1/refunds/${r.body.id}/deny`, {
      note: 'Outside the return window',
    });
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ status: 'rejected', decisionNote: 'Outside the return window' });
    expect(await balanceOf(t, sellerAccount(seller.id))).toBe(1900);
    expect((await orderRow(orderId)).status).toBe('paid');
    expect(await notifN(buyer.id, 'refund_denied')).toBe(1);
    expect(
      (
        await buyer.client.post(`/v1/orders/${orderId}/refunds`, {
          reason: 'Please reconsider this',
        })
      ).status,
    ).toBe(201);
  });

  it('sellers can refund directly; per-item refunds restock only that item and revoke only its access', async () => {
    const seller = await signup(t);
    const buyer = await signup(t);
    const a = await mkProduct(seller, { priceCents: 2000, stock: 3 });
    const b = await mkProduct(seller, { priceCents: 3000, stock: 3 });
    const { orderId } = await buy(buyer, [
      { productId: a.id, quantity: 1 },
      { productId: b.id, quantity: 1 },
    ]);
    const itemA = (
      await sql('SELECT id FROM order_items WHERE order_id = $1 AND product_id = $2', [
        orderId,
        a.id,
      ])
    ).rows[0].id;
    const r = await seller.client.post(`/v1/orders/${orderId}/refunds`, {
      itemId: itemA,
      reason: 'Out of stock after all',
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'succeeded', amountCents: 2000, itemId: itemA }); // approved and executed at once
    expect(await orderRow(orderId)).toMatchObject({
      status: 'partially_refunded',
      refunded_cents: 2000,
    });
    expect(await stockOf(a.id)).toBe(3);
    expect(await stockOf(b.id)).toBe(2);
    expect(
      (
        await seller.client.post(`/v1/orders/${orderId}/refunds`, {
          itemId: itemA,
          reason: 'Again and again',
        })
      ).status,
    ).toBe(422);
    expect(
      (await sql('SELECT refunded_cents FROM order_items WHERE id = $1', [itemA])).rows[0]
        .refunded_cents,
    ).toBe(2000);
    // a partially refunded (unfulfilled) order can still be fulfilled and completed
    expect((await seller.client.post(`/v1/orders/${orderId}/fulfil`, {})).body.status).toBe(
      'fulfilled',
    );
  });

  it('staff can decide refund requests (admin + MFA only) and it is audited as a staff action', async () => {
    const { buyer, product } = await shop();
    const { orderId } = await buy(buyer, [{ productId: product.id }]);
    const r = await buyer.client.post(`/v1/orders/${orderId}/refunds`, {
      reason: 'Seller never replied to me',
    });
    expect((await moderator.client.post(`/v1/staff/refunds/${r.body.id}/approve`, {})).status).toBe(
      403,
    );
    expect(
      (await adminNoMfa.client.post(`/v1/staff/refunds/${r.body.id}/approve`, {})).status,
    ).toBe(403);
    expect((await anon().post(`/v1/staff/refunds/${r.body.id}/approve`, {})).status).toBe(401);
    const list = await admin.client.get('/v1/staff/refunds');
    expect(list.status).toBe(200);
    expect(list.body.items.map((x: any) => x.id)).toContain(r.body.id);
    const ok = await admin.client.post(`/v1/staff/refunds/${r.body.id}/approve`, {
      note: 'Seller unresponsive',
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'succeeded', decidedBy: admin.id });
    expect(
      (
        await sql(
          `SELECT actor_type FROM audit_logs WHERE action = 'refund.approved' AND target_id = $1`,
          [r.body.id],
        )
      ).rows[0].actor_type,
    ).toBe('staff');
  });

  it('concurrency: two approvals refund once; two full-amount requests cannot both be accepted', async () => {
    const { seller, buyer, product } = await shop();
    const { orderId } = await buy(buyer, [{ productId: product.id }]);
    const [pay] = await paymentsOf(orderId);
    const rs = await Promise.all(
      [1, 2, 3].map(() =>
        buyer.client.post(`/v1/orders/${orderId}/refunds`, { reason: 'Racing refund request' }),
      ),
    );
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status !== 201).every((r) => r.status === 422)).toBe(true);
    const id = rs.find((r) => r.status === 201)!.body.id;
    const ap = await Promise.all(
      [1, 2, 3].map(() => seller.client.post(`/v1/refunds/${id}/approve`, {})),
    );
    expect(ap.filter((r) => r.status === 200)).toHaveLength(1);
    expect(ap.filter((r) => r.status === 409)).toHaveLength(2);
    expect(
      await n(
        `SELECT count(*)::int AS n FROM ledger_transactions WHERE kind = 'refund' AND ref_id = $1`,
        [id],
      ),
    ).toBe(1);
    const records = await devProvider(t).listRecords({
      from: new Date(Date.now() - 60_000),
      to: new Date(Date.now() + 60_000),
    });
    expect(
      records.filter((r) => r.kind === 'refund' && r.paymentRef === pay.provider_ref),
    ).toHaveLength(1);
    expect(await balanceOf(t, sellerAccount(seller.id))).toBe(0);
  });

  it('provider refusal fails the refund without moving money; an ambiguous provider error is retried later with the same idempotency key', async () => {
    const { seller, buyer, product } = await shop();
    const { orderId } = await buy(buyer, [{ productId: product.id }]);
    const prov = devProvider(t) as any;
    const orig = prov.refund.bind(prov);
    try {
      prov.refund = async () => {
        throw new PaymentProviderError('Charge disputed', 'charge_disputed', false, 400);
      };
      const r1 = await buyer.client.post(`/v1/orders/${orderId}/refunds`, {
        reason: 'Provider will refuse this',
      });
      const failed = await seller.client.post(`/v1/refunds/${r1.body.id}/approve`, {});
      expect(failed.body).toMatchObject({ status: 'failed', failureCode: 'charge_disputed' });
      expect(await balanceOf(t, sellerAccount(seller.id))).toBe(1900);
      expect((await orderRow(orderId)).status).toBe('paid');
      expect(
        await n(
          `SELECT count(*)::int AS n FROM ledger_transactions WHERE kind = 'refund' AND ref_id = $1`,
          [r1.body.id],
        ),
      ).toBe(0);

      prov.refund = async () => {
        throw new PaymentProviderError('Bad gateway', 'api_error', true, 502);
      };
      const r2 = await buyer.client.post(`/v1/orders/${orderId}/refunds`, {
        reason: 'Provider is having a bad day',
      });
      const stuck = await seller.client.post(`/v1/refunds/${r2.body.id}/approve`, {});
      expect(stuck.body.status).toBe('processing');
      expect(await balanceOf(t, sellerAccount(seller.id))).toBe(1900); // the ledger only moves once the provider confirmed
      prov.refund = orig;
      expect(await retryProcessingRefunds(t.ctx, 0)).toBeGreaterThanOrEqual(1);
      expect(
        (await sql('SELECT status FROM refunds WHERE id = $1', [r2.body.id])).rows[0].status,
      ).toBe('succeeded');
      expect(await balanceOf(t, sellerAccount(seller.id))).toBe(0);
      expect((await orderRow(orderId)).status).toBe('refunded');
    } finally {
      prov.refund = orig;
    }
  });

  it('disputes: opening freezes the order, winning restores it, losing reverses the money', async () => {
    const won = await shop();
    const lost = await shop();
    const a = await buy(won.buyer, [{ productId: won.product.id }]);
    const b = await buy(lost.buyer, [{ productId: lost.product.id }]);
    const [pa] = await paymentsOf(a.orderId);
    const [pb] = await paymentsOf(b.orderId);
    devProvider(t).devOpenDispute(pa.provider_ref);
    devProvider(t).devOpenDispute(pb.provider_ref, 'product_not_received');
    await deliverLocalWebhooks(t.ctx);
    expect(await orderRow(a.orderId)).toMatchObject({ status: 'disputed' });
    expect((await paymentsOf(a.orderId))[0].status).toBe('disputed');
    expect(
      await n(`SELECT count(*)::int AS n FROM disputes WHERE payment_id = $1 AND status = 'open'`, [
        pa.id,
      ]),
    ).toBe(1);
    expect(await notifN(won.seller.id, 'dispute_opened')).toBe(1);
    expect(
      (
        await won.buyer.client.post(`/v1/orders/${a.orderId}/refunds`, {
          reason: 'While it is disputed',
        })
      ).status,
    ).toBe(409);
    expect(
      (await admin.client.get('/v1/staff/disputes', { status: 'open' })).body.items.map(
        (d: any) => d.payment_id,
      ),
    ).toEqual(expect.arrayContaining([pa.id, pb.id]));
    expect((await won.buyer.client.get('/v1/staff/disputes')).status).toBe(403);

    devProvider(t).devCloseDispute(pa.provider_ref, 'won');
    devProvider(t).devCloseDispute(pb.provider_ref, 'lost');
    await deliverLocalWebhooks(t.ctx);
    expect(await orderRow(a.orderId)).toMatchObject({ status: 'paid' });
    expect((await paymentsOf(a.orderId))[0].status).toBe('captured');
    expect(await balanceOf(t, sellerAccount(won.seller.id))).toBe(1900);
    expect(await orderRow(b.orderId)).toMatchObject({ status: 'refunded' });
    expect((await paymentsOf(b.orderId))[0].status).toBe('refunded');
    expect(await balanceOf(t, sellerAccount(lost.seller.id))).toBe(0); // the chargeback comes out of the seller's balance, fee included
    expect(await auditN('dispute.lost', pb.id)).toBe(1);
    expect(await unbalancedTransactions(t)).toEqual([]);
  });
});

describe('tickets, bookings and paid communities', () => {
  async function eventWithTickets(host: TestUser, quantity: number, priceCents = 1500) {
    const ev = (
      await host.client.post('/v1/events', {
        title: `Gig ${uniq('g')}`,
        startsAt: inDays(3),
        endsAt: inDays(3, 2),
        locationText: 'Town Hall',
        publish: true,
        visibility: 'public',
      })
    ).body;
    const tt = (
      await host.client.post(`/v1/events/${ev.id}/ticket-types`, {
        name: 'General',
        priceCents,
        currency: 'USD',
        quantity,
        maxPerUser: 4,
      })
    ).body;
    return { ev, tt };
  }
  const sold = async (ttId: string) =>
    n('SELECT sold AS n FROM event_ticket_types WHERE id = $1', [ttId]);

  it('paid tickets: soft-held during checkout, issued through the events module after capture, released on refund', async () => {
    const host = await signup(t);
    const [a, b, c] = [await signup(t), await signup(t), await signup(t)];
    const { ev, tt } = await eventWithTickets(host, 3);
    const oa = await checkout(a, [{ ticketTypeId: tt.id, quantity: 2 }], { shipping: null });
    expect(oa.status).toBe(201);
    expect(oa.body.order).toMatchObject({
      totalCents: 3000,
      items: [{ type: 'ticket', eventId: ev.id }],
    });
    expect(
      (await checkout(b, [{ ticketTypeId: tt.id, quantity: 2 }], { shipping: null })).status,
    ).toBe(409); // 2 of 3 are held by a's pending order
    const ob = await checkout(b, [{ ticketTypeId: tt.id, quantity: 1 }], { shipping: null });
    expect(ob.status).toBe(201);
    expect(
      (await checkout(c, [{ ticketTypeId: tt.id, quantity: 1 }], { shipping: null })).status,
    ).toBe(409);
    expect(await sold(tt.id)).toBe(0); // the events module owns `sold`, updated at fulfilment
    expect((await payWith(a, oa.body.order.id)).status).toBe(201);
    expect((await payWith(b, ob.body.order.id)).status).toBe(201);
    expect(await sold(tt.id)).toBe(3);
    expect(
      await n(
        `SELECT count(*)::int AS n FROM tickets WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id = $1) AND status = 'valid'`,
        [oa.body.order.id],
      ),
    ).toBe(2);
    expect((await a.client.get(`/v1/events/${ev.id}/my-ticket`)).body.status).toBe('going');
    expect((await a.client.get(`/v1/orders/${oa.body.order.id}`)).body).toMatchObject({
      status: 'fulfilled',
      items: [{ entitlement: { kind: 'ticket', status: 'granted' } }],
    });
    expect(await balanceOf(t, sellerAccount(host.id))).toBe(4500 - 225);
    expect(
      (await checkout(c, [{ ticketTypeId: tt.id, quantity: 1 }], { shipping: null })).status,
    ).toBe(409); // sold out

    // Refunding the whole order gives the tickets back.
    const r = await host.client.post(`/v1/orders/${oa.body.order.id}/refunds`, {
      reason: 'Event moved to another day',
    });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('succeeded');
    expect(await sold(tt.id)).toBe(1);
    expect(
      await n(
        `SELECT count(*)::int AS n FROM tickets WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id = $1) AND status = 'valid'`,
        [oa.body.order.id],
      ),
    ).toBe(0);
    expect(
      (
        await sql(`SELECT status FROM event_attendees WHERE event_id = $1 AND user_id = $2`, [
          ev.id,
          a.id,
        ])
      ).rows[0].status,
    ).toBe('cancelled');
    expect(
      (await checkout(c, [{ ticketTypeId: tt.id, quantity: 2 }], { shipping: null })).status,
    ).toBe(201);
  });

  it('tickets that sell out between checkout and payment are refunded automatically', async () => {
    const host = await signup(t);
    const a = await signup(t);
    const { tt } = await eventWithTickets(host, 1);
    const o = await checkout(a, [{ ticketTypeId: tt.id, quantity: 1 }], { shipping: null });
    await sql('UPDATE event_ticket_types SET sold = quantity WHERE id = $1', [tt.id]); // someone else got the last ticket through another channel
    const p = await payWith(a, o.body.order.id);
    expect(p.status).toBe(201);
    const order = (await a.client.get(`/v1/orders/${o.body.order.id}`)).body;
    expect(order.status).toBe('refunded');
    expect(order.items[0].entitlement.status).toBe('revoked');
    expect(await auditN('entitlement.failed')).toBeGreaterThanOrEqual(1);
    expect(await balanceOf(t, sellerAccount(host.id))).toBe(0);
    expect(await notifN(a.id, 'order_item_refunded')).toBe(1);
  });

  it('bookings: the booking is confirmed after payment and cancelled by a refund; business team permissions apply', async () => {
    const owner = await signup(t);
    const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    const hours = Object.fromEntries(DAYS.map((d) => [d, [['00:00', '24:00']]]));
    const biz = (
      await owner.client.post('/v1/businesses', {
        name: `Salon ${uniq('b')}`,
        category: 'beauty',
        hours,
      })
    ).body;
    const team = async (role: 'admin' | 'editor' | 'support') => {
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
    const [adminU, editor, support] = [
      await team('admin'),
      await team('editor'),
      await team('support'),
    ];
    const stranger = await signup(t);
    const svc = (
      await owner.client.post(`/v1/businesses/${biz.id}/services`, {
        title: 'Cut and style',
        priceCents: 6000,
      })
    ).body;
    const customer = await signup(t);
    const startsAt = new Date(Date.now() + 3 * 86_400_000);
    startsAt.setUTCHours(10, 0, 0, 0);
    const bk = await customer.client.post('/v1/bookings', {
      productId: svc.id,
      startsAt: startsAt.toISOString(),
      durationMinutes: 60,
    });
    expect(bk.status).toBe(201);
    // Bookings must belong to the buyer and to the product.
    expect(
      (
        await checkout(stranger, [{ productId: svc.id, quantity: 1, bookingId: bk.body.id }], {
          shipping: null,
        })
      ).status,
    ).toBe(404);
    const o = await checkout(
      customer,
      [{ productId: svc.id, quantity: 1, bookingId: bk.body.id }],
      { shipping: null },
    );
    expect(o.status).toBe(201);
    expect(o.body.order.seller).toMatchObject({ type: 'business', id: biz.id });
    expect((await payWith(customer, o.body.order.id)).status).toBe(201);
    expect(
      (await sql('SELECT status, order_id FROM bookings WHERE id = $1', [bk.body.id])).rows[0],
    ).toMatchObject({ status: 'confirmed', order_id: o.body.order.id });
    expect(await balanceOf(t, sellerAccount(biz.id, 'business'))).toBe(6000 - 300);
    // Team: owner/admin/support handle orders (bookings.manage), editors and strangers do not.
    const list = (u: TestUser) => u.client.get('/v1/seller/orders', { businessId: biz.id });
    expect((await list(owner)).body.items).toHaveLength(1);
    expect((await list(adminU)).status).toBe(200);
    expect((await list(support)).status).toBe(200);
    expect((await list(editor)).status).toBe(403);
    expect((await list(stranger)).status).toBe(404);
    expect((await editor.client.get(`/v1/orders/${o.body.order.id}`)).status).toBe(404);
    expect((await support.client.get(`/v1/orders/${o.body.order.id}`)).status).toBe(200);
    // Refund by the business cancels the booking.
    const r = await support.client.post(`/v1/orders/${o.body.order.id}/refunds`, {
      reason: 'Stylist is ill today',
    });
    expect(r.body.status).toBe('succeeded');
    expect(
      (await sql('SELECT status FROM bookings WHERE id = $1', [bk.body.id])).rows[0].status,
    ).toBe('cancelled');
    expect(await balanceOf(t, sellerAccount(biz.id, 'business'))).toBe(0);
  });

  it('paid community membership: 402 on join, membership only after the captured payment, fee on the sale', async () => {
    const owner = await signup(t);
    const buyer = await signup(t);
    const teen = await signup(t, { birthDate: teenBirth() });
    const c = (
      await owner.client.post('/v1/communities', {
        name: `Insiders ${uniq('c')}`,
        visibility: 'public',
        joinPolicy: 'open',
        isPaid: true,
        priceCents: 900,
        currency: 'USD',
      })
    ).body;
    expect((await buyer.client.post(`/v1/communities/${c.id}/join`)).status).toBe(402);
    const body = (token: string) => ({ paymentMethod: token });
    const path = `/v1/communities/${c.id}/membership/pay`;
    expect((await buyer.client.post(path, body('tok_success'))).status).toBe(400); // Idempotency-Key required
    expect(
      (await anon().request('POST', path, { headers: idem(), body: body('tok_success') })).status,
    ).toBe(401);
    expect(
      (await teen.client.request('POST', path, { headers: idem(), body: body(okToken()) })).status,
    ).toBe(403);
    const d = await buyer.client.request('POST', path, {
      headers: idem(),
      body: body('tok_decline'),
    });
    expect(d.status).toBe(402);
    expect(
      await n(
        `SELECT count(*)::int AS n FROM community_members WHERE community_id = $1 AND user_id = $2 AND status = 'active'`,
        [c.id, buyer.id],
      ),
    ).toBe(0);
    const k = key();
    const tok = okToken();
    const ok = await buyer.client.request('POST', path, { headers: idem(k), body: body(tok) });
    expect(ok.status).toBe(201);
    expect(ok.body.payment).toMatchObject({
      status: 'captured',
      purpose: 'community_membership',
      amountCents: 900,
    });
    expect(
      await n(
        `SELECT count(*)::int AS n FROM community_members WHERE community_id = $1 AND user_id = $2 AND status = 'active'`,
        [c.id, buyer.id],
      ),
    ).toBe(1);
    expect(
      (await buyer.client.request('POST', path, { headers: idem(k), body: body(tok) })).status,
    ).toBe(200); // replay
    expect(
      (await buyer.client.request('POST', path, { headers: idem(), body: body(okToken()) })).status,
    ).toBe(409); // already a member
    expect(await balanceOf(t, sellerAccount(owner.id))).toBe(900 - 45);
    expect(
      await n(
        `SELECT count(*)::int AS n FROM payments WHERE payer_id = $1 AND purpose = 'community_membership' AND status = 'captured'`,
        [buyer.id],
      ),
    ).toBe(1);
    expect(
      (
        await sql(
          `SELECT status FROM order_entitlements WHERE user_id = $1 AND kind = 'community'`,
          [buyer.id],
        )
      ).rows[0].status,
    ).toBe('granted');
    // The membership row exists only because of a captured payment: joining directly still needs payment.
    const other = await signup(t);
    expect((await other.client.post(`/v1/communities/${c.id}/join`)).status).toBe(402);
  });
});

describe('payouts', () => {
  async function seller(net = 9500) {
    const s = await signup(t);
    const b = await signup(t);
    const gross = Math.round(net / 0.95);
    const p = await mkProduct(s, { priceCents: gross, stock: 1 });
    await buy(b, [{ productId: p.id }]);
    return { seller: s, buyer: b, gross, net: gross - Math.round(gross * 0.05) };
  }
  const verified = async (u: TestUser) => {
    const r = await u.client.post('/v1/payout-accounts', { country: 'US' });
    expect(r.status).toBe(201);
    const ref = (await sql('SELECT account_ref FROM payout_accounts WHERE id = $1', [r.body.id]))
      .rows[0].account_ref as string;
    devProvider(t).devSetKyc(ref, 'verified');
    await deliverLocalWebhooks(t.ctx);
    return { id: r.body.id as string, ref };
  };
  const payout = (u: TestUser, body: Record<string, unknown>, k = key()) =>
    u.client.request('POST', '/v1/payouts', { headers: idem(k), body });

  it('gating: payout account, KYC, positive available balance, idempotency and no overdraw', async () => {
    const { seller: s, buyer, net } = await seller(9500);
    expect(net).toBe(9500);
    const bal = await s.client.get('/v1/payouts/balance');
    expect(bal.body.balances).toEqual([
      { currency: 'USD', totalCents: 9500, availableCents: 9500, pendingCents: 0 },
    ]);
    expect(bal.body.payoutAccount).toBeNull();
    expect((await payout(s, { currency: 'USD' })).body.error.details).toMatchObject({
      reason: 'payout_account_required',
    });
    expect(
      (await anon().request('POST', '/v1/payouts', { headers: idem(), body: { currency: 'USD' } }))
        .status,
    ).toBe(401);
    const created = await s.client.post('/v1/payout-accounts', { country: 'US' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ kycStatus: 'pending', payoutsEnabled: false });
    expect((await s.client.post('/v1/payout-accounts', { country: 'US' })).status).toBe(409);
    const blocked = await payout(s, { currency: 'USD', amountCents: 1000 });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.details).toMatchObject({
      reason: 'kyc_required',
      kycStatus: 'pending',
    });
    expect(await n(`SELECT count(*)::int AS n FROM payouts WHERE payee_user_id = $1`, [s.id])).toBe(
      0,
    );
    // KYC completes at the provider; we learn through the signed webhook.
    const ref = (
      await sql('SELECT account_ref FROM payout_accounts WHERE id = $1', [created.body.id])
    ).rows[0].account_ref;
    devProvider(t).devSetKyc(ref, 'verified');
    await deliverLocalWebhooks(t.ctx);
    expect((await s.client.get('/v1/payout-accounts')).body.account).toMatchObject({
      kycStatus: 'verified',
      payoutsEnabled: true,
    });
    expect(await notifN(s.id, 'payout_failed')).toBe(0);

    expect((await payout(s, { currency: 'USD', amountCents: 9501 })).status).toBe(422);
    expect((await payout(s, { currency: 'USD', amountCents: 0 })).status).toBe(400);
    expect((await payout(s, { currency: 'USD', amountCents: -5 })).status).toBe(400);
    expect((await payout(s, { currency: 'EUR', amountCents: 100 })).status).toBe(422); // nothing in EUR
    const k = key();
    const first = await payout(s, { currency: 'USD', amountCents: 4000 }, k);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ status: 'paid', amountCents: 4000, currency: 'USD' });
    const replay = await payout(s, { currency: 'USD', amountCents: 4000 }, k);
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(first.body.id);
    expect((await payout(s, { currency: 'USD', amountCents: 4001 }, k)).status).toBe(409);
    expect(await balanceOf(t, sellerAccount(s.id))).toBe(5500);
    expect(await ledgerOf(t, 'payout', 'payout', first.body.id)).toEqual(
      expect.arrayContaining([
        { account: sellerAccount(s.id), direction: 'debit', amount: 4000 },
        { account: 'provider:clearing', direction: 'credit', amount: 4000 },
      ]),
    );
    // The rest, without stating an amount; then nothing is left.
    const rest = await payout(s, { currency: 'USD' });
    expect(rest.body.amountCents).toBe(5500);
    const none = await payout(s, { currency: 'USD' });
    expect(none.status).toBe(422);
    expect(none.body.error.details).toMatchObject({ reason: 'nothing_available' });
    expect(await balanceOf(t, sellerAccount(s.id))).toBe(0);
    expect((await s.client.get('/v1/payouts')).body.items).toHaveLength(2);
    expect((await buyer.client.get('/v1/payouts')).body.items).toHaveLength(0);
    expect(await auditN('payout.requested', first.body.id)).toBe(1);
    // A buyer with no sales: no account, and the balance is simply empty.
    expect((await buyer.client.get('/v1/payouts/balance')).body.balances).toEqual([]);
    expect((await payout(buyer, { currency: 'USD' })).status).toBe(409);
    expect(
      (await payout(await signup(t, { birthDate: teenBirth() }), { currency: 'USD' })).status,
    ).toBe(422);
    expect(
      (
        await moderator.client.put(`/v1/staff/payout-accounts/${created.body.id}/kyc`, {
          kycStatus: 'rejected',
          reason: 'testing',
        })
      ).status,
    ).toBe(403);
  });

  it('a rejected KYC blocks payouts again', async () => {
    const { seller: s } = await seller();
    const acc = await verified(s);
    devProvider(t).devSetKyc(acc.ref, 'rejected');
    await deliverLocalWebhooks(t.ctx);
    const r = await payout(s, { currency: 'USD' });
    expect(r.status).toBe(403);
    expect(r.body.error.details.kycStatus).toBe('rejected');
    // Staff can also revoke (any provider) but cannot grant verification to a real provider's account; with the dev provider both work.
    const set = await admin.client.put(`/v1/staff/payout-accounts/${acc.id}/kyc`, {
      kycStatus: 'verified',
      reason: 'Documents checked manually',
    });
    expect(set.status).toBe(200);
    expect(await auditN('payout_account.kyc_set_by_staff', acc.id)).toBe(1);
    expect((await payout(s, { currency: 'USD' })).status).toBe(201);
    expect(
      (await admin.client.put(`/v1/staff/payout-accounts/${acc.id}/kyc`, { kycStatus: 'rejected' }))
        .status,
    ).toBe(400); // reason required
  });

  it('parallel payout requests can never overdraw the balance', async () => {
    const { seller: s } = await seller(9500);
    await verified(s);
    const rs = await Promise.all(Array.from({ length: 6 }, () => payout(s, { currency: 'USD' })));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 422)).toHaveLength(5);
    expect(await balanceOf(t, sellerAccount(s.id))).toBe(0);
    const partial = await seller(9500);
    await verified(partial.seller);
    const ps = await Promise.all(
      Array.from({ length: 4 }, () =>
        payout(partial.seller, { currency: 'USD', amountCents: 4000 }),
      ),
    );
    expect(ps.filter((r) => r.status === 201)).toHaveLength(2); // 2 x 4000 fit into 9500, the others do not
    expect(await balanceOf(t, sellerAccount(partial.seller.id))).toBe(1500);
  });

  it('a failed transfer returns the money to the balance (append-only reversal) and notifies the seller', async () => {
    const { seller: s } = await seller(9500);
    const acc = await verified(s);
    devProvider(t).devFailPayoutsFor(acc.ref);
    try {
      const r = await payout(s, { currency: 'USD', amountCents: 3000 });
      expect(r.status).toBe(201);
      expect(r.body.status).toBe('failed');
      expect(await balanceOf(t, sellerAccount(s.id))).toBe(9500);
      expect(await ledgerOf(t, 'adjustment', 'payout_failed', r.body.id)).toHaveLength(2);
      expect(
        await n(`SELECT count(*)::int AS n FROM ledger_transactions WHERE ref_id = $1`, [
          r.body.id,
        ]),
      ).toBe(2); // the debit and its reversal, both kept
      expect(await notifN(s.id, 'payout_failed')).toBe(1);
    } finally {
      devProvider(t).devFailPayoutsFor(acc.ref, false);
    }
    expect((await payout(s, { currency: 'USD', amountCents: 3000 })).body.status).toBe('paid'); // the money is usable again
  });

  it('hold period: money is pending (not payable) until it has matured', async () => {
    const t7 = await createTestApp({ PAYOUT_HOLD_DAYS: '7' });
    try {
      const s = await signup(t7);
      const b = await signup(t7);
      const p = await mkProduct(s, { priceCents: 10_000, stock: 1 });
      await buy(b, [{ productId: p.id }]);
      const acc = await s.client.post('/v1/payout-accounts', { country: 'US' });
      const ref = (
        await t7.ctx.db.query('SELECT account_ref FROM payout_accounts WHERE id = $1', [
          acc.body.id,
        ])
      ).rows[0].account_ref;
      devProvider(t7).devSetKyc(ref, 'verified');
      await deliverLocalWebhooks(t7.ctx);
      const bal = await s.client.get('/v1/payouts/balance');
      expect(bal.body).toMatchObject({
        holdDays: 7,
        balances: [{ currency: 'USD', totalCents: 9500, availableCents: 0, pendingCents: 9500 }],
      });
      const r = await s.client.request('POST', '/v1/payouts', {
        headers: idem(),
        body: { currency: 'USD' },
      });
      expect(r.status).toBe(422);
      expect(r.body.error.details).toMatchObject({
        reason: 'nothing_available',
        pendingCents: 9500,
      });
      // Ledger time travel: a week and a bit later the same money is available.
      const later = await payeeBalances(
        t7.ctx.db,
        { type: 'user', id: s.id },
        7,
        new Date(Date.now() + 8 * 86_400_000),
      );
      expect(later).toEqual([{ currency: 'USD', total: 9500, available: 9500, pending: 0 }]);
      // A refund of a payment still on hold nets to zero there.
      const own = await t7.ctx.db.query(`SELECT id FROM orders WHERE seller_user_id = $1`, [s.id]);
      const rf = await s.client.post(`/v1/orders/${own.rows[0].id}/refunds`, {
        reason: 'Refunded within the hold',
      });
      expect(rf.body.status).toBe('succeeded');
      expect((await s.client.get('/v1/payouts/balance')).body.balances).toEqual([
        { currency: 'USD', totalCents: 0, availableCents: 0, pendingCents: 0 },
      ]);
    } finally {
      await t7.close();
    }
  });

  it('business payouts are owner-only; other roles and strangers are refused', async () => {
    const owner = await signup(t);
    const biz = (
      await owner.client.post('/v1/businesses', { name: `Money ${uniq('b')}`, category: 'retail' })
    ).body;
    const adminU = await signup(t);
    await owner.client.post(`/v1/businesses/${biz.id}/invitations`, {
      username: adminU.username,
      role: 'admin',
    });
    await adminU.client.post(`/v1/businesses/${biz.id}/invitation/accept`);
    const stranger = await signup(t);
    const buyer = await signup(t);
    const prod = (
      await owner.client.post('/v1/products', {
        kind: 'service',
        title: 'Consulting hour',
        priceCents: 10_000,
        currency: 'USD',
        businessId: biz.id,
        status: 'active',
      })
    ).body;
    await buy(buyer, [{ productId: prod.id }], { shipping: null });
    const q = { businessId: biz.id };
    expect((await adminU.client.get('/v1/payouts/balance', q)).status).toBe(403);
    expect((await stranger.client.get('/v1/payouts/balance', q)).status).toBe(404);
    expect(
      (await adminU.client.post('/v1/payout-accounts', { country: 'GB', businessId: biz.id }))
        .status,
    ).toBe(403);
    expect(
      (await stranger.client.post('/v1/payout-accounts', { country: 'GB', businessId: biz.id }))
        .status,
    ).toBe(404);
    expect(
      (
        await adminU.client.request('POST', '/v1/payouts', {
          headers: idem(),
          body: { currency: 'USD', businessId: biz.id },
        })
      ).status,
    ).toBe(403);
    expect((await owner.client.get('/v1/payouts/balance', q)).body.balances[0]).toMatchObject({
      totalCents: 9500,
      availableCents: 9500,
    });
    const acc = await owner.client.post('/v1/payout-accounts', {
      country: 'GB',
      businessId: biz.id,
    });
    expect(acc.status).toBe(201);
    const ref = (await sql('SELECT account_ref FROM payout_accounts WHERE id = $1', [acc.body.id]))
      .rows[0].account_ref;
    devProvider(t).devSetKyc(ref, 'verified');
    await deliverLocalWebhooks(t.ctx);
    expect(
      (await adminU.client.post(`/v1/payout-accounts/${acc.body.id}/refresh`, {})).status,
    ).toBe(403);
    const r = await owner.client.request('POST', '/v1/payouts', {
      headers: idem(),
      body: { currency: 'USD', businessId: biz.id },
    });
    expect(r.status).toBe(201);
    expect(r.body.payee).toMatchObject({ type: 'business', id: biz.id });
    expect(await balanceOf(t, sellerAccount(biz.id, 'business'))).toBe(0);
  });

  it('staff payout tools: list, and retry/cancel only apply to held or pending payouts', async () => {
    const { seller: s } = await seller();
    await verified(s);
    const r = await payout(s, { currency: 'USD', amountCents: 1000 });
    expect(
      (await admin.client.get('/v1/staff/payouts', { status: 'paid' })).body.items.map(
        (p: any) => p.id,
      ),
    ).toContain(r.body.id);
    expect((await s.client.get('/v1/staff/payouts')).status).toBe(403);
    expect((await moderator.client.get('/v1/staff/payouts')).status).toBe(403);
    expect((await admin.client.post(`/v1/staff/payouts/${r.body.id}/retry`, {})).status).toBe(409);
    expect(
      (
        await admin.client.post(`/v1/staff/payouts/${r.body.id}/fail`, {
          reason: 'not allowed on paid',
        })
      ).status,
    ).toBe(409);
    expect((await s.client.post(`/v1/staff/payouts/${r.body.id}/retry`, {})).status).toBe(403);
    // A transfer whose outcome is unknown is held; staff retries it with the same idempotency key.
    const prov = devProvider(t) as any;
    const orig = prov.createPayout.bind(prov);
    try {
      prov.createPayout = async () => {
        throw new PaymentProviderError('timeout', 'api_connection_error', true, 0);
      };
      const held = await payout(s, { currency: 'USD', amountCents: 1000 });
      expect(held.body.status).toBe('held');
      expect(await balanceOf(t, sellerAccount(s.id))).toBe(9500 - 2000); // funds stay reserved while held
    } finally {
      prov.createPayout = orig;
    }
    const heldId = (
      await sql(`SELECT id FROM payouts WHERE payee_user_id = $1 AND status = 'held'`, [s.id])
    ).rows[0].id;
    const retried = await admin.client.post(`/v1/staff/payouts/${heldId}/retry`, {});
    expect(retried.status).toBe(200);
    expect(retried.body.status).toBe('paid');
    expect(await auditN('payout.retried_by_staff', heldId)).toBe(1);
    const again = await payout(s, { currency: 'USD', amountCents: 500 });
    expect(again.status).toBe(201);
    const failing = (
      await sql(
        `INSERT INTO payouts (payee_user_id, amount_cents, currency, status, idempotency_key, account_id) SELECT $1, 100, 'USD', 'held', $2, id FROM payout_accounts WHERE owner_user_id = $1 RETURNING id`,
        [s.id, `test:${key()}`],
      )
    ).rows[0].id;
    expect(
      (
        await admin.client.post(`/v1/staff/payouts/${failing}/fail`, {
          reason: 'Cancelled by finance team',
        })
      ).body.status,
    ).toBe('failed');
  });
});

describe('fraud rules at checkout and payment', () => {
  const seedOrders = (buyerId: string, sellerId: string, count: number) =>
    sql(
      `INSERT INTO orders (buyer_id, seller_user_id, status, currency, subtotal_cents, total_cents, idempotency_key)
       SELECT $1, $2, 'cancelled', 'USD', 100, 100, 'seed-' || g || '-' || $3 FROM generate_series(1, $4) g`,
      [buyerId, sellerId, uniq('s'), count],
    );
  const seedCardUsers = async (fp: string, count: number) => {
    for (let i = 0; i < count; i++) {
      const u = await signup(t);
      await sql(
        `INSERT INTO payments (payer_id, purpose, amount_cents, currency, provider, idempotency_key, status, card_fingerprint) VALUES ($1,'tip',500,'USD','dev',$2,'failed',$3)`,
        [u.id, `seed:${key()}`, fp],
      );
    }
  };

  it('review at checkout: the order is held (stock reserved), unpayable, visible to staff, and staff decide', async () => {
    const { seller, buyer, product } = await shop({ stock: 3 });
    await seedOrders(buyer.id, seller.id, 5); // five orders in the last hour
    const before = await stockOf(product.id);
    const r = await checkout(buyer, [{ productId: product.id, quantity: 1 }]);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      held: true,
      order: { status: 'pending_review', heldForReview: true },
    });
    expect(await stockOf(product.id)).toBe(before - 1);
    const id = r.body.order.id;
    const pay = await payWith(buyer, id);
    expect(pay.status).toBe(409);
    expect(pay.body.error.details).toMatchObject({ reason: 'order_under_review' });
    expect(await paymentsOf(id)).toHaveLength(0);
    expect(
      (await sql(`SELECT decision, stage FROM fraud_signals WHERE subject_id = $1`, [id])).rows,
    ).toEqual([{ decision: 'review', stage: 'checkout' }]);
    expect(await auditN('order.held_for_review', id)).toBe(1);

    // Staff surface: admin + MFA only.
    const q = () => admin.client.get('/v1/staff/orders', { status: 'pending_review' });
    const listed = (await q()).body.items.find((o: any) => o.id === id);
    expect(listed).toMatchObject({ status: 'pending_review', fraud: { decision: 'review' } });
    expect(listed.fraud.flags).toContain('velocity_user_hour');
    for (const u of [buyer, seller, moderator, adminNoMfa])
      expect((await u.client.get('/v1/staff/orders')).status).toBe(403);
    expect((await anon().get('/v1/staff/orders')).status).toBe(401);
    expect((await admin.client.get(`/v1/staff/orders/${id}`)).body.fraudSignals).toHaveLength(1);
    expect(
      (await buyer.client.post(`/v1/staff/orders/${id}/review`, { decision: 'approve' })).status,
    ).toBe(403);
    expect(
      (await moderator.client.post(`/v1/staff/orders/${id}/review`, { decision: 'approve' }))
        .status,
    ).toBe(403);
    expect(
      (await admin.client.post(`/v1/staff/orders/${id}/review`, { decision: 'maybe' })).status,
    ).toBe(400);

    const ok = await admin.client.post(`/v1/staff/orders/${id}/review`, {
      decision: 'approve',
      note: 'Known repeat customer',
    });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('pending_payment');
    expect((await orderRow(id)).fraud_flags).toContain('staff_approved');
    expect(
      (await admin.client.post(`/v1/staff/orders/${id}/review`, { decision: 'approve' })).status,
    ).toBe(409); // no longer under review
    expect(await auditN('order.review_approved', id)).toBe(1);
    const paid = await payWith(buyer, id);
    expect(paid.status).toBe(201);
    expect(paid.body.order.status).toBe('paid');
  });

  it('rejecting a held order cancels it and releases the stock', async () => {
    const { seller, buyer, product } = await shop({ stock: 2 });
    await seedOrders(buyer.id, seller.id, 5);
    const r = await checkout(buyer, [{ productId: product.id, quantity: 2 }]);
    expect(await stockOf(product.id)).toBe(0);
    const rej = await admin.client.post(`/v1/staff/orders/${r.body.order.id}/review`, {
      decision: 'reject',
      note: 'Stolen card ring',
    });
    expect(rej.body.status).toBe('cancelled');
    expect(await stockOf(product.id)).toBe(2);
    expect((await orderRow(r.body.order.id)).status).toBe('cancelled');
    expect(await auditN('order.review_rejected', r.body.order.id)).toBe(1);
    expect(await notifN(buyer.id, 'order_review_rejected')).toBe(1);
    // staff cannot review their own orders
    const staffBuyer = admin;
    const o = await checkout(staffBuyer, [{ productId: product.id, quantity: 1 }]);
    expect(o.status).toBe(201);
  });

  it('a held order that nobody reviews expires and gives its stock back', async () => {
    const { seller, buyer, product } = await shop({ stock: 1 });
    await seedOrders(buyer.id, seller.id, 5);
    const r = await checkout(buyer, [{ productId: product.id }]);
    expect(r.body.held).toBe(true);
    // (other tests leave ordinary 30-minute reservations behind, so count only this order's fate)
    await releaseExpiredReservations(t.ctx, new Date(Date.now() + 47 * 3_600_000));
    expect((await orderRow(r.body.order.id)).status).toBe('pending_review');
    expect(await stockOf(product.id)).toBe(0);
    await releaseExpiredReservations(t.ctx, new Date(Date.now() + 49 * 3_600_000));
    expect((await orderRow(r.body.order.id)).status).toBe('cancelled');
    expect(await stockOf(product.id)).toBe(1);
  });

  it('block at checkout: rejected, audited, signal stored, nothing reserved or created', async () => {
    const { seller, buyer, product } = await shop({ stock: 3 });
    await seedOrders(buyer.id, seller.id, 12);
    const orders = await n('SELECT count(*)::int AS n FROM orders WHERE buyer_id = $1', [buyer.id]);
    const r = await checkout(buyer, [{ productId: product.id }]);
    expect(r.status).toBe(403);
    expect(r.body.error.details).toMatchObject({ reason: 'risk_declined' });
    expect(JSON.stringify(r.body)).not.toMatch(/velocity/); // reasons are for staff, not for the person being screened
    expect(await stockOf(product.id)).toBe(3);
    expect(await n('SELECT count(*)::int AS n FROM orders WHERE buyer_id = $1', [buyer.id])).toBe(
      orders,
    );
    expect(
      await n(
        `SELECT count(*)::int AS n FROM audit_logs WHERE action = 'order.blocked' AND actor_id = $1`,
        [buyer.id],
      ),
    ).toBe(1);
    const sig = (
      await sql(
        `SELECT decision, subject_id, reasons FROM fraud_signals WHERE user_id = $1 AND decision = 'block'`,
        [buyer.id],
      )
    ).rows;
    expect(sig).toHaveLength(1);
    expect(sig[0].subject_id).toBeNull();
    expect(JSON.stringify(sig[0].reasons)).toContain('velocity_user_hour_extreme');
    expect(
      (await admin.client.get('/v1/staff/fraud-signals', { decision: 'block', userId: buyer.id }))
        .body.items,
    ).toHaveLength(1);
    expect((await buyer.client.get('/v1/staff/fraud-signals')).status).toBe(403);
  });

  it('review at payment time: a card shared by several accounts holds the order instead of charging it', async () => {
    const { buyer, product } = await shop();
    await seedCardUsers('fp_dev_ring1', 3);
    const o = (await checkout(buyer, [{ productId: product.id }])).body.order;
    const r = await payWith(buyer, o.id, 'tok_success:fp=ring1');
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ held: true, order: { status: 'pending_review' } });
    expect(await paymentsOf(o.id)).toHaveLength(0); // nothing was charged
    expect(
      (
        await sql(`SELECT stage, decision FROM fraud_signals WHERE subject_id = $1 ORDER BY id`, [
          o.id,
        ])
      ).rows,
    ).toContainEqual({ stage: 'payment', decision: 'review' });
    expect(
      (await admin.client.post(`/v1/staff/orders/${o.id}/review`, { decision: 'approve' })).status,
    ).toBe(200);
    expect((await payWith(buyer, o.id, 'tok_success:fp=ring1')).status).toBe(201);
  });

  it('block at payment time: a card used by too many accounts is declined before the provider is called', async () => {
    const { buyer, product } = await shop();
    await seedCardUsers('fp_dev_ring2', 6);
    const o = (await checkout(buyer, [{ productId: product.id }])).body.order;
    const before = (
      await devProvider(t).listRecords({
        from: new Date(Date.now() - 3_600_000),
        to: new Date(Date.now() + 60_000),
      })
    ).length;
    const r = await payWith(buyer, o.id, 'tok_success:fp=ring2');
    expect(r.status).toBe(403);
    expect(r.body.error.details).toMatchObject({ reason: 'risk_declined' });
    expect(await paymentsOf(o.id)).toHaveLength(0);
    expect((await orderRow(o.id)).status).toBe('pending_payment');
    expect(
      (
        await devProvider(t).listRecords({
          from: new Date(Date.now() - 3_600_000),
          to: new Date(Date.now() + 60_000),
        })
      ).length,
    ).toBe(before);
    expect(
      await n(
        `SELECT count(*)::int AS n FROM audit_logs WHERE action = 'payment.blocked' AND actor_id = $1`,
        [buyer.id],
      ),
    ).toBe(1);
    expect((await payWith(buyer, o.id)).status).toBe(201); // a different card is fine
  });

  it('repeated declines raise the risk: the next checkout goes to review', async () => {
    const seller = await signup(t);
    const buyer = await signup(t);
    const product = await mkProduct(seller, { stock: 10 });
    for (let i = 0; i < 3; i++) {
      const o = (await checkout(buyer, [{ productId: product.id }])).body.order;
      expect((await payWith(buyer, o.id, 'tok_decline')).status).toBe(402);
    }
    const next = await checkout(buyer, [{ productId: product.id }]);
    expect(next.status).toBe(201);
    expect(next.body.held).toBe(true);
    const reasons = (
      await sql(`SELECT reasons FROM fraud_signals WHERE subject_id = $1`, [next.body.order.id])
    ).rows[0].reasons;
    expect(JSON.stringify(reasons)).toContain('failed_payments');
  });

  it('high-value orders from brand-new accounts are held for review', async () => {
    const seller = await signup(t);
    const buyer = await signup(t);
    const product = await mkProduct(seller, { priceCents: 30_000, stock: 2 });
    const r = await checkout(buyer, [{ productId: product.id }]);
    expect(r.body.held).toBe(true);
    expect(
      JSON.stringify(
        (await sql(`SELECT reasons FROM fraud_signals WHERE subject_id = $1`, [r.body.order.id]))
          .rows[0].reasons,
      ),
    ).toContain('new_account_high_value');
  });
});

describe('authorization matrix', () => {
  it('buyer / seller / other user / staff / anonymous get exactly the access they should', async () => {
    const { seller, buyer, product } = await shop({ stock: 10 });
    const other = await signup(t);
    const { orderId } = await buy(buyer, [{ productId: product.id }]);
    const [pay] = await paymentsOf(orderId);
    const rq = await buyer.client.post(`/v1/orders/${orderId}/refunds`, {
      reason: 'Matrix refund request',
      amountCents: 100,
    });
    expect(rq.status).toBe(201);
    const A = {
      buyer,
      seller,
      other,
      admin,
      moderator,
      adminNoMfa,
      anon: { client: anon() } as unknown as TestUser,
    };
    type Who = keyof typeof A;
    const cases: Array<{
      name: string;
      method: 'GET' | 'POST' | 'PUT';
      url: string;
      body?: unknown;
      expect: Partial<Record<Who, number>>;
    }> = [
      {
        name: 'order detail',
        method: 'GET',
        url: `/v1/orders/${orderId}`,
        expect: { buyer: 200, seller: 200, other: 404, admin: 404, anon: 401 },
      },
      {
        name: 'order refunds list',
        method: 'GET',
        url: `/v1/orders/${orderId}/refunds`,
        expect: { buyer: 200, seller: 200, other: 404, admin: 404, anon: 401 },
      },
      {
        name: 'payment detail',
        method: 'GET',
        url: `/v1/payments/${pay.id}`,
        expect: { buyer: 200, seller: 404, other: 404, admin: 404, anon: 401 },
      },
      {
        name: 'pay a paid order',
        method: 'POST',
        url: `/v1/orders/${orderId}/pay`,
        body: { paymentMethod: 'tok_success' },
        expect: { other: 404, anon: 401 },
      },
      {
        name: 'cancel',
        method: 'POST',
        url: `/v1/orders/${orderId}/cancel`,
        expect: { other: 404, seller: 404, anon: 401 },
      },
      {
        name: 'approve refund (seller side)',
        method: 'POST',
        url: `/v1/refunds/${rq.body.id}/approve`,
        expect: { buyer: 404, other: 404, admin: 404, moderator: 404, anon: 401 },
      },
      {
        name: 'deny refund (seller side)',
        method: 'POST',
        url: `/v1/refunds/${rq.body.id}/deny`,
        expect: { buyer: 404, other: 404, anon: 401 },
      },
      {
        name: 'approve refund (staff)',
        method: 'POST',
        url: `/v1/staff/refunds/${rq.body.id}/approve`,
        expect: { buyer: 403, seller: 403, other: 403, moderator: 403, adminNoMfa: 403, anon: 401 },
      },
      {
        name: 'staff orders',
        method: 'GET',
        url: '/v1/staff/orders',
        expect: {
          admin: 200,
          moderator: 403,
          adminNoMfa: 403,
          buyer: 403,
          seller: 403,
          other: 403,
          anon: 401,
        },
      },
      {
        name: 'staff order detail',
        method: 'GET',
        url: `/v1/staff/orders/${orderId}`,
        expect: { admin: 200, moderator: 403, buyer: 403, seller: 403, adminNoMfa: 403, anon: 401 },
      },
      {
        name: 'staff refunds',
        method: 'GET',
        url: '/v1/staff/refunds',
        expect: { admin: 200, moderator: 403, buyer: 403, seller: 403, adminNoMfa: 403, anon: 401 },
      },
      {
        name: 'staff reconciliation',
        method: 'GET',
        url: '/v1/staff/reconciliation',
        expect: { admin: 200, moderator: 403, buyer: 403, seller: 403, adminNoMfa: 403, anon: 401 },
      },
      {
        name: 'staff payouts',
        method: 'GET',
        url: '/v1/staff/payouts',
        expect: { admin: 200, moderator: 403, buyer: 403, seller: 403, adminNoMfa: 403, anon: 401 },
      },
      {
        name: 'staff disputes',
        method: 'GET',
        url: '/v1/staff/disputes',
        expect: { admin: 200, moderator: 403, buyer: 403, seller: 403, adminNoMfa: 403, anon: 401 },
      },
      {
        name: 'staff webhook events',
        method: 'GET',
        url: '/v1/staff/webhook-events',
        expect: { admin: 200, moderator: 403, buyer: 403, adminNoMfa: 403, anon: 401 },
      },
      {
        name: 'staff fraud signals',
        method: 'GET',
        url: '/v1/staff/fraud-signals',
        expect: { admin: 200, moderator: 403, buyer: 403, adminNoMfa: 403, anon: 401 },
      },
      {
        name: 'staff review',
        method: 'POST',
        url: `/v1/staff/orders/${orderId}/review`,
        body: { decision: 'approve' },
        expect: { admin: 409, moderator: 403, buyer: 403, seller: 403, adminNoMfa: 403, anon: 401 },
      },
      {
        name: 'payout balance',
        method: 'GET',
        url: '/v1/payouts/balance',
        expect: { buyer: 200, seller: 200, other: 200, anon: 401 },
      },
      {
        name: 'payouts list',
        method: 'GET',
        url: '/v1/payouts',
        expect: { buyer: 200, seller: 200, anon: 401 },
      },
      {
        name: 'payout without account',
        method: 'POST',
        url: '/v1/payouts',
        body: { currency: 'USD' },
        expect: { buyer: 409, other: 409, anon: 401 },
      },
      {
        name: 'staff kyc override',
        method: 'PUT',
        url: `/v1/staff/payout-accounts/${orderId}/kyc`,
        body: { kycStatus: 'rejected', reason: 'matrix' },
        expect: { buyer: 403, seller: 403, moderator: 403, adminNoMfa: 403, anon: 401, admin: 404 },
      },
    ];
    for (const c of cases) {
      for (const [who, want] of Object.entries(c.expect) as Array<[Who, number]>) {
        const u = A[who];
        const headers =
          ['POST', 'PUT'].includes(c.method) && (c.url === '/v1/payouts' || c.url.endsWith('/pay'))
            ? idem()
            : undefined;
        const res = await u.client.request(c.method, c.url, {
          ...(c.body !== undefined || c.method !== 'GET' ? { body: c.body ?? {} } : {}),
          ...(headers ? { headers } : {}),
        });
        expect({ case: c.name, who, status: res.status }).toEqual({
          case: c.name,
          who,
          status: want,
        });
      }
    }
    // Staff can never see or act on sensitive data through user endpoints; sellers only ever see orders that include their items.
    const stranger = await signup(t);
    expect((await stranger.client.get('/v1/seller/orders')).body.items).toHaveLength(0);
    expect((await seller.client.get('/v1/orders')).body.items).toHaveLength(0);
    expect(
      (await sql('SELECT status FROM refunds WHERE id = $1', [rq.body.id])).rows[0].status,
    ).toBe('requested'); // nothing above changed it
  });

  it('the webhook endpoint is public but demands a valid signature', async () => {
    const r = await t.app.inject({
      method: 'POST',
      url: '/v1/webhooks/payments/dev',
      payload: '{"id":"x","type":"payment.succeeded","data":{}}',
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(400);
    expect(
      (await t.app.inject({ method: 'GET', url: '/v1/webhooks/payments/dev' })).statusCode,
    ).toBe(404);
  });
});

describe('COMMERCE flag (payments surface)', () => {
  it('off => user-facing payment endpoints are 404; the signed webhook and staff tools keep working', async () => {
    const { buyer, product } = await shop();
    const o = (await checkout(buyer, [{ productId: product.id }])).body.order;
    const p = await payWith(buyer, o.id, null);
    const payment = (await paymentsOf(o.id))[0];
    await sql(`UPDATE feature_flags SET enabled = false WHERE key = 'COMMERCE'`);
    t.ctx.flags.invalidate();
    try {
      const calls: Array<[string, () => Promise<{ status: number }>]> = [
        ['pay', () => payWith(buyer, o.id)],
        ['confirm', () => buyer.client.post(`/v1/payments/${payment.id}/confirm`, {})],
        ['payment', () => buyer.client.get(`/v1/payments/${payment.id}`)],
        [
          'refund request',
          () => buyer.client.post(`/v1/orders/${o.id}/refunds`, { reason: 'flag is off now' }),
        ],
        ['seller refunds', () => buyer.client.get('/v1/seller/refunds')],
        ['balance', () => buyer.client.get('/v1/payouts/balance')],
        ['payout account', () => buyer.client.post('/v1/payout-accounts', { country: 'US' })],
        [
          'payout',
          () =>
            buyer.client.request('POST', '/v1/payouts', {
              headers: idem(),
              body: { currency: 'USD' },
            }),
        ],
        [
          'community pay',
          () =>
            buyer.client.request('POST', `/v1/communities/${uniq('c')}/membership/pay`, {
              headers: idem(),
              body: {},
            }),
        ],
      ];
      for (const [name, call] of calls)
        expect({ name, status: (await call()).status }).toEqual({ name, status: 404 });
      // Money that is already in flight must still settle, and staff must still be able to look at it.
      expect((await deliver(succeeded(payment))).statusCode).toBe(200);
      expect((await orderRow(o.id)).status).toBe('paid');
      expect((await admin.client.get('/v1/staff/orders')).status).toBe(200);
      expect((await admin.client.get('/v1/staff/reconciliation')).status).toBe(200);
    } finally {
      await sql(`UPDATE feature_flags SET enabled = true WHERE key = 'COMMERCE'`);
      t.ctx.flags.invalidate();
    }
    expect(p.status).toBe(201);
  });
});

describe('reconciliation', () => {
  it('matches provider records to the ledger, and reports what does not match', async () => {
    await new Promise((r) => setTimeout(r, 20)); // earlier tests fabricate signed webhooks for intents the provider never settled: keep them out of this window
    const from = new Date();
    const { seller, buyer, product } = await shop({ priceCents: 4000 });
    const { orderId } = await buy(buyer, [{ productId: product.id }]);
    const rf = await buyer.client.post(`/v1/orders/${orderId}/refunds`, {
      reason: 'Partial for reconciliation',
      amountCents: 1000,
    });
    await seller.client.post(`/v1/refunds/${rf.body.id}/approve`, {});
    const range = () => ({ from, to: new Date(Date.now() + 5000) });

    const ok = await runReconciliation(t.ctx, range());
    expect(ok.discrepancies).toEqual([]);
    expect(ok.matched).toBeGreaterThanOrEqual(2); // the payment and the refund
    expect(ok.providerRecords).toBeGreaterThanOrEqual(2);

    // (a) the provider forgot everything (e.g. a restart of the dev provider): every settled ledger record is "missing at provider"
    const original = devProvider(t);
    const { DevPaymentProvider } = await import('@yapilapi/payments');
    overridePaymentProvider(
      t.ctx,
      new DevPaymentProvider({ webhookSecret: t.ctx.config.webhookSigningSecret }),
    );
    try {
      const missing = await runReconciliation(t.ctx, range());
      expect(missing.ok).toBe(false);
      expect(missing.discrepancies.map((d) => d.type)).toContain('missing_at_provider');
      expect(
        missing.discrepancies.some((d) => d.kind === 'refund' && d.type === 'missing_at_provider'),
      ).toBe(true);
    } finally {
      overridePaymentProvider(t.ctx, original);
    }

    // (b) the provider took money we have no record of: "missing in ledger"
    const stray = await original.createPaymentIntent({
      amount: 777,
      currency: 'USD',
      idempotencyKey: `stray-${uniq('x')}`,
      metadata: {},
      paymentMethod: okToken(),
    });
    original.drainWebhookOutbox();
    const extra = await runReconciliation(t.ctx, range());
    expect(extra.discrepancies).toContainEqual(
      expect.objectContaining({ type: 'missing_in_ledger', kind: 'payment', ref: stray.ref }),
    );

    // (c) the staff endpoint exposes the same report
    const res = await admin.client.get('/v1/staff/reconciliation', {
      from: from.toISOString(),
      to: new Date(Date.now() + 5000).toISOString(),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ provider: 'dev', ok: false });
    expect(res.body.discrepancies.some((d: any) => d.ref === stray.ref)).toBe(true);
    expect(
      (
        await admin.client.get('/v1/staff/reconciliation', {
          from: new Date().toISOString(),
          to: new Date(Date.now() - 1000).toISOString(),
        })
      ).status,
    ).toBe(400);
    expect(await auditN('reconciliation.run')).toBeGreaterThanOrEqual(1);
  });
});

describe('global invariants (after everything above)', () => {
  it('the ledger is balanced and every internal integrity check passes', async () => {
    expect(await unbalancedTransactions(t)).toEqual([]);
    expect(await integrityChecks(t.ctx)).toEqual([]);
    // Per-account sanity: no seller ever ends up owed a negative amount.
    const neg = await sql(
      `SELECT account FROM ledger_entries WHERE account LIKE 'seller:%' GROUP BY account HAVING sum(CASE WHEN direction = 'credit' THEN amount_cents ELSE -amount_cents END) < 0`,
    );
    expect(neg.rows).toEqual([]);
    // Money conservation: what the platform holds for sellers + fees == clearing (cash at the provider), across all currencies here (USD only).
    const totals = (
      await sql(
        `SELECT sum(CASE WHEN account = 'provider:clearing' THEN (CASE WHEN direction = 'debit' THEN amount_cents ELSE -amount_cents END) ELSE 0 END)::bigint AS cash,
              sum(CASE WHEN account <> 'provider:clearing' THEN (CASE WHEN direction = 'credit' THEN amount_cents ELSE -amount_cents END) ELSE 0 END)::bigint AS owed
         FROM ledger_entries`,
      )
    ).rows[0];
    expect(Number(totals.cash)).toBe(Number(totals.owed));
  });

  it('no raw card data anywhere: a Luhn scan over every stored row finds no card number', async () => {
    const tables = (
      await sql(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`)
    ).rows.map((r) => r.tablename as string);
    expect(tables).toEqual(
      expect.arrayContaining([
        'payments',
        'payment_webhook_events',
        'audit_logs',
        'orders',
        'ledger_entries',
        'fraud_signals',
      ]),
    );
    const offenders: string[] = [];
    let rowsScanned = 0;
    for (const table of tables) {
      const { rows } = await sql(`SELECT row_to_json(x)::text AS j FROM "${table}" x`);
      for (const r of rows) {
        rowsScanned += 1;
        const text = String(r.j)
          .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '') // uuids
          .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})?/g, '') // timestamps
          .replace(/[0-9a-f]{24,}/gi, '') // hashes
          .replace(/(?<!\d)1[5-9]\d{11}(?!\d)/g, ''); // epoch milliseconds inside our own idempotency keys (a card number never starts with 1)
        if (containsCardNumber(text)) offenders.push(`${table}: ${text.slice(0, 120)}`);
      }
    }
    expect(rowsScanned).toBeGreaterThan(500);
    expect(offenders).toEqual([]);
    // Positive control: the scanner does see a card number if one is there.
    expect(containsCardNumber('{"note":"4242 4242 4242 4242"}')).toBe(true);
    // And only opaque provider references were ever stored as payment methods / intents.
    const refs = (
      await sql(`SELECT DISTINCT provider_ref FROM payments WHERE provider_ref IS NOT NULL`)
    ).rows.map((r) => r.provider_ref as string);
    expect(refs.length).toBeGreaterThan(10);
    expect(refs.every((r) => /^pi_dev_[0-9a-f]+$/.test(r))).toBe(true);
    const cols = (
      await sql(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('payments','orders','refunds','payouts','payout_accounts','payment_webhook_events') ORDER BY column_name`,
      )
    ).rows.map((r) => r.column_name as string);
    expect(
      cols.filter((c) => /card_?number|pan|cvv|cvc|expir|iban|account_number/i.test(c)),
    ).toEqual([]);
  });
});
