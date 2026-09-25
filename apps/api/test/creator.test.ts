import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Client,
  createTestApp,
  makeStaff,
  signup,
  uniq,
  type TestApp,
  type TestUser,
} from './helpers.js';
import { follow, block, teenBirth } from './entity-helpers.js';
import {
  buy,
  idem,
  key,
  ledgerOf,
  mkProduct,
  okToken,
  sellerAccount,
  balanceOf,
  unbalancedTransactions,
} from './commerce-fixtures.js';
import {
  attributeConversions,
  hasActiveSubscription,
  processSubscriptionRenewals,
  runCreatorMaintenance,
  settleConversions,
  settlePartnershipPayments,
} from '../src/modules/creator/index.js';

let t: TestApp;
let admin: TestUser;
let support: TestUser;
beforeAll(async () => {
  t = await createTestApp({ PAYOUT_HOLD_DAYS: '0' });
  admin = await signup(t);
  await makeStaff(t, admin, 'admin');
  support = await signup(t);
  await makeStaff(t, support, 'support');
});
afterAll(async () => {
  await t.close();
});

const sql = (q: string, p: unknown[] = []) => t.ctx.db.query(q, p);
const n = async (q: string, p: unknown[] = []): Promise<number> =>
  Number((await sql(q, p)).rows[0].n);
const anon = () => new Client(t);
const TERMS = '2027-01';
const auditN = (action: string, targetId?: string) =>
  n(
    `SELECT count(*)::int AS n FROM audit_logs WHERE action = $1 AND ($2::text IS NULL OR target_id::text = $2)`,
    [action, targetId ?? null],
  );
const declineToken = (): string => `tok_decline:fp=${uniq('d')}`;

async function mkCreator(over: { verify?: boolean } = {}): Promise<TestUser> {
  const u = await signup(t);
  const r = await u.client.post('/v1/creator/join', { termsVersion: TERMS, category: 'music' });
  if (r.status !== 201) throw new Error(`join failed ${r.status} ${JSON.stringify(r.body)}`);
  if (over.verify) await verifyCreator(u);
  return u;
}
async function verifyCreator(u: TestUser): Promise<void> {
  const k = await u.client.post('/v1/creator/kyc', { country: 'US' });
  if (k.status !== 200) throw new Error(`kyc submit failed ${k.status} ${JSON.stringify(k.body)}`);
  const d = await admin.client.post(`/v1/staff/creators/${u.id}/kyc`, {
    decision: 'verify',
    note: 'documents checked',
  });
  if (d.status !== 200) throw new Error(`kyc verify failed ${d.status} ${JSON.stringify(d.body)}`);
}
async function mkPlan(c: TestUser, over: Record<string, unknown> = {}): Promise<any> {
  const r = await c.client.post('/v1/creator/plans', {
    name: `Plan ${uniq('p')}`,
    priceCents: 500,
    currency: 'USD',
    interval: 'month',
    tier: 1,
    ...over,
  });
  if (r.status !== 201) throw new Error(`plan failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
const subscribeReq = (
  u: TestUser,
  creatorId: string,
  planId: string,
  over: { token?: string; k?: string } = {},
) =>
  u.client.request('POST', `/v1/creators/${creatorId}/subscribe`, {
    headers: idem(over.k ?? key()),
    body: { planId, paymentMethod: over.token ?? okToken() },
  });
async function mkSub(u: TestUser, c: TestUser, plan: any, token?: string): Promise<any> {
  const r = await subscribeReq(u, c.id, plan.id, { token });
  if (r.status !== 201) throw new Error(`subscribe failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.subscription;
}
const subRow = async (id: string) =>
  (
    await sql(
      'SELECT status, current_period_end, renewal_attempts, next_retry_at, cancel_at_period_end, end_reason, payment_method_enc FROM subscriptions WHERE id = $1',
      [id],
    )
  ).rows[0];
const paymentsFor = (subId: string) =>
  n('SELECT count(*)::int AS n FROM subscription_payments WHERE subscription_id = $1', [subId]);

// ================================================================== onboarding
describe('become a creator', () => {
  it('requires login, current terms, adulthood; is idempotent; switches the profile mode', async () => {
    expect((await anon().post('/v1/creator/join', { termsVersion: TERMS })).status).toBe(401);
    const u = await signup(t);
    expect((await u.client.post('/v1/creator/join', { termsVersion: '1999-01' })).status).toBe(422);
    const teen = await signup(t, { birthDate: teenBirth() });
    expect((await teen.client.post('/v1/creator/join', { termsVersion: TERMS })).status).toBe(403);

    const first = await u.client.post('/v1/creator/join', { termsVersion: TERMS, category: 'art' });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      status: 'active',
      kycStatus: 'unverified',
      termsAccepted: true,
      mode: 'creator',
    });
    const again = await u.client.post('/v1/creator/join', { termsVersion: TERMS });
    expect(again.status).toBe(200);
    expect(await n('SELECT count(*)::int AS n FROM creators WHERE user_id = $1', [u.id])).toBe(1);
    expect((await sql('SELECT mode FROM profiles WHERE user_id = $1', [u.id])).rows[0].mode).toBe(
      'creator',
    );
    expect(await auditN('creator.joined', u.id)).toBe(1);

    const sw = await u.client.put('/v1/creator/mode', { mode: 'personal' });
    expect(sw.body.mode).toBe('personal');
    expect(
      (await sql('SELECT status FROM creators WHERE user_id = $1', [u.id])).rows[0].status,
    ).toBe('active');
    expect((await u.client.put('/v1/creator/mode', { mode: 'creator' })).body.mode).toBe('creator');
    const stranger = await signup(t);
    expect((await stranger.client.put('/v1/creator/mode', { mode: 'creator' })).status).toBe(403);
    const me = await u.client.get('/v1/creator/me');
    expect(me.body.creator.userId).toBe(u.id);
    expect((await stranger.client.get('/v1/creator/me')).body.creator).toBeNull();
  });

  it('a suspended creator cannot monetise and cannot rejoin by themselves', async () => {
    const c = await mkCreator();
    await sql(`UPDATE creators SET status = 'suspended' WHERE user_id = $1`, [c.id]);
    expect((await c.client.post('/v1/creator/join', { termsVersion: TERMS })).status).toBe(403);
    expect(
      (
        await c.client.post('/v1/creator/plans', {
          name: 'x',
          priceCents: 500,
          currency: 'USD',
          interval: 'month',
        })
      ).status,
    ).toBe(403);
    expect((await c.client.get(`/v1/creators/${c.id}/plans`)).status).toBe(404);
  });

  it('the COMMERCE flag switches the whole surface off', async () => {
    const c = await mkCreator();
    await sql(`UPDATE feature_flags SET enabled = false WHERE key = 'COMMERCE'`);
    t.ctx.flags.invalidate();
    try {
      expect((await c.client.get('/v1/creator/me')).status).toBe(404);
      expect(
        (
          await c.client.post('/v1/creator/plans', {
            name: 'x',
            priceCents: 500,
            currency: 'USD',
            interval: 'month',
          })
        ).status,
      ).toBe(404);
    } finally {
      await sql(`UPDATE feature_flags SET enabled = true WHERE key = 'COMMERCE'`);
      t.ctx.flags.invalidate();
    }
    expect((await c.client.get('/v1/creator/me')).status).toBe(200);
  });
});

