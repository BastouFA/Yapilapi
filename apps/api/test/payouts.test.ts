import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signPaystackWebhook } from '../src/lib/payments.ts';
import { as, jobRunner, signUp, testApp, type JobRunner, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';

/** Payouts that pay: a payout account, a request, an admin's approval, the transfer and the provider's answer. */
const SECRET = 'sk_test_paystack_fake';
const PUBLIC = 'pk_test_paystack_fake';

/** A stand-in for Paystack's transfer API that answers each transfer as told. */
function fakePaystack() {
  const calls: { url: string; body: any }[] = [];
  let transferStatus = 'pending';
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    if (url.includes('/bank?currency=NGN'))
      return Response.json({
        status: true,
        data: [
          { code: '058', name: 'GTBank', type: 'nuban', active: true },
          { code: '999', name: 'Closed Bank', type: 'nuban', active: false },
        ],
      });
    if (url.endsWith('/transferrecipient'))
      return Response.json({
        status: true,
        data: { recipient_code: 'RCP_abc123', details: { bank_name: 'GTBank', account_number: body.account_number, account_name: body.name } },
      });
    if (url.endsWith('/transfer')) return Response.json({ status: true, data: { status: transferStatus, transfer_code: 'TRF_1', reference: body.reference } });
    return Response.json({ status: false, message: 'Not found' }, { status: 404 });
  }) as typeof globalThis.fetch;
  return { calls, fetch, answer: (s: string) => (transferStatus = s) };
}

const fake = fakePaystack();
let t: BuiltApp;
let admin: TestUser;
let runJobs: JobRunner;
beforeAll(async () => {
  t = await testApp({ PAYSTACK_SECRET_KEY: SECRET, PAYSTACK_PUBLIC_KEY: PUBLIC }, { paystackFetch: fake.fetch });
  runJobs = await jobRunner(t.ctx.db);
  admin = await signUp(t.app, { birthDate: '1985-01-01' });
  await t.ctx.db.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [admin.id]);
});
afterAll(async () => {
  await t.close();
});

const db = () => t.ctx.db;
const key = () => `k_${Math.random().toString(36).slice(2)}${Date.now()}`;
const drain = async () => {
  for (let i = 0; i < 5; i++) if (!(await runJobs(t.ctx.jobs))) return;
};

/** A creator with a confirmed email, and earnings in a currency that are past their hold. */
async function creator(earnCents: number, currency: string) {
  const u = await signUp(t.app, { birthDate: '1990-04-02' });
  await db().query(`UPDATE users SET email_verified_at = now() WHERE id = $1`, [u.id]);
  const fan = await signUp(t.app, { birthDate: '1990-04-02' });
  await db().query(
    `INSERT INTO orders (buyer_id, total_cents, platform_fee_cents, currency, idempotency_key, purpose, payee_id, status, paid_at)
     VALUES ($1, $2, 0, $3, $4, 'tip', $5, 'paid', now() - interval '8 days')`,
    [fan.id, earnCents, currency, key(), u.id],
  );
  return u;
}
const available = async (u: TestUser, currency: string) =>
  ((await as(t.app, u).get('/v1/me/earnings')).body.balances.find((b: any) => b.currency === currency)?.availableCents ?? 0) as number;
const payoutStatus = async (id: string) => (await db().query(`SELECT status, failure_reason FROM payouts WHERE id = $1`, [id])).rows[0];
const notified = async (u: TestUser) => (await db().query(`SELECT type FROM notifications WHERE user_id = $1`, [u.id])).rows.map((r) => r.type);

