import type { FastifyInstance } from 'fastify';
import { tx } from '@yapilapi/database';
import { CURRENCIES, CURRENCY_SCALE, PAYOUT_MIN_CENTS, type Currency } from '@yapilapi/shared';
import { z } from 'zod';
import { badRequest, forbidden, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { earnings } from '../lib/earnings.ts';
import { failPayout, PAYOUT_SEND_JOB, payoutAccountFor, sendPayout } from '../lib/payouts.ts';
import { audit } from '../lib/services.ts';
import { assertAdultForMoney } from '../lib/users.ts';
import { me, requireAuth, requireRole } from '../plugins/auth.ts';

/**
 * Earnings and payouts. A creator sets up where their money goes (a Stripe account, or a bank or mobile money
 * account through Paystack), asks for a payout from what's available, an admin checks it, and the payout.send
 * job sends it. Webhooks say when it arrived or bounced (lib/payouts.ts, applyPayoutEvent).
 */
export default async function payoutsModule(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;
  const idParam = z.object({ id: z.string().uuid() });
  const currencyInput = z.string().length(3).toUpperCase().pipe(z.enum(CURRENCIES));
  const minPayout = (currency: Currency) => PAYOUT_MIN_CENTS * CURRENCY_SCALE[currency];
  const webOrigin = ctx.config.WEB_ORIGIN.split(',')[0]!.replace(/\/+$/, '');

  ctx.jobs[PAYOUT_SEND_JOB] = ({ payoutId }: { payoutId: string }) => sendPayout(db, ctx.paymentProviders, ctx.realtime, payoutId);

  /** What you earned from sales, subscriptions and tips, per currency, less fees and payouts. */
  app.get('/v1/me/earnings', { preHandler: requireAuth }, async (req) => {
    return { balances: await earnings(db, me(req).id) };
  });

  /** Your payout requests and where each one is. */
  app.get('/v1/me/payouts', { preHandler: requireAuth }, async (req) => {
    const { rows } = await db.query(
      `SELECT id, amount_cents, currency, status, failure_reason, created_at, paid_at FROM payouts WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [me(req).id],
    );
    return {
      items: rows.map((r) => ({
        id: r.id as string,
        amountCents: r.amount_cents as number,
        currency: String(r.currency).trim(),
        status: r.status as 'pending' | 'verified' | 'processing' | 'paid' | 'failed',
        failureReason: (r.failure_reason as string | null) ?? null,
        createdAt: r.created_at,
        paidAt: r.paid_at ?? null,
      })),
    };
  });

  /**
   * Where your payouts go, per currency: the provider, how you set it up there (on its own pages, or with a bank
   * here), whether it's ready, and which account. A hosted account still being set up is checked again here, so
   * coming back from the provider's pages shows it ready.
   */
  app.get('/v1/me/payout-accounts', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const checked = new Map<string, boolean>();
    const items = [];
    for (const currency of CURRENCIES) {
      const { provider, rail, account } = await payoutAccountFor(db, ctx.paymentProviders, u.id, currency);
      let ready = account?.ready ?? false;
      if (account && !ready && rail?.kind === 'hosted' && rail.accountReady) {
        if (!checked.has(account.account_ref)) {
          const now = await rail.accountReady(account.account_ref).catch(() => false);
          checked.set(account.account_ref, now);
          if (now) await db.query(`UPDATE payout_accounts SET ready = true, updated_at = now() WHERE id = $1`, [account.id]);
        }
        ready = checked.get(account.account_ref)!;
      }
      items.push({ currency, provider, kind: rail?.kind ?? null, ready, label: account?.label ?? null, minCents: minPayout(currency) });
    }
    return { items };
  });

  async function assertCanBePaid(u: ReturnType<typeof me>) {
    if (!u.emailVerified) throw forbidden('Verify your email before setting up payouts.');
    await assertAdultForMoney(db, u.id);
  }

  /** Start (or finish) setting up a hosted payout account: the provider's page to give it your bank details. */
  app.post('/v1/me/payout-accounts/onboard', { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req) => {
    const u = me(req);
    const input = parse(
      z.object({
        currency: currencyInput,
        country: z
          .string()
          .regex(/^[A-Za-z]{2}$/)
          .optional(),
      }),
      req.body,
    );
    await assertCanBePaid(u);
    const { provider, rail, account } = await payoutAccountFor(db, ctx.paymentProviders, u.id, input.currency);
    if (rail?.kind !== 'hosted' || !rail.onboard) throw badRequest('Payouts in this currency are set up with a bank account.');
    const profile = (await db.query(`SELECT p.country, u.email FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.id = $1`, [u.id])).rows[0];
    const country = (input.country ?? profile?.country ?? 'US').toUpperCase();
    const { accountRef, url } = await rail.onboard({
      accountRef: account?.account_ref,
      email: profile.email,
      country,
      userId: u.id,
      returnUrl: `${webOrigin}/studio?payouts=1`,
    });
    if (!account) await db.query(`INSERT INTO payout_accounts (user_id, provider, currency, account_ref) VALUES ($1,$2,NULL,$3)`, [u.id, provider, accountRef]);
    await audit(db, { actorId: u.id, action: 'payout_account.onboard', entityType: 'user', entityId: u.id, metadata: { provider } });
    return { url };
  });

  /** The banks (and mobile money) that take payouts in a currency, for the bank account form. */
  app.get('/v1/payout-banks', { preHandler: requireAuth }, async (req) => {
    const { currency } = parse(z.object({ currency: currencyInput }), req.query);
    const rail = ctx.paymentProviders.forCurrency(currency).payouts;
    if (rail?.kind !== 'bank' || !rail.banks) return { items: [] };
    return { items: await rail.banks(currency) };
  });

  /** Where payouts in a currency go when they're paid to a bank: kept by the provider; here only the bank and the last four digits. */
  app.post('/v1/me/payout-accounts/bank', { preHandler: requireAuth, config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    const input = parse(
      z.object({
        currency: currencyInput,
        bankCode: z.string().trim().min(1).max(40),
        accountNumber: z
          .string()
          .trim()
          .regex(/^[0-9]{6,20}$/),
        accountName: z.string().trim().min(2).max(100),
      }),
      req.body,
    );
    await assertCanBePaid(u);
    const { provider, rail, account } = await payoutAccountFor(db, ctx.paymentProviders, u.id, input.currency);
    if (rail?.kind !== 'bank' || !rail.banks || !rail.addRecipient) throw badRequest('Payouts in this currency are set up on the payment provider’s page.');
    const bank = (await rail.banks(input.currency)).find((b) => b.code === input.bankCode);
    if (!bank) throw badRequest('Pick a bank from the list.');
    const added = await rail
      .addRecipient({ currency: input.currency, bankCode: bank.code, bankType: bank.type, accountNumber: input.accountNumber, name: input.accountName })
      .catch(() => {
        throw badRequest('The bank could not confirm that account. Check the number and try again.');
      });
    if (account)
      await db.query(`UPDATE payout_accounts SET account_ref = $2, label = $3, ready = true, updated_at = now() WHERE id = $1`, [
        account.id,
        added.accountRef,
        added.label,
      ]);
    else
      await db.query(`INSERT INTO payout_accounts (user_id, provider, currency, account_ref, label, ready) VALUES ($1,$2,$3,$4,$5,true)`, [
        u.id,
        provider,
        input.currency,
        added.accountRef,
        added.label,
      ]);
    await audit(db, { actorId: u.id, action: 'payout_account.bank', entityType: 'user', entityId: u.id, metadata: { provider, currency: input.currency } });
    reply.code(201);
    return { account: { currency: input.currency, provider, kind: 'bank', ready: true, label: added.label } };
  });

  /** Ask for a payout of what's available, to the account set up for its currency. */
  app.post('/v1/me/payouts', { preHandler: requireAuth }, async (req, reply) => {
    const u = me(req);
    const input = parse(z.object({ amountCents: z.number().int().positive(), currency: currencyInput }), req.body);
    if (!u.emailVerified) throw forbidden('Verify your email before requesting a payout.');
    await assertAdultForMoney(db, u.id);
    const min = minPayout(input.currency);
    if (input.amountCents < min) throw badRequest(`The smallest payout is ${min} hundredths of ${input.currency}.`);
    const { account } = await payoutAccountFor(db, ctx.paymentProviders, u.id, input.currency);
    if (!account?.ready) throw badRequest('Set up where your payouts go before asking for one.');
    const payout = await tx(db, async (c) => {
      // One request at a time per person, so two at once can't both spend the same balance.
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('payout:' || $1))`, [u.id]);
      const available = (await earnings(c, u.id)).find((b) => b.currency === input.currency)?.availableCents ?? 0;
      if (input.amountCents > available) throw badRequest('That is more than you have available to pay out.', { availableCents: Math.max(0, available) });
      return (
        await c.query(`INSERT INTO payouts (user_id, amount_cents, currency) VALUES ($1,$2,$3) RETURNING id, status`, [u.id, input.amountCents, input.currency])
      ).rows[0];
    });
    await audit(db, { actorId: u.id, action: 'payout.request', entityType: 'payout', entityId: payout.id, metadata: input });
    reply.code(201);
    return { payout, message: 'Payout requested. It will be paid after verification.' };
  });

  /**
   * Payouts for the team, waiting ones first: who, how much, what they still have in that currency with their
   * pending payouts taken off (below zero: refunds since have left it uncovered), and where it would go.
   */
  app.get('/v1/admin/payouts', { preHandler: requireRole('admin') }, async (req) => {
    const { status } = parse(z.object({ status: z.enum(['pending', 'verified', 'processing', 'paid', 'failed']).default('pending') }), req.query);
    const { rows } = await db.query(
      `SELECT po.id, po.user_id, pr.username, po.amount_cents, po.currency, po.status, po.failure_reason, po.created_at, po.paid_at
       FROM payouts po LEFT JOIN profiles pr ON pr.user_id = po.user_id
       WHERE po.status = $1 ORDER BY po.created_at ${status === 'pending' ? 'ASC' : 'DESC'} LIMIT 100`,
      [status],
    );
    const balances = new Map<string, Awaited<ReturnType<typeof earnings>>>();
    const items = [];
    for (const r of rows) {
      if (!balances.has(r.user_id)) balances.set(r.user_id, await earnings(db, r.user_id));
      const currency = String(r.currency).trim();
      const { account } = await payoutAccountFor(db, ctx.paymentProviders, r.user_id, currency);
      items.push({
        ...r,
        currency,
        available_cents: balances.get(r.user_id)!.find((b) => b.currency === currency)?.availableCents ?? 0,
        account_ready: !!account?.ready,
        account_label: account?.label ?? null,
      });
    }
    return { items };
  });

  /** Approve a payout: it's checked once more against what's left, and sent. */
  app.post('/v1/admin/payouts/:id/verify', { preHandler: requireRole('admin') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const payout = (await db.query(`SELECT user_id, currency FROM payouts WHERE id = $1 AND status = 'pending'`, [id])).rows[0];
    if (!payout) throw notFound('Payout');
    // Payouts only go to adults, whatever was requested before the rule.
    await assertAdultForMoney(db, payout.user_id, false);
    const { account } = await payoutAccountFor(db, ctx.paymentProviders, payout.user_id, String(payout.currency).trim());
    if (!account?.ready) throw badRequest('This person has no payout account ready for that currency.');
    await tx(db, async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('payout:' || $1))`, [payout.user_id]);
      const p = (await c.query(`SELECT currency FROM payouts WHERE id = $1 AND status = 'pending' FOR UPDATE`, [id])).rows[0];
      if (!p) throw notFound('Payout');
      // Refunds since the request can leave less than was asked for (pending payouts already count as spent).
      const available = (await earnings(c, payout.user_id)).find((b) => b.currency === p.currency)?.availableCents ?? 0;
      if (available < 0) throw badRequest('Refunds since this request leave the person without enough earnings to cover it.');
      await c.query(`UPDATE payouts SET status = 'verified', decided_at = now() WHERE id = $1`, [id]);
      // Sent by the job worker, with retries; in the same transaction, so an approved payout is never left unsent.
      await c.query(`INSERT INTO jobs (kind, payload) VALUES ($1, $2)`, [PAYOUT_SEND_JOB, { payoutId: id }]);
    });
    await audit(db, { actorId: me(req).id, action: 'payout.verify', entityType: 'payout', entityId: id });
    return { status: 'verified' };
  });

  /** Turn a payout down, with the reason the creator sees; the money stays in their balance. */
  app.post('/v1/admin/payouts/:id/reject', { preHandler: requireRole('admin') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(300) }), req.body);
    const r = await db.query(`UPDATE payouts SET decided_at = now() WHERE id = $1 AND status = 'pending' RETURNING id`, [id]);
    if (!r.rowCount) throw notFound('Payout');
    await failPayout(db, ctx.realtime, id, reason);
    await audit(db, { actorId: me(req).id, action: 'payout.reject', entityType: 'payout', entityId: id, metadata: { reason } });
    return { status: 'failed' };
  });
}