describe('creator verification (KYC) with staff decision and audit', () => {
  it('walks unverified -> pending -> rejected -> pending -> verified; only staff decide; everything is recorded', async () => {
    const c = await mkCreator();
    const other = await signup(t);
    expect((await other.client.post('/v1/creator/kyc', { country: 'US' })).status).toBe(403);
    // Nobody can be verified before they submit.
    expect(
      (
        await admin.client.post(`/v1/staff/creators/${c.id}/kyc`, {
          decision: 'verify',
          note: 'too early',
        })
      ).status,
    ).toBe(409);

    const sub = await c.client.post('/v1/creator/kyc', { country: 'us' });
    expect(sub.status).toBe(200);
    expect(sub.body.kycStatus).toBe('pending');
    expect((await c.client.post('/v1/creator/kyc', { country: 'US' })).body.kycStatus).toBe(
      'pending',
    ); // idempotent while pending

    // Authorization matrix for the decision.
    expect(
      (await anon().post(`/v1/staff/creators/${c.id}/kyc`, { decision: 'verify', note: 'abc' }))
        .status,
    ).toBe(401);
    expect(
      (
        await c.client.post(`/v1/staff/creators/${c.id}/kyc`, {
          decision: 'verify',
          note: 'i am me',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await support.client.post(`/v1/staff/creators/${c.id}/kyc`, {
          decision: 'verify',
          note: 'support cannot',
        })
      ).status,
    ).toBe(403);
    expect(
      (await admin.client.post(`/v1/staff/creators/${c.id}/kyc`, { decision: 'reject' })).status,
    ).toBe(400); // a note is mandatory
    expect((await c.client.get('/v1/staff/creators/kyc')).status).toBe(403);
    const queue = await admin.client.get('/v1/staff/creators/kyc', { status: 'pending' });
    expect(queue.body.items.map((i: any) => i.userId)).toContain(c.id);

    const rej = await admin.client.post(`/v1/staff/creators/${c.id}/kyc`, {
      decision: 'reject',
      note: 'blurry document',
    });
    expect(rej.body.kycStatus).toBe('rejected');
    expect((await c.client.get('/v1/creator/me')).body.creator.kycNote).toBe('blurry document');
    expect(
      (
        await admin.client.post(`/v1/staff/creators/${c.id}/kyc`, {
          decision: 'verify',
          note: 'again',
        })
      ).status,
    ).toBe(409);

    expect((await c.client.post('/v1/creator/kyc', { country: 'US' })).body.kycStatus).toBe(
      'pending',
    );
    const ok = await admin.client.post(`/v1/staff/creators/${c.id}/kyc`, {
      decision: 'verify',
      note: 'documents checked',
    });
    expect(ok.body.kycStatus).toBe('verified');
    expect(
      (await sql('SELECT kyc_status FROM payout_accounts WHERE owner_user_id = $1', [c.id])).rows[0]
        .kyc_status,
    ).toBe('verified');
    const hist = (await c.client.get('/v1/creator/me')).body.verification as any[];
    expect(hist.map((h) => `${h.from}>${h.to}`).reverse()).toEqual([
      'unverified>pending',
      'pending>rejected',
      'rejected>pending',
      'pending>verified',
    ]);
    expect(await auditN('creator.kyc_verified', c.id)).toBe(1);
    expect(await auditN('creator.kyc_rejected', c.id)).toBe(1);
    expect(await auditN('creator.kyc_submitted', c.id)).toBe(2);
    expect((await c.client.post('/v1/creator/kyc', { country: 'US' })).status).toBe(409); // already verified
  });
});

// ================================================================== plans and subscriptions
describe('subscription plans', () => {
  it('creator manages tiers; public list shows active plans only; blocks hide the creator', async () => {
    const c = await mkCreator();
    const reader = await signup(t);
    const stranger = await signup(t);
    expect(
      (
        await stranger.client.post('/v1/creator/plans', {
          name: 'x',
          priceCents: 500,
          currency: 'USD',
          interval: 'month',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await c.client.post('/v1/creator/plans', {
          name: 'cheap',
          priceCents: 5,
          currency: 'USD',
          interval: 'month',
        })
      ).status,
    ).toBe(400);
    const p1 = await mkPlan(c, { tier: 1, benefits: ['Early access'] });
    const p2 = await mkPlan(c, { tier: 2, priceCents: 1500 });
    expect(
      (
        await c.client.post('/v1/creator/plans', {
          name: 'dup',
          priceCents: 700,
          currency: 'USD',
          interval: 'month',
          tier: 2,
        })
      ).status,
    ).toBe(409);
    await mkPlan(c, { tier: 2, interval: 'year', priceCents: 15000 }); // same tier, different interval is fine
    const list = await reader.client.get(`/v1/creators/${c.id}/plans`);
    expect(list.body.items).toHaveLength(3);
    expect(list.body.items[0].benefits).toEqual(['Early access']);

    const patched = await c.client.patch(`/v1/creator/plans/${p2.id}`, {
      active: false,
      name: 'Gold (closed)',
    });
    expect(patched.body.active).toBe(false);
    expect((await reader.client.get(`/v1/creators/${c.id}/plans`)).body.items).toHaveLength(2);
    expect((await c.client.get('/v1/creator/plans')).body.items).toHaveLength(3);
    expect(
      (await stranger.client.patch(`/v1/creator/plans/${p1.id}`, { name: 'hijack' })).status,
    ).toBe(403);
    const other = await mkCreator();
    expect(
      (await other.client.patch(`/v1/creator/plans/${p1.id}`, { name: 'hijack' })).status,
    ).toBe(404);

    await block(c, reader);
    expect((await reader.client.get(`/v1/creators/${c.id}/plans`)).status).toBe(404);
    expect((await subscribeReq(reader, c.id, p1.id)).status).toBe(404);
  });

  it('limits active plans', async () => {
    const c = await mkCreator();
    for (let tier = 1; tier <= 5; tier++) await mkPlan(c, { tier });
    const r = await c.client.post('/v1/creator/plans', {
      name: 'sixth',
      priceCents: 500,
      currency: 'USD',
      interval: 'month',
      tier: 6,
    });
    expect(r.status).toBe(422);
    expect(r.body.error.details?.reason ?? r.body.details?.reason).toBe('too_many_plans');
  });
});

describe('subscribing: idempotent, ledger-backed, webhook-confirmed', () => {
  it('subscribes once per Idempotency-Key, books the ledger with the platform fee, and grants entitlement', async () => {
    const c = await mkCreator();
    const plan = await mkPlan(c, { tier: 2, priceCents: 1200 });
    const u = await signup(t);
    expect(
      (
        await u.client.post(`/v1/creators/${c.id}/subscribe`, {
          planId: plan.id,
          paymentMethod: okToken(),
        })
      ).status,
    ).toBe(400); // key required
    expect(
      (
        await anon().post(`/v1/creators/${c.id}/subscribe`, {
          planId: plan.id,
          paymentMethod: okToken(),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await u.client.request('POST', `/v1/creators/${c.id}/subscribe`, {
          headers: idem(),
          body: { planId: plan.id, paymentMethod: '4242424242424242' },
        })
      ).status,
    ).toBe(400); // never card numbers

    const k = key();
    const tok = okToken();
    const r1 = await u.client.request('POST', `/v1/creators/${c.id}/subscribe`, {
      headers: idem(k),
      body: { planId: plan.id, paymentMethod: tok },
    });
    expect(r1.status).toBe(201);
    expect(r1.body.subscription.status).toBe('active');
    expect(JSON.stringify(r1.body)).not.toContain(tok); // the token is never echoed
    const subId = r1.body.subscription.id;
    const r2 = await u.client.request('POST', `/v1/creators/${c.id}/subscribe`, {
      headers: idem(k),
      body: { planId: plan.id, paymentMethod: tok },
    });
    expect(r2.status).toBe(200);
    expect(r2.headers['idempotent-replayed']).toBe('true');
    expect(r2.body.subscription.id).toBe(subId);
    expect(
      (
        await u.client.request('POST', `/v1/creators/${c.id}/subscribe`, {
          headers: idem(k),
          body: { planId: plan.id, paymentMethod: okToken() },
        })
      ).status,
    ).toBe(409); // same key, other body
    expect((await subscribeReq(u, c.id, plan.id)).status).toBe(409); // already subscribed
    expect(await paymentsFor(subId)).toBe(1);

    const payment = (
      await sql(
        `SELECT p.id, p.status, p.amount_cents, p.platform_fee_cents FROM payments p JOIN subscription_payments sp ON sp.payment_id = p.id WHERE sp.subscription_id = $1`,
        [subId],
      )
    ).rows[0];
    expect(payment.status).toBe('captured');
    const lines = await ledgerOf(t, 'payment_captured', 'payment', payment.id);
    const net = Number(payment.amount_cents) - Number(payment.platform_fee_cents);
    expect(lines.find((l) => l.account === sellerAccount(c.id))).toMatchObject({
      direction: 'credit',
      amount: net,
    });
    expect(Number(payment.platform_fee_cents)).toBeGreaterThan(0);
    expect(await unbalancedTransactions(t)).toEqual([]);

    expect(await hasActiveSubscription(t.ctx, u.id, c.id)).toBe(true);
    expect(await hasActiveSubscription(t.ctx, u.id, c.id, 2)).toBe(true);
    expect(await hasActiveSubscription(t.ctx, u.id, c.id, 3)).toBe(false);
    expect(await hasActiveSubscription(t.ctx, c.id, u.id)).toBe(false);
    expect(await auditN('subscription.activated', subId)).toBe(1);
    const mine = await u.client.get('/v1/me/subscriptions');
    expect(mine.body.items[0]).toMatchObject({ id: subId, status: 'active', tier: 2 });
    expect(JSON.stringify(mine.body)).not.toContain('payment_method');
    const subs = await c.client.get('/v1/creator/subscribers');
    expect(subs.body.items.map((s: any) => s.id)).toContain(subId);
    expect((await u.client.get('/v1/creator/subscribers')).status).toBe(403);
  });

  it('declined first payment never activates; teens and self-subscription are refused', async () => {
    const c = await mkCreator();
    const plan = await mkPlan(c);
    const u = await signup(t);
    const r = await subscribeReq(u, c.id, plan.id, { token: declineToken() });
    expect(r.status).toBe(402);
    expect(await hasActiveSubscription(t.ctx, u.id, c.id)).toBe(false);
    expect(
      (await sql(`SELECT status FROM subscriptions WHERE subscriber_id = $1`, [u.id])).rows[0]
        .status,
    ).toBe('expired');
    // A new attempt with a good card works afterwards.
    expect((await subscribeReq(u, c.id, plan.id)).status).toBe(201);

    const teen = await signup(t, { birthDate: teenBirth() });
    expect((await subscribeReq(teen, c.id, plan.id)).status).toBe(403);
    expect((await subscribeReq(c, c.id, plan.id)).status).toBe(403);
    const suspended = await mkCreator();
    const sp = await mkPlan(suspended);
    await sql(`UPDATE creators SET status = 'suspended' WHERE user_id = $1`, [suspended.id]);
    expect((await subscribeReq(u, suspended.id, sp.id)).status).toBe(409); // creator_unavailable
    // A plan of another creator cannot be bought through this creator's URL.
    expect((await subscribeReq(await signup(t), c.id, sp.id)).status).toBe(404);
  });
});

describe('subscription lifecycle: renewal, dunning, cancellation', () => {
  it('renews at period end exactly once, even when the job runs twice or concurrently', async () => {
    const c = await mkCreator();
    const plan = await mkPlan(c);
    const u = await signup(t);
    const sub = await mkSub(u, c, plan);
    const before = await subRow(sub.id);
    const now = new Date(new Date(before.current_period_end).getTime() + 60_000);
    const [a, b] = await Promise.all([
      processSubscriptionRenewals(t.ctx, { now }),
      processSubscriptionRenewals(t.ctx, { now }),
    ]);
    expect(a.charged + b.charged).toBeGreaterThanOrEqual(1); // other subscriptions of earlier tests may be due too: assert on THIS subscription below
    await processSubscriptionRenewals(t.ctx, { now });
    expect(await paymentsFor(sub.id)).toBe(2);
    const after = await subRow(sub.id);
    expect(after.status).toBe('active');
    expect(new Date(after.current_period_end).getTime()).toBeGreaterThan(
      new Date(before.current_period_end).getTime() + 27 * 86_400_000,
    );
    expect(await auditN('subscription.renewed', sub.id)).toBe(1);
    expect(await unbalancedTransactions(t)).toEqual([]);
    const captured = await n(
      `SELECT count(*)::int AS n FROM subscription_payments sp JOIN payments p ON p.id = sp.payment_id WHERE sp.subscription_id = $1 AND p.status = 'captured'`,
      [sub.id],
    );
    expect(captured).toBe(2);
  });

  it('a failing renewal goes past_due, keeps access during the grace period, retries on days 1/3/5 and then expires', async () => {
    const c = await mkCreator();
    const plan = await mkPlan(c);
    const u = await signup(t);
    const sub = await mkSub(u, c, plan);
    const anchor = new Date((await subRow(sub.id)).current_period_end);
    const at = (days: number, mins = 1) =>
      new Date(anchor.getTime() + days * 86_400_000 + mins * 60_000);
    // The card starts failing.
    expect(
      (
        await u.client.put(`/v1/subscriptions/${sub.id}/payment-method`, {
          paymentMethod: declineToken(),
        })
      ).status,
    ).toBe(200);

    let r = await processSubscriptionRenewals(t.ctx, { now: at(0) });
    expect(r.pastDue).toBe(1);
    let row = await subRow(sub.id);
    expect(row).toMatchObject({ status: 'past_due', renewal_attempts: 1 });
    expect(new Date(row.next_retry_at).getTime()).toBe(anchor.getTime() + 86_400_000);
    expect((await u.client.get('/v1/me/subscriptions')).body.items[0]).toMatchObject({
      status: 'past_due',
      renewalAttempts: 1,
    });

    r = await processSubscriptionRenewals(t.ctx, { now: at(0, 30) }); // nothing due yet: no second charge
    expect(r.charged).toBe(0);
    expect(await paymentsFor(sub.id)).toBe(2);

    await processSubscriptionRenewals(t.ctx, { now: at(1) });
    row = await subRow(sub.id);
    expect(row).toMatchObject({ status: 'past_due', renewal_attempts: 2 });
    expect(new Date(row.next_retry_at).getTime()).toBe(anchor.getTime() + 3 * 86_400_000);
    await processSubscriptionRenewals(t.ctx, { now: at(3) });
    row = await subRow(sub.id);
    expect(row.renewal_attempts).toBe(3);
    expect(new Date(row.next_retry_at).getTime()).toBe(anchor.getTime() + 5 * 86_400_000);
    r = await processSubscriptionRenewals(t.ctx, { now: at(5) });
    expect(r.expired).toBe(1);
    row = await subRow(sub.id);
    expect(row).toMatchObject({
      status: 'expired',
      end_reason: 'payment_failed',
      payment_method_enc: null,
    });
    expect(await hasActiveSubscription(t.ctx, u.id, c.id)).toBe(false);
    expect(await paymentsFor(sub.id)).toBe(5);
    expect(await auditN('subscription.past_due', sub.id)).toBe(3);
    expect(await auditN('subscription.expired', sub.id)).toBe(1);
    expect(
      await n(
        `SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND kind = 'payment_subscription_expired'`,
        [u.id],
      ),
    ).toBe(1);
    // Nothing is charged after expiry, however often the job runs.
    await processSubscriptionRenewals(t.ctx, { now: at(30) });
    expect(await paymentsFor(sub.id)).toBe(5);
    // Subscribing again is possible (a new subscription).
    expect((await subscribeReq(u, c.id, plan.id)).status).toBe(201);
  });

  it('updating the card while past_due recovers the subscription on the next run', async () => {
    const c = await mkCreator();
    const plan = await mkPlan(c);
    const u = await signup(t);
    const sub = await mkSub(u, c, plan);
    const anchor = new Date((await subRow(sub.id)).current_period_end);
    await u.client.put(`/v1/subscriptions/${sub.id}/payment-method`, {
      paymentMethod: declineToken(),
    });
    await processSubscriptionRenewals(t.ctx, { now: new Date(anchor.getTime() + 60_000) });
    expect((await subRow(sub.id)).status).toBe('past_due');
    expect(
      (
        await u.client.put(`/v1/subscriptions/${sub.id}/payment-method`, {
          paymentMethod: okToken(),
        })
      ).body.status,
    ).toBe('past_due');
    await processSubscriptionRenewals(t.ctx, { now: new Date(anchor.getTime() + 2 * 60_000) });
    const row = await subRow(sub.id);
    expect(row).toMatchObject({ status: 'active', renewal_attempts: 0, next_retry_at: null });
    // Somebody else's subscription cannot be touched.
    const other = await signup(t);
    expect(
      (
        await other.client.put(`/v1/subscriptions/${sub.id}/payment-method`, {
          paymentMethod: okToken(),
        })
      ).status,
    ).toBe(404);
  });

  it('cancel at period end keeps access until then; resume undoes it; the renewal job ends it without charging', async () => {
    const c = await mkCreator();
    const plan = await mkPlan(c);
    const u = await signup(t);
    const sub = await mkSub(u, c, plan);
    const other = await signup(t);
    expect((await other.client.post(`/v1/subscriptions/${sub.id}/cancel`, {})).status).toBe(404);
    const cancel = await u.client.post(`/v1/subscriptions/${sub.id}/cancel`, {});
    expect(cancel.body).toMatchObject({ status: 'active', cancelAtPeriodEnd: true });
    expect(await hasActiveSubscription(t.ctx, u.id, c.id)).toBe(true);
    expect((await u.client.post(`/v1/subscriptions/${sub.id}/resume`)).body.cancelAtPeriodEnd).toBe(
      false,
    );
    expect((await u.client.post(`/v1/subscriptions/${sub.id}/resume`)).status).toBe(409);
    await u.client.post(`/v1/subscriptions/${sub.id}/cancel`, {});
    const anchor = new Date((await subRow(sub.id)).current_period_end);
    const r = await processSubscriptionRenewals(t.ctx, {
      now: new Date(anchor.getTime() + 60_000),
    });
    expect(r.ended).toBe(1);
    expect(await paymentsFor(sub.id)).toBe(1);
    expect(await subRow(sub.id)).toMatchObject({
      status: 'cancelled',
      end_reason: 'cancelled_by_subscriber',
      payment_method_enc: null,
    });
    expect((await u.client.post(`/v1/subscriptions/${sub.id}/cancel`, {})).status).toBe(409);
    expect(await auditN('subscription.cancelled', sub.id)).toBe(2);
  });

  it('immediate cancellation and creator removal end access now', async () => {
    const c = await mkCreator();
    const plan = await mkPlan(c);
    const a = await signup(t);
    const b = await signup(t);
    const sa = await mkSub(a, c, plan);
    const sb = await mkSub(b, c, plan);
    expect(
      (await a.client.post(`/v1/subscriptions/${sa.id}/cancel`, { immediately: true })).body.status,
    ).toBe('cancelled');
    expect(await hasActiveSubscription(t.ctx, a.id, c.id)).toBe(false);
    const stranger = await mkCreator();
    expect((await stranger.client.post(`/v1/creator/subscribers/${sb.id}/cancel`)).status).toBe(
      404,
    );
    expect((await b.client.post(`/v1/creator/subscribers/${sb.id}/cancel`)).status).toBe(403);
    expect((await c.client.post(`/v1/creator/subscribers/${sb.id}/cancel`)).body).toMatchObject({
      status: 'cancelled',
    });
    expect(await hasActiveSubscription(t.ctx, b.id, c.id)).toBe(false);
    expect((await subRow(sb.id)).end_reason).toBe('cancelled_by_creator');
  });

  it('hasActiveSubscription mirrors the grace rules', async () => {
    const c = await mkCreator();
    const plan = await mkPlan(c);
    const u = await signup(t);
    const sub = await mkSub(u, c, plan);
    const setEnd = (status: string, hoursAgo: number) =>
      sql(
        `UPDATE subscriptions SET status = $2, current_period_end = now() - ($3 || ' hours')::interval WHERE id = $1`,
        [sub.id, status, String(hoursAgo)],
      );
    await setEnd('active', 12);
    expect(await hasActiveSubscription(t.ctx, u.id, c.id)).toBe(true); // renewal job is a little late
    await setEnd('active', 30);
    expect(await hasActiveSubscription(t.ctx, u.id, c.id)).toBe(false);
    await setEnd('past_due', 60);
    expect(await hasActiveSubscription(t.ctx, u.id, c.id)).toBe(true); // inside the 3-day grace
    await setEnd('past_due', 80);
    expect(await hasActiveSubscription(t.ctx, u.id, c.id)).toBe(false);
    await setEnd('cancelled', -100);
    expect(await hasActiveSubscription(t.ctx, u.id, c.id)).toBe(false);
  });
});

// ================================================================== subscribers-only posts
describe('subscribers audience', () => {
  it('is visible to entitled subscribers only: direct GET, author page, feed and search', async () => {
    const c = await mkCreator();
    const plan = await mkPlan(c, { tier: 1 });
    const gold = await mkPlan(c, { tier: 2, priceCents: 2000 });
    const sub1 = await signup(t);
    const sub2 = await signup(t);
    const fan = await signup(t);
    const nobody = await signup(t);
    const s1 = await mkSub(sub1, c, plan);
    await mkSub(sub2, c, gold);
    await follow(fan, c);
    await follow(sub1, c);
    await follow(sub2, c);

    const word = `zx${uniq('w')}q`;
    const post = await c.client.post('/v1/creator/posts', { body: `${word} for subscribers` });
    expect(post.status).toBe(201);
    expect(post.body.visibility).toBe('subscribers');
    const tiered = await c.client.post('/v1/creator/posts', {
      body: `${word} gold only`,
      minTier: 2,
    });
    expect(tiered.status).toBe(201);

    const get = (u: TestUser | null, id: string) => (u ? u.client : anon()).get(`/v1/posts/${id}`);
    expect((await get(c, post.body.id)).status).toBe(200);
    expect((await get(sub1, post.body.id)).status).toBe(200);
    expect((await get(sub2, post.body.id)).status).toBe(200);
    for (const viewer of [fan, nobody, null])
      expect((await get(viewer, post.body.id)).status).toBe(404); // 404, not 403: existence is not revealed
    expect((await get(sub1, tiered.body.id)).status).toBe(404); // tier 1 cannot see a tier 2 post
    expect((await get(sub2, tiered.body.id)).status).toBe(200);

    const ids = (r: any) => (r.body.items as any[]).map((x) => x.id);
    expect(ids(await sub1.client.get(`/v1/users/${c.username}/posts`))).toEqual(
      expect.arrayContaining([post.body.id]),
    );
    expect(ids(await sub1.client.get(`/v1/users/${c.username}/posts`))).not.toContain(
      tiered.body.id,
    );
    expect(ids(await fan.client.get(`/v1/users/${c.username}/posts`))).not.toContain(post.body.id);
    expect(ids(await sub1.client.get('/v1/feed', { mode: 'following' }))).toContain(post.body.id);
    expect(ids(await fan.client.get('/v1/feed', { mode: 'following' }))).not.toContain(
      post.body.id,
    );
    const found = async (u: TestUser | null) =>
      (
        (await (u ? u.client : anon()).get('/v1/search', { q: word, types: 'posts', limit: '50' }))
          .body.results.posts?.items ?? []
      ).map((x: any) => x.id);
    expect(await found(sub2)).toEqual(expect.arrayContaining([post.body.id, tiered.body.id]));
    expect(await found(sub1)).toEqual([post.body.id]);
    expect(await found(fan)).toEqual([]);
    expect(await found(null)).toEqual([]);

    // Entitlement follows the subscription: past_due inside the grace period still sees it, expired does not.
    await sql(
      `UPDATE subscriptions SET status = 'past_due', current_period_end = now() - interval '1 day' WHERE id = $1`,
      [s1.id],
    );
    expect((await get(sub1, post.body.id)).status).toBe(200);
    await sql(`UPDATE subscriptions SET status = 'expired' WHERE id = $1`, [s1.id]);
    expect((await get(sub1, post.body.id)).status).toBe(404);
    expect(await found(sub1)).toEqual([]);
    // Blocking cuts access as well.
    await block(c, sub2);
    expect((await get(sub2, post.body.id)).status).toBe(404);
  });

  it('only active adult creators can publish for subscribers, and minTier needs the subscribers audience', async () => {
    const plain = await signup(t);
    const viaContent = await plain.client.post('/v1/posts', {
      body: 'sneaky',
      visibility: 'subscribers',
    });
    expect(viaContent.status).toBe(403);
    expect((await plain.client.post('/v1/creator/posts', { body: 'x' })).status).toBe(403);
    const c = await mkCreator();
    expect(
      (await c.client.post('/v1/creator/posts', { body: 'x', visibility: 'public', minTier: 2 }))
        .status,
    ).toBe(400);
    const direct = await c.client.post('/v1/posts', {
      body: 'direct subscribers post',
      visibility: 'subscribers',
    });
    expect(direct.status).toBe(201);
    await sql(`UPDATE creators SET status = 'suspended' WHERE user_id = $1`, [c.id]);
    expect(
      (await c.client.post('/v1/posts', { body: 'again', visibility: 'subscribers' })).status,
    ).toBe(403);
    expect((await c.client.post('/v1/creator/posts', { body: 'again' })).status).toBe(403);
  });
});

// ================================================================== tips
describe('tips', () => {
  it('are idempotent, settled by the signed webhook, ledger-booked and screened', async () => {
    const c = await mkCreator();
    const u = await signup(t);
    const body = {
      amountCents: 700,
      currency: 'USD',
      message: 'Great work',
      paymentMethod: okToken(),
    };
    expect((await u.client.post(`/v1/creators/${c.id}/tips`, body)).status).toBe(400);
    expect((await anon().post(`/v1/creators/${c.id}/tips`, body)).status).toBe(401);
    const k = key();
    const r1 = await u.client.request('POST', `/v1/creators/${c.id}/tips`, {
      headers: idem(k),
      body,
    });
    expect(r1.status).toBe(201);
    expect(r1.body.tip.status).toBe('completed');
    const r2 = await u.client.request('POST', `/v1/creators/${c.id}/tips`, {
      headers: idem(k),
      body,
    });
    expect(r2.status).toBe(200);
    expect(r2.body.tip.id).toBe(r1.body.tip.id);
    expect(
      (
        await u.client.request('POST', `/v1/creators/${c.id}/tips`, {
          headers: idem(k),
          body: { ...body, amountCents: 701 },
        })
      ).status,
    ).toBe(409);
    expect(await n('SELECT count(*)::int AS n FROM tips WHERE creator_id = $1', [c.id])).toBe(1);
    const p = (
      await sql(
        `SELECT p.id, p.amount_cents, p.platform_fee_cents FROM payments p JOIN tips t2 ON t2.payment_id = p.id WHERE t2.creator_id = $1`,
        [c.id],
      )
    ).rows[0];
    const lines = await ledgerOf(t, 'payment_captured', 'payment', p.id);
    expect(lines.find((l) => l.account === sellerAccount(c.id))?.amount).toBe(
      Number(p.amount_cents) - Number(p.platform_fee_cents),
    );
    expect(await unbalancedTransactions(t)).toEqual([]);
    const supporters = await c.client.get('/v1/creator/supporters');
    expect(supporters.body.tips).toHaveLength(1);
    expect(supporters.body.tips[0]).toMatchObject({ amountCents: 700, message: 'Great work' });
    expect(
      await n(
        `SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND kind = 'payment_tip_received'`,
        [c.id],
      ),
    ).toBe(1);
  });

  it('declines are recorded as failed and refused; minors, self tips, blocked users and non-creators cannot', async () => {
    const c = await mkCreator();
    const u = await signup(t);
    const decl = await u.client.request('POST', `/v1/creators/${c.id}/tips`, {
      headers: idem(),
      body: { amountCents: 500, currency: 'USD', paymentMethod: declineToken() },
    });
    expect(decl.status).toBe(402);
    expect(
      (await sql(`SELECT status FROM tips WHERE from_user_id = $1`, [u.id])).rows[0].status,
    ).toBe('failed');
    const send = (who: TestUser, to: string, over: Record<string, unknown> = {}) =>
      who.client.request('POST', `/v1/creators/${to}/tips`, {
        headers: idem(),
        body: { amountCents: 500, currency: 'USD', paymentMethod: okToken(), ...over },
      });
    expect((await send(await signup(t, { birthDate: teenBirth() }), c.id)).status).toBe(403);
    expect((await send(c, c.id)).status).toBe(403);
    expect((await send(u, (await signup(t)).id)).status).toBe(404); // not a creator
    expect((await send(u, c.id, { amountCents: 10 })).status).toBe(400);
    expect((await send(u, c.id, { amountCents: 100_000_000 })).status).toBe(400);
    const post = await c.client.post('/v1/posts', { body: 'a public post' });
    expect((await send(u, c.id, { postId: post.body.id })).status).toBe(201);
    const otherPost = await (await mkCreator()).client.post('/v1/posts', { body: 'someone else' });
    expect((await send(u, c.id, { postId: otherPost.body.id })).status).toBe(404); // the post must be the creator's
    const blocked = await signup(t);
    await block(c, blocked);
    expect((await send(blocked, c.id)).status).toBe(404);
  });
});

// ================================================================== gifts
describe('gifts', () => {
  it('staff curate the catalog; purchases snapshot the price and post to the ledger', async () => {
    const c = await mkCreator();
    const u = await signup(t);
    const code = `rose_${uniq('g').slice(0, 8)}`;
    expect(
      (
        await u.client.post('/v1/staff/gifts', {
          code,
          name: 'Rose',
          priceCents: 300,
          currency: 'USD',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await support.client.post('/v1/staff/gifts', {
          code,
          name: 'Rose',
          priceCents: 300,
          currency: 'USD',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await admin.client.post('/v1/staff/gifts', {
          code: 'Bad Code!',
          name: 'x',
          priceCents: 300,
          currency: 'USD',
        })
      ).status,
    ).toBe(400);
    const created = await admin.client.post('/v1/staff/gifts', {
      code,
      name: 'Rose',
      priceCents: 300,
      currency: 'USD',
    });
    expect(created.status).toBe(201);
    expect(
      (
        await admin.client.post('/v1/staff/gifts', {
          code,
          name: 'Dup',
          priceCents: 300,
          currency: 'USD',
        })
      ).status,
    ).toBe(409);
    expect((await u.client.get('/v1/gifts/catalog')).body.items.map((g: any) => g.code)).toContain(
      code,
    );
    expect(await auditN('gift_catalog.created', created.body.id)).toBe(1);

    const buyGift = (k = key()) =>
      u.client.request('POST', `/v1/creators/${c.id}/gifts`, {
        headers: idem(k),
        body: { giftCode: code, paymentMethod: okToken(), message: 'Thanks!' },
      });
    const k = key();
    const g1 = await buyGift(k);
    expect(g1.status).toBe(201);
    expect(g1.body.gift).toMatchObject({ status: 'completed', code, amountCents: 300 });
    expect((await buyGift(k)).status).toBe(409); // different payment token = different body under the same key
    const p = (
      await sql(
        `SELECT p.id, p.amount_cents, p.platform_fee_cents FROM payments p JOIN gifts g ON g.payment_id = p.id WHERE g.creator_id = $1`,
        [c.id],
      )
    ).rows[0];
    expect(Number(p.amount_cents)).toBe(300);
    expect(
      (await ledgerOf(t, 'payment_captured', 'payment', p.id)).find(
        (l) => l.account === sellerAccount(c.id),
      )?.amount,
    ).toBe(300 - Number(p.platform_fee_cents));

    // A price change only affects future gifts; old rows keep their snapshot.
    await admin.client.patch(`/v1/staff/gifts/${created.body.id}`, { priceCents: 500 });
    const g2 = await buyGift();
    expect(g2.body.gift.amountCents).toBe(500);
    expect(
      Number(
        (await sql(`SELECT amount_cents FROM gifts WHERE id = $1`, [g1.body.gift.id])).rows[0]
          .amount_cents,
      ),
    ).toBe(300);
    await admin.client.patch(`/v1/staff/gifts/${created.body.id}`, { active: false });
    expect((await buyGift()).status).toBe(404);
    expect(
      (await u.client.get('/v1/gifts/catalog')).body.items.map((g: any) => g.code),
    ).not.toContain(code);
    expect(
      (await admin.client.get('/v1/staff/gifts')).body.items.map((g: any) => g.code),
    ).toContain(code);
    expect((await c.client.get('/v1/creator/supporters')).body.gifts).toHaveLength(2);
    expect(
      (
        await u.client.request('POST', `/v1/creators/${c.id}/gifts`, {
          headers: idem(),
          body: { giftCode: 'nope_nope', paymentMethod: okToken() },
        })
      ).status,
    ).toBe(404);
  });
});

// ================================================================== affiliate
describe('affiliate links', () => {
  const UA = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0 Safari/537.36';
  const click = (u: TestUser | null, code: string, ua = UA) =>
    (u ? u.client : anon()).request('GET', `/v1/affiliate/r/${code}`, {
      headers: { 'user-agent': ua },
    });

  it('needs the seller to opt in and caps the commission', async () => {
    const seller = await signup(t);
    const creator = await mkCreator();
    const product = await mkProduct(seller);
    expect(
      (
        await creator.client.post('/v1/creator/affiliate/links', {
          productId: product.id,
          commissionBps: 500,
        })
      ).status,
    ).toBe(409); // not offered
    const stranger = await signup(t);
    expect(
      (await stranger.client.put(`/v1/products/${product.id}/affiliate`, { maxBps: 1000 })).status,
    ).toBe(404);
    expect(
      (await seller.client.put(`/v1/products/${product.id}/affiliate`, { maxBps: 6000 })).status,
    ).toBe(400);
    expect(
      (await seller.client.put(`/v1/products/${product.id}/affiliate`, { maxBps: 1000 })).body
        .maxBps,
    ).toBe(1000);
    expect(
      (
        await creator.client.post('/v1/creator/affiliate/links', {
          productId: product.id,
          commissionBps: 2000,
        })
      ).status,
    ).toBe(422);
    const ok = await creator.client.post('/v1/creator/affiliate/links', {
      productId: product.id,
      commissionBps: 800,
    });
    expect(ok.status).toBe(201);
    expect(
      (
        await creator.client.post('/v1/creator/affiliate/links', {
          productId: product.id,
          commissionBps: 800,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await seller.client.post('/v1/creator/affiliate/links', {
          productId: product.id,
          commissionBps: 100,
        })
      ).status,
    ).toBe(403); // not a creator
    const own = await mkCreator();
    const ownProduct = await mkProduct(own);
    await own.client.put(`/v1/products/${ownProduct.id}/affiliate`, { maxBps: 1000 });
    expect(
      (
        await own.client.post('/v1/creator/affiliate/links', {
          productId: ownProduct.id,
          commissionBps: 100,
        })
      ).status,
    ).toBe(422);
    expect(await auditN('affiliate.link_created', ok.body.id)).toBe(1);
  });

  it('counts a human click once per day, and records bots and self clicks without counting them', async () => {
    const seller = await signup(t);
    const creator = await mkCreator();
    const product = await mkProduct(seller);
    await seller.client.put(`/v1/products/${product.id}/affiliate`, { maxBps: 1000 });
    const link = (
      await creator.client.post('/v1/creator/affiliate/links', {
        productId: product.id,
        commissionBps: 1000,
      })
    ).body;
    const visitor = await signup(t);
    const first = await click(visitor, link.code);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ productId: product.id, counted: true });
    expect((await click(visitor, link.code)).body.counted).toBe(false); // same visitor, same day
    expect(
      (await click(null, link.code, 'Googlebot/2.1 (+http://www.google.com/bot.html)')).body
        .counted,
    ).toBe(false);
    expect((await click(null, link.code, 'curl/8.0')).body.counted).toBe(false);
    expect((await click(creator, link.code)).body.counted).toBe(false); // self
    expect((await click(null, 'doesnotexist1')).status).toBe(404);
    const stats = (await creator.client.get('/v1/creator/affiliate/links')).body.items[0];
    expect(stats.clicks.counted).toBe(1);
    expect(stats.clicks.rawHits).toBeGreaterThanOrEqual(5);
    expect(stats.clicks.rejected).toBeGreaterThanOrEqual(2);
    // No address is stored: only a keyed hash.
    const stored = (
      await sql('SELECT visitor_hash FROM affiliate_clicks WHERE link_id = $1', [link.id])
    ).rows.map((r) => r.visitor_hash as string);
    expect(stored.every((h) => /^[0-9a-f]{32}$/.test(h))).toBe(true);
    await creator.client.patch(`/v1/creator/affiliate/links/${link.id}`, { active: false });
    expect((await click(visitor, link.code)).status).toBe(404);
  });

  it('attributes paid orders read-only (last counted click wins), once, and settles the commission through the ledger', async () => {
    const seller = await signup(t);
    const c1 = await mkCreator();
    const c2 = await mkCreator();
    const product = await mkProduct(seller, { priceCents: 5000, stock: 20 });
    await seller.client.put(`/v1/products/${product.id}/affiliate`, { maxBps: 2000 });
    const l1 = (
      await c1.client.post('/v1/creator/affiliate/links', {
        productId: product.id,
        commissionBps: 1000,
      })
    ).body;
    const l2 = (
      await c2.client.post('/v1/creator/affiliate/links', {
        productId: product.id,
        commissionBps: 500,
      })
    ).body;
    const buyer = await signup(t);
    const noClick = await signup(t);
    await click(buyer, l1.code);
    await sql(`UPDATE affiliate_clicks SET day = day - 2 WHERE link_id = $1`, [l1.id]);
    await click(buyer, l2.code); // the later click wins
    const ordersBefore = await n('SELECT count(*)::int AS n FROM orders');
    const { orderId } = await buy(buyer, [{ productId: product.id, quantity: 2 }]);
    await buy(noClick, [{ productId: product.id, quantity: 1 }]);
    const own = await buy(c2, [{ productId: product.id, quantity: 1 }]); // creator buying through their own link never earns
    void own;
    await click(c2, l2.code);
    expect(await n('SELECT count(*)::int AS n FROM orders')).toBe(ordersBefore + 3);

    const orderSnapshot = JSON.stringify(
      (await sql('SELECT * FROM orders WHERE id = $1', [orderId])).rows[0],
    );
    expect(await attributeConversions(t.ctx)).toBe(1);
    expect(await attributeConversions(t.ctx)).toBe(0); // exactly once
    expect(
      JSON.stringify((await sql('SELECT * FROM orders WHERE id = $1', [orderId])).rows[0]),
    ).toBe(orderSnapshot); // orders are only read
    const conv = (await sql('SELECT * FROM affiliate_conversions')).rows.find(
      (r) => r.order_id === orderId,
    )!;
    expect(conv.creator_id).toBe(c2.id);
    expect(Number(conv.commission_cents)).toBe(500); // 5% of 2 x 50.00
    expect(
      await n('SELECT count(*)::int AS n FROM affiliate_conversions WHERE creator_id = $1', [
        c1.id,
      ]),
    ).toBe(0);

    const before = await balanceOf(t, sellerAccount(c2.id));
    const res = await settleConversions(t.ctx);
    expect(res.settled).toBe(1);
    expect((await settleConversions(t.ctx)).settled).toBe(0);
    expect(await balanceOf(t, sellerAccount(c2.id))).toBe(before + 500);
    expect(
      (await ledgerOf(t, 'fee', 'affiliate_conversion', conv.id))
        .map((l) => `${l.direction}:${l.amount}`)
        .sort(),
    ).toEqual(['credit:500', 'debit:500']);
    expect(await unbalancedTransactions(t)).toEqual([]);
    const list = await c2.client.get('/v1/creator/affiliate/conversions');
    expect(list.body.items[0]).toMatchObject({ status: 'settled', commissionCents: 500 });
    expect((await c1.client.get('/v1/creator/affiliate/conversions')).body.items).toHaveLength(0);
  });

  it('a refunded order reverses a pending conversion instead of paying commission', async () => {
    const seller = await signup(t);
    const c = await mkCreator();
    const product = await mkProduct(seller, { priceCents: 4000 });
    await seller.client.put(`/v1/products/${product.id}/affiliate`, { maxBps: 1000 });
    const l = (
      await c.client.post('/v1/creator/affiliate/links', {
        productId: product.id,
        commissionBps: 1000,
      })
    ).body;
    const buyer = await signup(t);
    await click(buyer, l.code);
    const { orderId } = await buy(buyer, [{ productId: product.id, quantity: 1 }]);
    await attributeConversions(t.ctx, { creatorId: c.id });
    await sql(`UPDATE orders SET status = 'refunded' WHERE id = $1`, [orderId]);
    const r = await settleConversions(t.ctx, { creatorId: c.id });
    expect(r).toMatchObject({ settled: 0, reversed: 1 });
    expect(
      (await sql('SELECT status FROM affiliate_conversions WHERE creator_id = $1', [c.id])).rows[0]
        .status,
    ).toBe('reversed');
  });
});

// ================================================================== brand partnerships
describe('brand partnerships', () => {
  async function mkDeal() {
    const creator = await mkCreator({ verify: true });
    const owner = await signup(t);
    const biz = (
      await owner.client.post('/v1/businesses', { name: `Brand ${uniq('b')}`, category: 'retail' })
    ).body;
    const proposed = await owner.client.post(`/v1/businesses/${biz.id}/partnerships`, {
      creatorId: creator.id,
      title: 'Summer campaign',
      brief: 'Two posts about our shoes',
      amountCents: 20000,
      currency: 'USD',
      deliverables: [{ title: 'Launch post', kind: 'post' }],
    });
    if (proposed.status !== 201)
      throw new Error(`proposal failed ${proposed.status} ${JSON.stringify(proposed.body)}`);
    return { creator, owner, biz, deal: proposed.body };
  }

  it('walks proposal -> negotiation -> accepted -> deliverables -> paid with disclosure enforced', async () => {
    const { creator, owner, biz, deal } = await mkDeal();
    const id = deal.id;
    expect(deal).toMatchObject({
      status: 'proposed',
      yourSide: 'business',
      disclosureRequired: true,
    });
    const outsider = await signup(t);
    expect((await outsider.client.get(`/v1/partnerships/${id}`)).status).toBe(404);
    expect((await anon().get(`/v1/partnerships/${id}`)).status).toBe(401);
    expect((await creator.client.get(`/v1/partnerships/${id}`)).body.yourSide).toBe('creator');
    expect((await outsider.client.get(`/v1/businesses/${biz.id}/partnerships`)).status).toBe(404);
    expect(
      (await owner.client.get(`/v1/businesses/${biz.id}/partnerships`)).body.items,
    ).toHaveLength(1);

    // Turn taking: the proposer cannot accept their own terms; skipping steps is refused.
    expect((await owner.client.post(`/v1/partnerships/${id}/accept`, {})).status).toBe(409);
    expect((await creator.client.post(`/v1/partnerships/${id}/start`)).status).toBe(409);
    expect(
      (await owner.client.post(`/v1/partnerships/${id}/pay`, { paymentMethod: okToken() })).status,
    ).toBe(400); // Idempotency-Key
    expect(
      (
        await owner.client.request('POST', `/v1/partnerships/${id}/pay`, {
          headers: idem(),
          body: { paymentMethod: okToken() },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await creator.client.post(`/v1/partnerships/${id}/counter`, {
          amountCents: 25000,
          note: 'scope',
        })
      ).body,
    ).toMatchObject({ status: 'negotiating', amountCents: 25000, termsVersion: 2 });
    expect((await creator.client.post(`/v1/partnerships/${id}/accept`, {})).status).toBe(409); // creator wrote these terms
    expect(
      (await owner.client.post(`/v1/partnerships/${id}/accept`, { expectedVersion: 1 })).status,
    ).toBe(409); // stale terms
    const acc = await owner.client.post(`/v1/partnerships/${id}/accept`, { expectedVersion: 2 });
    expect(acc.body.status).toBe('accepted');
    expect((await owner.client.post(`/v1/partnerships/${id}/start`)).status).toBe(403); // creator starts the work
    expect((await creator.client.post(`/v1/partnerships/${id}/start`)).body.status).toBe(
      'in_progress',
    );

    // Sponsored posts: disclosure is mandatory and the partnership must belong to the creator.
    const noDisclosure = await creator.client.post('/v1/creator/posts', {
      body: 'Love these shoes',
      visibility: 'public',
      partnership: { id, disclosureConfirmed: false },
    });
    expect(noDisclosure.status).toBe(422);
    expect(
      (
        await (
          await mkCreator()
        ).client.post('/v1/creator/posts', {
          body: 'x',
          visibility: 'public',
          partnership: { id, disclosureConfirmed: true },
        })
      ).status,
    ).toBe(404);
    const plainPost = await creator.client.post('/v1/posts', { body: 'unlabelled promo' });
    const deliverableId = (await creator.client.get(`/v1/partnerships/${id}`)).body.deliverables[0]
      .id;
    const submitUrl = `/v1/partnerships/${id}/deliverables/${deliverableId}/submit`;
    expect((await creator.client.post(submitUrl, { postId: plainPost.body.id })).status).toBe(422); // unlabelled posts cannot be deliverables
    const sponsored = await creator.client.post('/v1/creator/posts', {
      body: 'Love these shoes',
      visibility: 'public',
      partnership: { id, disclosureConfirmed: true },
    });
    expect(sponsored.status).toBe(201);
    expect(sponsored.body.sponsored).toMatchObject({
      partnershipId: id,
      businessId: biz.id,
      label: 'Paid partnership',
    });
    expect((await anon().get(`/v1/posts/${sponsored.body.id}`)).body.sponsored.label).toBe(
      'Paid partnership',
    );
    expect((await owner.client.post(submitUrl, { postId: sponsored.body.id })).status).toBe(403);
    expect((await creator.client.post(submitUrl, { postId: sponsored.body.id })).status).toBe(200);

    // Review: rejection needs a reason; approval of the last deliverable makes it payable.
    const reviewUrl = `/v1/partnerships/${id}/deliverables/${deliverableId}/review`;
    expect((await creator.client.post(reviewUrl, { decision: 'approve' })).status).toBe(403);
    expect((await owner.client.post(reviewUrl, { decision: 'reject' })).status).toBe(400);
    expect(
      (
        await owner.client.post(reviewUrl, {
          decision: 'reject',
          note: 'Mention the discount code',
        })
      ).body.deliverables[0].status,
    ).toBe('rejected');
    expect((await creator.client.post(submitUrl, { postId: sponsored.body.id })).status).toBe(200);
    const approved = await owner.client.post(reviewUrl, { decision: 'approve' });
    expect(approved.body.status).toBe('delivered');

    // Payment: only the owner, idempotent, ledger-booked; the partnership becomes paid from the captured payment.
    const stranger = await signup(t);
    expect(
      (
        await stranger.client.request('POST', `/v1/partnerships/${id}/pay`, {
          headers: idem(),
          body: { paymentMethod: okToken() },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await creator.client.request('POST', `/v1/partnerships/${id}/pay`, {
          headers: idem(),
          body: { paymentMethod: okToken() },
        })
      ).status,
    ).toBe(404); // only the business side can even see the pay action
    const k = key();
    const tok = okToken();
    const pay = await owner.client.request('POST', `/v1/partnerships/${id}/pay`, {
      headers: idem(k),
      body: { paymentMethod: tok },
    });
    expect(pay.status).toBe(201);
    expect(pay.body.partnership.status).toBe('paid');
    const replay = await owner.client.request('POST', `/v1/partnerships/${id}/pay`, {
      headers: idem(k),
      body: { paymentMethod: tok },
    });
    expect(replay.status).toBe(200);
    expect(
      (
        await owner.client.request('POST', `/v1/partnerships/${id}/pay`, {
          headers: idem(),
          body: { paymentMethod: okToken() },
        })
      ).status,
    ).toBe(409); // already paid
    expect(
      await n(
        `SELECT count(*)::int AS n FROM payments WHERE purpose = 'partnership' AND metadata->>'partnershipId' = $1`,
        [id],
      ),
    ).toBe(1);
    const p = (
      await sql(
        `SELECT p.id, p.amount_cents, p.platform_fee_cents FROM payments p WHERE purpose = 'partnership' AND metadata->>'partnershipId' = $1`,
        [id],
      )
    ).rows[0];
    expect(Number(p.amount_cents)).toBe(25000);
    expect(
      (await ledgerOf(t, 'payment_captured', 'payment', p.id)).find(
        (l) => l.account === sellerAccount(creator.id),
      )?.amount,
    ).toBe(25000 - Number(p.platform_fee_cents));
    expect(await settlePartnershipPayments(t.ctx)).toBe(0);
    expect((await creator.client.post(`/v1/partnerships/${id}/cancel`, {})).status).toBe(409); // terminal
    const events = (await creator.client.get(`/v1/partnerships/${id}`)).body.events.map(
      (e: any) => e.event,
    );
    expect(events).toEqual(
      expect.arrayContaining([
        'countered',
        'accept',
        'start',
        'deliverable_submitted',
        'deliverable_rejected',
        'deliverable_approved',
        'pay',
      ]),
    );
    expect(await auditN('partnership.pay', id)).toBe(1);
    expect(await unbalancedTransactions(t)).toEqual([]);
  });

  it('a declined card leaves the partnership payable; decline and cancel end it', async () => {
    const { creator, owner, deal } = await mkDeal();
    const id = deal.id;
    await creator.client.post(`/v1/partnerships/${id}/accept`, {});
    await creator.client.post(`/v1/partnerships/${id}/start`);
    const dId = (await creator.client.get(`/v1/partnerships/${id}`)).body.deliverables[0].id;
    const post = await creator.client.post('/v1/creator/posts', {
      body: 'ad',
      visibility: 'public',
      partnership: { id, disclosureConfirmed: true },
    });
    await creator.client.post(`/v1/partnerships/${id}/deliverables/${dId}/submit`, {
      postId: post.body.id,
    });
    await owner.client.post(`/v1/partnerships/${id}/deliverables/${dId}/review`, {
      decision: 'approve',
    });
    const bad = await owner.client.request('POST', `/v1/partnerships/${id}/pay`, {
      headers: idem(),
      body: { paymentMethod: declineToken() },
    });
    expect(bad.status).toBe(402);
    expect((await creator.client.get(`/v1/partnerships/${id}`)).body.status).toBe('delivered');
    expect(
      (
        await owner.client.request('POST', `/v1/partnerships/${id}/pay`, {
          headers: idem(),
          body: { paymentMethod: okToken() },
        })
      ).body.partnership.status,
    ).toBe('paid');

    const second = await mkDeal();
    expect(
      (
        await second.creator.client.post(`/v1/partnerships/${second.deal.id}/decline`, {
          note: 'not for me',
        })
      ).body.status,
    ).toBe('declined');
    expect(
      (await second.creator.client.post(`/v1/partnerships/${second.deal.id}/accept`, {})).status,
    ).toBe(409);
    const third = await mkDeal();
    expect(
      (await third.owner.client.post(`/v1/partnerships/${third.deal.id}/cancel`, {})).body.status,
    ).toBe('cancelled');
  });

  it('creators can propose too; only team managers of the business act; minors and unverified sides are refused', async () => {
    const creator = await mkCreator();
    const owner = await signup(t);
    const biz = (
      await owner.client.post('/v1/businesses', { name: `Shop ${uniq('b')}`, category: 'retail' })
    ).body;
    const terms = {
      title: 'Collab',
      brief: 'A review',
      amountCents: 5000,
      currency: 'USD',
      deliverables: [{ title: 'Review', kind: 'video' }],
    };
    const r = await creator.client.post('/v1/creator/partnerships', {
      businessId: biz.id,
      ...terms,
    });
    expect(r.status).toBe(201);
    expect(r.body.yourSide).toBe('creator');
    expect((await owner.client.post(`/v1/partnerships/${r.body.id}/accept`, {})).body.status).toBe(
      'accepted',
    );
    const stranger = await signup(t);
    expect(
      (
        await stranger.client.post(`/v1/businesses/${biz.id}/partnerships`, {
          creatorId: creator.id,
          ...terms,
        })
      ).status,
    ).toBe(404);
    expect(
      (await stranger.client.post('/v1/creator/partnerships', { businessId: biz.id, ...terms }))
        .status,
    ).toBe(403);
    expect(
      (
        await owner.client.post(`/v1/businesses/${biz.id}/partnerships`, {
          creatorId: (await signup(t)).id,
          ...terms,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await owner.client.post(`/v1/businesses/${biz.id}/partnerships`, {
          creatorId: creator.id,
          ...terms,
          amountCents: 0,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await owner.client.post(`/v1/businesses/${biz.id}/partnerships`, {
          creatorId: creator.id,
          ...terms,
          deliverables: [],
        })
      ).status,
    ).toBe(400);
  });
});

// ================================================================== dashboard, revenue, payouts
describe('dashboard, revenue and payouts', () => {
  it('reports real numbers and withholds small country groups', async () => {
    const c = await mkCreator();
    const plan = await mkPlan(c, { priceCents: 1000 });
    const fans: TestUser[] = [];
    for (let i = 0; i < 3; i++) {
      const f = await signup(t);
      await follow(f, c);
      fans.push(f);
    }
    await sql(`UPDATE users SET country_code = 'DE' WHERE id = ANY($1::uuid[])`, [
      fans.map((f) => f.id),
    ]);
    const post = await c.client.post('/v1/posts', { body: 'dashboard post', visibility: 'public' });
    await sql(
      'UPDATE posts SET like_count = 4, comment_count = 2, view_count = 100 WHERE id = $1',
      [post.body.id],
    );
    await mkSub(fans[0]!, c, plan);
    await fans[1]!.client.request('POST', `/v1/creators/${c.id}/tips`, {
      headers: idem(),
      body: { amountCents: 500, currency: 'USD', paymentMethod: okToken() },
    });

    const stranger = await signup(t);
    expect((await stranger.client.get('/v1/creator/dashboard')).status).toBe(403);
    expect((await anon().get('/v1/creator/dashboard')).status).toBe(401);
    expect((await c.client.get('/v1/creator/dashboard', { days: '0' })).status).toBe(400);
    const d = (await c.client.get('/v1/creator/dashboard', { days: '7' })).body;
    expect(d.followers.total).toBe(3);
    expect(d.followers.gained).toBe(3);
    expect(d.content).toMatchObject({ posts: 1, likes: 4, comments: 2, views: 100 });
    expect(d.content.engagementRate).toBeCloseTo(0.06, 4);
    expect(d.content.topPosts[0].id).toBe(post.body.id);
    expect(d.subscribers.active).toBe(1);
    expect(d.subscribers.byTier).toEqual([expect.objectContaining({ tier: 1, active: 1 })]);
    expect(d.audience.countries).toEqual([]); // 3 followers < k: nobody is singled out
    expect(d.audience.minGroupSize).toBe(20);

    const rev = (await c.client.get('/v1/creator/revenue')).body;
    const sources = Object.fromEntries((rev.earnings as any[]).map((e) => [e.source, e]));
    expect(sources.subscription).toMatchObject({ payments: 1, grossCents: 1000 });
    expect(sources.tip).toMatchObject({ payments: 1, grossCents: 500 });
    expect(sources.tip.netCents).toBe(sources.tip.grossCents - sources.tip.platformFeeCents);
    expect((await stranger.client.get('/v1/creator/revenue')).status).toBe(403);
  });

  it('pays out the available balance once per Idempotency-Key, only after verification, never more than owed', async () => {
    const c = await mkCreator();
    const plan = await mkPlan(c, { priceCents: 2000 });
    const u = await signup(t);
    await mkSub(u, c, plan);
    const bal = (await c.client.get('/v1/creator/payouts/balance')).body;
    expect(bal.balances[0]).toMatchObject({ currency: 'USD' });
    const available = bal.balances[0].availableCents as number;
    expect(available).toBeGreaterThan(0);
    expect(bal.balances[0].totalCents).toBe(available);
    expect(bal.payoutAccount).toBeNull();

    const req = (k: string, body: Record<string, unknown> = { currency: 'USD' }) =>
      c.client.request('POST', '/v1/creator/payouts', { headers: idem(k), body });
    expect((await c.client.post('/v1/creator/payouts', { currency: 'USD' })).status).toBe(400);
    expect((await req(key())).status).toBe(409); // no payout account yet
    await verifyCreator(c);
    expect((await (await signup(t)).client.get('/v1/creator/payouts/balance')).status).toBe(403);
    expect(
      (await req(key(), { currency: 'USD', amountCents: available + 1 })).status,
    ).toBeGreaterThanOrEqual(400);
    const k = key();
    const p1 = await req(k);
    expect(p1.status).toBe(201);
    expect(p1.body.amountCents).toBe(available);
    const p2 = await req(k);
    expect(p2.status).toBe(200);
    expect(p2.body.id).toBe(p1.body.id);
    expect((await req(key())).status).toBeGreaterThanOrEqual(400); // nothing left
    expect(
      (await c.client.get('/v1/creator/payouts/balance')).body.balances[0].availableCents,
    ).toBe(0);
    expect((await c.client.get('/v1/creator/payouts')).body.items).toHaveLength(1);
    expect(await unbalancedTransactions(t)).toEqual([]);
    const rev = (await c.client.get('/v1/creator/revenue')).body;
    expect(rev.deductions).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'payout', amountCents: available })]),
    );
  });
});

// ================================================================== maintenance & deletion
describe('maintenance and account deletion', () => {
  it('staff can run a maintenance pass; others cannot', async () => {
    expect((await (await signup(t)).client.post('/v1/staff/creator/maintenance')).status).toBe(403);
    const r = await admin.client.post('/v1/staff/creator/maintenance');
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('renewals');
    const direct = await runCreatorMaintenance(t.ctx);
    expect(direct.renewals.charged).toBe(0);
  });

  it('deleting an account ends its subscriptions and forgets stored payment methods', async () => {
    const c = await mkCreator();
    const plan = await mkPlan(c);
    const u = await signup(t);
    const sub = await mkSub(u, c, plan);
    const { getDeletionHooks } = await import('../src/lib/hooks.js');
    const client = await t.ctx.db.connect();
    try {
      for (const h of getDeletionHooks()) await h(t.ctx, client, u.id);
    } finally {
      client.release();
    }
    expect(await subRow(sub.id)).toMatchObject({
      status: 'cancelled',
      end_reason: 'account_deleted',
      payment_method_enc: null,
    });
  });

  it('exports contain creator data but never payment tokens', async () => {
    const c = await mkCreator();
    const plan = await mkPlan(c);
    const u = await signup(t);
    const tok = okToken();
    await mkSub(u, c, plan, tok);
    const { getExportSections } = await import('../src/modules/privacy/registry.js');
    const section = getExportSections().find((s) => s.key === 'creator_economy')!;
    const data = await section.collect(t.ctx, t.ctx.db as never, u.id);
    expect(JSON.stringify(data)).not.toContain(tok);
    expect(JSON.stringify(data)).not.toContain('payment_method_enc');
    expect((data as any).subscriptions).toHaveLength(1);
  });
});