describe('payout accounts', () => {
  it('sets up a bank account for a currency, keeping only the bank and the last four digits', async () => {
    const u = await creator(5000, 'USD');
    const usd = (await as(t.app, u).get('/v1/me/payout-accounts')).body.items.find((a: any) => a.currency === 'USD');
    expect(usd).toEqual({ currency: 'USD', provider: 'dev', kind: 'bank', ready: false, label: null, minCents: 1000 });
    expect((await as(t.app, u).get('/v1/payout-banks?currency=USD')).body.items).toEqual([{ code: 'DEV', name: 'Test Bank', type: 'nuban' }]);
    const add = (body: Record<string, unknown>) =>
      as(t.app, u).post('/v1/me/payout-accounts/bank', { currency: 'USD', bankCode: 'DEV', accountNumber: '0123456789', accountName: 'Ada Obi', ...body });
    expect((await add({ bankCode: 'NOPE' })).status).toBe(400);
    expect((await add({ accountNumber: '12ab' })).status).toBe(400);
    const r = await add({});
    expect(r.status).toBe(201);
    expect(r.body.account).toMatchObject({ ready: true, label: 'Test Bank •••• 6789' });
    const row = (await db().query(`SELECT account_ref, label FROM payout_accounts WHERE user_id = $1`, [u.id])).rows[0];
    expect(row.label).not.toContain('0123456789');
    expect(row.account_ref).toMatch(/^dev_rcp_/);
  });

  it('is for adults with a confirmed email', async () => {
    const teen = await signUp(t.app, { birthDate: `${new Date().getFullYear() - 15}-01-01` });
    await db().query(`UPDATE users SET email_verified_at = now() WHERE id = $1`, [teen.id]);
    const body = { currency: 'USD', bankCode: 'DEV', accountNumber: '0123456789', accountName: 'Teen' };
    expect((await as(t.app, teen).post('/v1/me/payout-accounts/bank', body)).body.error.code).toBe('adults_only');
    const unconfirmed = await signUp(t.app, { birthDate: '1990-04-02' });
    expect((await as(t.app, unconfirmed).post('/v1/me/payout-accounts/bank', body)).status).toBe(403);
  });
});

describe('payouts', () => {
  it('asks, gets approved and is paid, once, to the account set up', async () => {
    const u = await creator(5000, 'USD');
    // Nowhere to send it yet, and below the smallest payout.
    expect((await as(t.app, u).post('/v1/me/payouts', { amountCents: 2000, currency: 'USD' })).status).toBe(400);
    await as(t.app, u).post('/v1/me/payout-accounts/bank', { currency: 'USD', bankCode: 'DEV', accountNumber: '0123456789', accountName: 'Ada Obi' });
    expect((await as(t.app, u).post('/v1/me/payouts', { amountCents: 999, currency: 'USD' })).status).toBe(400);
    const asked = await as(t.app, u).post('/v1/me/payouts', { amountCents: 2000, currency: 'USD' });
    expect(asked.status).toBe(201);
    const id = asked.body.payout.id;
    expect(await available(u, 'USD')).toBe(3000);

    const listed = (await as(t.app, admin).get('/v1/admin/payouts')).body.items.find((p: any) => p.id === id);
    expect(listed).toMatchObject({ amount_cents: 2000, available_cents: 3000, account_ready: true, account_label: 'Test Bank •••• 6789' });
    expect((await as(t.app, u).post(`/v1/admin/payouts/${id}/verify`)).status).toBe(403);
    expect((await as(t.app, admin).post(`/v1/admin/payouts/${id}/verify`)).body.status).toBe('verified');
    expect((await as(t.app, admin).post(`/v1/admin/payouts/${id}/verify`)).status).toBe(404);
    await drain();
    expect(await payoutStatus(id)).toEqual({ status: 'paid', failure_reason: null });
    expect((await as(t.app, u).get('/v1/me/payouts')).body.items[0]).toMatchObject({ id, status: 'paid', amountCents: 2000 });
    expect(await notified(u)).toContain('payout_paid');
    expect(await available(u, 'USD')).toBe(3000);
  });

  it('turned down: the money stays in the balance and the creator hears why', async () => {
    const u = await creator(5000, 'USD');
    await as(t.app, u).post('/v1/me/payout-accounts/bank', { currency: 'USD', bankCode: 'DEV', accountNumber: '0123456789', accountName: 'Ada Obi' });
    const id = (await as(t.app, u).post('/v1/me/payouts', { amountCents: 5000, currency: 'USD' })).body.payout.id;
    expect(await available(u, 'USD')).toBe(0);
    expect((await as(t.app, admin).post(`/v1/admin/payouts/${id}/reject`, { reason: 'We need to confirm who you are first.' })).body.status).toBe('failed');
    expect(await payoutStatus(id)).toEqual({ status: 'failed', failure_reason: 'We need to confirm who you are first.' });
    expect(await available(u, 'USD')).toBe(5000);
    expect(await notified(u)).toContain('payout_failed');
  });

  it('pays naira through Paystack, and a bounced transfer gives the money back', async () => {
    const u = await creator(5_000_000, 'NGN');
    const ngn = (await as(t.app, u).get('/v1/me/payout-accounts')).body.items.find((a: any) => a.currency === 'NGN');
    expect(ngn).toMatchObject({ provider: 'paystack', kind: 'bank', ready: false, minCents: 1_000_000 });
    // Only banks that take transfers are offered.
    expect((await as(t.app, u).get('/v1/payout-banks?currency=NGN')).body.items).toEqual([{ code: '058', name: 'GTBank', type: 'nuban' }]);
    const acct = await as(t.app, u).post('/v1/me/payout-accounts/bank', {
      currency: 'NGN',
      bankCode: '058',
      accountNumber: '0001234567',
      accountName: 'Ada Obi',
    });
    expect(acct.body.account.label).toBe('GTBank •••• 4567');
    expect(fake.calls.find((c) => c.url.endsWith('/transferrecipient'))!.body).toEqual({
      type: 'nuban',
      name: 'Ada Obi',
      account_number: '0001234567',
      bank_code: '058',
      currency: 'NGN',
    });

    const webhook = (event: string, reference: string) => {
      const payload = JSON.stringify({ event, data: { reference, status: event.split('.')[1] } });
      return t.app.inject({
        method: 'POST',
        url: '/v1/payments/webhook/paystack',
        payload,
        headers: { 'content-type': 'application/json', 'x-paystack-signature': signPaystackWebhook(SECRET, payload) },
      });
    };
    const payOut = async (amountCents: number) => {
      const id = (await as(t.app, u).post('/v1/me/payouts', { amountCents, currency: 'NGN' })).body.payout.id;
      await as(t.app, admin).post(`/v1/admin/payouts/${id}/verify`);
      await drain();
      return id as string;
    };

    // Sent, and on its way until Paystack says it arrived.
    const first = await payOut(2_000_000);
    expect(fake.calls.filter((c) => c.url.endsWith('/transfer')).at(-1)!.body).toEqual({
      source: 'balance',
      amount: 2_000_000,
      currency: 'NGN',
      recipient: 'RCP_abc123',
      reference: `ypl-payout-${first}`,
      reason: 'YAPILAPI earnings',
    });
    expect((await payoutStatus(first)).status).toBe('processing');
    expect((await webhook('transfer.success', `ypl-payout-${first}`)).statusCode).toBe(200);
    expect((await payoutStatus(first)).status).toBe('paid');

    // Refused by the bank: failed, and back in the balance to ask again.
    const second = await payOut(1_000_000);
    expect(await available(u, 'NGN')).toBe(2_000_000);
    await webhook('transfer.failed', `ypl-payout-${second}`);
    expect(await payoutStatus(second)).toEqual({ status: 'failed', failure_reason: 'The bank refused the payout.' });
    expect(await available(u, 'NGN')).toBe(3_000_000);

    // A transfer Paystack holds for a one-time code is not sent: the job tries again, the payout stays approved.
    fake.answer('otp');
    const third = await payOut(1_000_000);
    expect((await payoutStatus(third)).status).toBe('verified');
    fake.answer('pending');
  });
});
