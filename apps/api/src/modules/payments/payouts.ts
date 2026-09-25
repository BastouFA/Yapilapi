import { withTransaction, type Queryable } from '@yapilapi/database';
import { AppError, conflict, forbidden, invalid, notFound } from '@yapilapi/shared';
import {
  PaymentProviderError,
  payoutEntries,
  payoutReversalEntries,
  type KycStatus,
  type NormalisedEvent,
} from '@yapilapi/payments';
import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../../lib/context.js';
import { audit } from '../../lib/audit.js';
import { requireSellerAccess } from '../commerce/access.js';
import { payeeBalances, payeeKey, postLedger, type Payee } from './ledger.js';
import { notifySeller } from './notify.js';
import { getPaymentProvider } from './provider.js';
import { deliverLocalWebhooks } from './webhook.js';

export interface PayoutAccountRow {
  id: string;
  owner_user_id: string | null;
  owner_business_id: string | null;
  provider: string;
  account_ref: string;
  kyc_status: KycStatus;
  country: string;
  status: string;
  verified_at: Date | null;
  created_at: Date;
}
const ACCOUNT_COLS =
  'id, owner_user_id, owner_business_id, provider, account_ref, kyc_status, country, status, verified_at, created_at';

export const accountView = (a: PayoutAccountRow, extra: Record<string, unknown> = {}) => ({
  id: a.id,
  owner: a.owner_business_id
    ? { type: 'business', id: a.owner_business_id }
    : { type: 'user', id: a.owner_user_id },
  provider: a.provider,
  kycStatus: a.kyc_status,
  payoutsEnabled: a.kyc_status === 'verified' && a.status === 'active',
  status: a.status,
  country: a.country,
  verifiedAt: a.verified_at?.toISOString() ?? null,
  createdAt: a.created_at.toISOString(),
  ...extra,
});

export interface PayoutRow {
  id: string;
  payee_user_id: string | null;
  payee_business_id: string | null;
  amount_cents: number;
  currency: string;
  status: 'pending' | 'verifying' | 'approved' | 'paid' | 'failed' | 'held';
  provider_ref: string | null;
  verification: Record<string, unknown>;
  idempotency_key: string;
  account_id: string | null;
  requested_by: string | null;
  failure_code: string | null;
  created_at: Date;
}
const PAYOUT_COLS =
  'id, payee_user_id, payee_business_id, amount_cents, currency, status, provider_ref, verification, idempotency_key, account_id, requested_by, failure_code, created_at';
export const payoutView = (p: PayoutRow) => ({
  id: p.id,
  payee: p.payee_business_id
    ? { type: 'business', id: p.payee_business_id }
    : { type: 'user', id: p.payee_user_id },
  amountCents: p.amount_cents,
  currency: p.currency,
  status: p.status,
  failureCode: p.failure_code,
  verification: p.verification,
  createdAt: p.created_at.toISOString(),
});

const payeeOf = (p: Pick<PayoutRow, 'payee_user_id' | 'payee_business_id'>): Payee =>
  p.payee_business_id
    ? { type: 'business', id: p.payee_business_id }
    : { type: 'user', id: p.payee_user_id! };

/** Resolve and authorise the payee: yourself, or a business you own. Minors cannot receive payouts. */
export async function resolvePayee(
  ctx: AppContext,
  actor: { userId: string; ageBand: 'teen' | 'adult' },
  businessId?: string,
): Promise<Payee> {
  if (actor.ageBand === 'teen')
    throw new AppError('unprocessable', 'Accounts under 18 cannot receive payouts');
  const payee: Payee = businessId
    ? { type: 'business', id: businessId }
    : { type: 'user', id: actor.userId };
  await requireSellerAccess(ctx.db, payee, actor.userId, 'money');
  return payee;
}

export async function findAccount(db: Queryable, payee: Payee): Promise<PayoutAccountRow | null> {
  const { rows } = await db.query<PayoutAccountRow>(
    `SELECT ${ACCOUNT_COLS} FROM payout_accounts WHERE ${payee.type === 'user' ? 'owner_user_id' : 'owner_business_id'} = $1 AND status <> 'closed'`,
    [payee.id],
  );
  return rows[0] ?? null;
}

/** Keep the creator profile (005 `creators`) in step with the payout account, when the user is a creator. */
async function mirrorCreator(
  db: Queryable,
  a: Pick<PayoutAccountRow, 'owner_user_id' | 'account_ref' | 'kyc_status'>,
): Promise<void> {
  if (!a.owner_user_id) return;
  await db.query(
    'UPDATE creators SET payout_account_ref = $2, kyc_status = $3 WHERE user_id = $1',
    [a.owner_user_id, a.account_ref, a.kyc_status],
  );
}

export async function createPayoutAccount(
  ctx: AppContext,
  actor: { userId: string; ageBand: 'teen' | 'adult' },
  input: {
    businessId?: string | undefined;
    country: string;
    email?: string | undefined;
    returnUrl?: string | undefined;
  },
  req?: FastifyRequest,
): Promise<{ account: PayoutAccountRow; onboardingUrl: string | null }> {
  const payee = await resolvePayee(ctx, actor, input.businessId);
  if (await findAccount(ctx.db, payee))
    throw conflict('A payout account already exists', { reason: 'payout_account_exists' });
  const provider = getPaymentProvider(ctx);
  let res;
  try {
    res = await provider.createConnectedAccount({
      ownerType: payee.type,
      ownerId: payee.id,
      country: input.country,
      email: input.email,
      returnUrl: input.returnUrl,
      idempotencyKey: `acct:${payee.type}:${payee.id}`,
    });
  } catch (err) {
    if (err instanceof PaymentProviderError)
      throw new AppError(
        'payment_failed',
        'The payment provider could not create the payout account',
        { code: err.code },
      );
    throw err;
  }
  const account = await withTransaction(ctx.db, async (tx) => {
    const { rows } = await tx.query<PayoutAccountRow>(
      `INSERT INTO payout_accounts (owner_user_id, owner_business_id, provider, account_ref, kyc_status, country, verified_at)
       VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $5 = 'verified' THEN now() END) RETURNING ${ACCOUNT_COLS}`,
      [
        payee.type === 'user' ? payee.id : null,
        payee.type === 'business' ? payee.id : null,
        provider.name,
        res.accountRef,
        res.kycStatus,
        input.country.toUpperCase(),
      ],
    );
    await mirrorCreator(tx, rows[0]!);
    await audit(
      ctx,
      {
        actorId: actor.userId,
        action: 'payout_account.created',
        targetType: 'payout_account',
        targetId: rows[0]!.id,
        metadata: { payeeType: payee.type, payeeId: payee.id, kycStatus: res.kycStatus },
      },
      req,
      tx,
    );
    return rows[0]!;
  });
  await deliverLocalWebhooks(ctx);
  return { account, onboardingUrl: res.onboardingUrl };
}

export async function setAccountKyc(
  db: Queryable,
  id: string,
  kyc: KycStatus,
): Promise<PayoutAccountRow | null> {
  const { rows } = await db.query<PayoutAccountRow>(
    `UPDATE payout_accounts SET kyc_status = $2, verified_at = CASE WHEN $2 = 'verified' THEN COALESCE(verified_at, now()) ELSE NULL END WHERE id = $1 RETURNING ${ACCOUNT_COLS}`,
    [id, kyc],
  );
  if (rows[0]) await mirrorCreator(db, rows[0]);
  return rows[0] ?? null;
}

/** Ask the provider for the account's current verification state (the webhook does the same asynchronously). */
export async function refreshPayoutAccount(
  ctx: AppContext,
  actor: { userId: string; ageBand: 'teen' | 'adult' },
  accountId: string,
  req?: FastifyRequest,
): Promise<PayoutAccountRow> {
  const { rows } = await ctx.db.query<PayoutAccountRow>(
    `SELECT ${ACCOUNT_COLS} FROM payout_accounts WHERE id = $1`,
    [accountId],
  );
  const a = rows[0];
  if (!a) throw notFound('Payout account');
  await requireSellerAccess(
    ctx.db,
    a.owner_business_id
      ? { type: 'business', id: a.owner_business_id }
      : { type: 'user', id: a.owner_user_id! },
    actor.userId,
    'money',
  );
  const remote = await getPaymentProvider(ctx).getConnectedAccount(a.account_ref);
  const updated = (await setAccountKyc(ctx.db, a.id, remote.kycStatus))!;
  if (updated.kyc_status !== a.kyc_status)
    await audit(
      ctx,
      {
        actorId: actor.userId,
        action: 'payout_account.kyc_changed',
        targetType: 'payout_account',
        targetId: a.id,
        metadata: { from: a.kyc_status, to: updated.kyc_status, source: 'provider' },
      },
      req,
    );
  return updated;
}

// ------------------------------------------------------------------ payouts
export interface PayoutRequest {
  businessId?: string | undefined;
  currency: string;
  amountCents?: number | undefined;
  key: string;
}

/**
 * Request a payout. Gates, in order: adult owner of the payee -> payout account exists and KYC is `verified` -> amount is positive and
 * within the AVAILABLE balance (ledger: matured payments net of refunds and earlier payouts, after the hold period). The balance check,
 * payout row and ledger debit happen under a per-payee advisory lock in ONE transaction, so parallel requests can never overdraw. The
 * provider transfer follows the commit with an idempotent request; failures are compensated by a ledger reversal.
 */
export async function requestPayout(
  ctx: AppContext,
  actor: { userId: string; ageBand: 'teen' | 'adult' },
  r: PayoutRequest,
  req?: FastifyRequest,
): Promise<{ payout: PayoutRow; replayed: boolean }> {
  const payee = await resolvePayee(ctx, actor, r.businessId);
  const idem = `${payeeKey(payee)}:${r.key}`;
  const acc = await findAccount(ctx.db, payee);
  if (!acc)
    throw new AppError('conflict', 'Set up a payout account first', {
      reason: 'payout_account_required',
    });
  if (acc.status !== 'active') throw forbidden('This payout account is not active');
  if (acc.kyc_status !== 'verified')
    throw new AppError(
      'forbidden',
      'Identity verification must be completed before you can be paid out',
      { reason: 'kyc_required', kycStatus: acc.kyc_status },
    );

  const out = await withTransaction(ctx.db, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `payout:${payeeKey(payee)}`,
    ]);
    const dup = await tx.query<PayoutRow>(
      `SELECT ${PAYOUT_COLS} FROM payouts WHERE idempotency_key = $1`,
      [idem],
    );
    if (dup.rows[0]) {
      const d = dup.rows[0];
      if (
        d.currency !== r.currency ||
        (r.amountCents !== undefined && d.amount_cents !== r.amountCents)
      )
        throw new AppError(
          'conflict',
          'This Idempotency-Key was already used with a different request',
          { reason: 'idempotency_key_reuse' },
        );
      return { payout: d, replayed: true };
    }
    const balances = await payeeBalances(tx, payee, ctx.config.PAYOUT_HOLD_DAYS);
    const bal = balances.find((b) => b.currency === r.currency);
    const available = bal?.available ?? 0;
    const amount = r.amountCents ?? available;
    if (!Number.isSafeInteger(amount) || amount < 1)
      throw new AppError('unprocessable', 'There is nothing available to pay out', {
        reason: 'nothing_available',
        availableCents: available,
        pendingCents: bal?.pending ?? 0,
      });
    if (amount > available)
      throw new AppError('unprocessable', 'The amount is more than your available balance', {
        reason: 'insufficient_available_balance',
        availableCents: available,
        pendingCents: bal?.pending ?? 0,
      });
    const ins = await tx.query<PayoutRow>(
      `INSERT INTO payouts (payee_user_id, payee_business_id, amount_cents, currency, status, idempotency_key, account_id, requested_by, verification, period_end)
       VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,$8, now()) RETURNING ${PAYOUT_COLS}`,
      [
        payee.type === 'user' ? payee.id : null,
        payee.type === 'business' ? payee.id : null,
        amount,
        r.currency,
        idem,
        acc.id,
        actor.userId,
        JSON.stringify({
          kycStatus: acc.kyc_status,
          holdDays: ctx.config.PAYOUT_HOLD_DAYS,
          availableBeforeCents: available,
          checkedAt: new Date().toISOString(),
        }),
      ],
    );
    const payout = ins.rows[0]!;
    await postLedger(tx, {
      kind: 'payout',
      refType: 'payout',
      refId: payout.id,
      currency: r.currency,
      entries: payoutEntries({ payee, amount }),
    });
    await audit(
      ctx,
      {
        actorId: actor.userId,
        action: 'payout.requested',
        targetType: 'payout',
        targetId: payout.id,
        metadata: {
          payeeType: payee.type,
          payeeId: payee.id,
          amountCents: amount,
          currency: r.currency,
        },
      },
      req,
      tx,
    );
    return { payout, replayed: false };
  });
  if (!out.replayed) await sendPayout(ctx, out.payout.id);
  const { rows } = await ctx.db.query<PayoutRow>(
    `SELECT ${PAYOUT_COLS} FROM payouts WHERE id = $1`,
    [out.payout.id],
  );
  return { payout: rows[0]!, replayed: out.replayed };
}

/** Provider transfer for a `pending`/`held` payout (idempotent per payout id). Used by the request path and staff retry. */
export async function sendPayout(ctx: AppContext, payoutId: string): Promise<void> {
  const { rows } = await ctx.db.query<PayoutRow & { account_ref: string | null }>(
    `SELECT p.id, p.payee_user_id, p.payee_business_id, p.amount_cents, p.currency, p.status, p.provider_ref, p.verification, p.idempotency_key, p.account_id, p.requested_by, p.failure_code, p.created_at,
            a.account_ref FROM payouts p LEFT JOIN payout_accounts a ON a.id = p.account_id WHERE p.id = $1`,
    [payoutId],
  );
  const p = rows[0];
  if (!p || !['pending', 'held'].includes(p.status) || !p.account_ref) return;
  try {
    const res = await getPaymentProvider(ctx).createPayout({
      accountRef: p.account_ref,
      amount: p.amount_cents,
      currency: p.currency,
      idempotencyKey: `payout:${p.id}`,
      metadata: { payoutId: p.id },
    });
    if (res.status === 'failed') await failPayout(ctx, p.id, res.failureCode ?? 'provider_failed');
    else
      await ctx.db.query(
        `UPDATE payouts SET provider_ref = $2, status = $3 WHERE id = $1 AND status IN ('pending','held')`,
        [p.id, res.ref, res.status === 'paid' ? 'paid' : 'pending'],
      );
    if (res.status === 'paid')
      await audit(ctx, {
        actorType: 'system',
        action: 'payout.paid',
        targetType: 'payout',
        targetId: p.id,
        metadata: { amountCents: p.amount_cents, currency: p.currency },
      });
  } catch (err) {
    if (err instanceof PaymentProviderError && !err.retryable) {
      await failPayout(ctx, p.id, err.code);
    } else {
      // Outcome unknown: keep the funds reserved and let staff retry (same idempotency key, so the provider cannot pay twice).
      await ctx.db.query(
        `UPDATE payouts SET status = 'held', failure_code = $2 WHERE id = $1 AND status IN ('pending','held')`,
        [p.id, ((err as Error).message ?? 'unknown').slice(0, 100)],
      );
      await audit(ctx, {
        actorType: 'system',
        action: 'payout.held',
        targetType: 'payout',
        targetId: p.id,
        metadata: { error: (err as Error).message.slice(0, 200) },
      });
    }
  }
  await deliverLocalWebhooks(ctx);
}

/** Mark a payout failed and put the money back on the seller's payable (append-only reversal, idempotent). */
export async function failPayout(
  ctx: AppContext,
  payoutId: string,
  code: string,
  db: Queryable = ctx.db,
): Promise<boolean> {
  const run = async (tx: Queryable) => {
    const { rows } = await tx.query<PayoutRow>(
      `SELECT ${PAYOUT_COLS} FROM payouts WHERE id = $1 FOR UPDATE`,
      [payoutId],
    );
    const p = rows[0];
    if (!p || p.status === 'failed') return null;
    await tx.query(`UPDATE payouts SET status = 'failed', failure_code = $2 WHERE id = $1`, [
      payoutId,
      code.slice(0, 100),
    ]);
    await postLedger(tx, {
      kind: 'adjustment',
      refType: 'payout_failed',
      refId: p.id,
      currency: p.currency,
      entries: payoutReversalEntries({ payee: payeeOf(p), amount: p.amount_cents }),
    });
    await audit(
      ctx,
      {
        actorType: 'system',
        action: 'payout.failed',
        targetType: 'payout',
        targetId: p.id,
        metadata: { code, amountCents: p.amount_cents, currency: p.currency },
      },
      undefined,
      tx,
    );
    return p;
  };
  const p = db === ctx.db ? await withTransaction(ctx.db, run) : await run(db);
  if (p)
    await notifySeller(ctx, payeeOf(p), {
      kind: 'payout_failed',
      targetType: 'payout',
      targetId: p.id,
      data: { amountCents: p.amount_cents, currency: p.currency, code },
    });
  return Boolean(p);
}

export async function listPayouts(db: Queryable, payee: Payee, limit = 50): Promise<PayoutRow[]> {
  const { rows } = await db.query<PayoutRow>(
    `SELECT ${PAYOUT_COLS} FROM payouts WHERE ${payee.type === 'user' ? 'payee_user_id' : 'payee_business_id'} = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
    [payee.id, limit],
  );
  return rows;
}

// ------------------------------------------------------------------ webhook handlers
export async function onPayoutEvent(
  ctx: AppContext,
  tx: Queryable,
  ev: NormalisedEvent,
): Promise<string | null> {
  const id = ev.metadata.payoutId;
  const { rows } = await tx.query<PayoutRow>(
    `SELECT ${PAYOUT_COLS} FROM payouts WHERE (provider_ref IS NOT NULL AND provider_ref = $1) OR ($2::uuid IS NOT NULL AND id = $2::uuid) FOR UPDATE`,
    [ev.providerRef, id && /^[0-9a-f-]{36}$/i.test(id) ? id : null],
  );
  const p = rows[0];
  if (!p) return 'unknown_payout';
  if (ev.type === 'payout.paid') {
    await tx.query(
      `UPDATE payouts SET status = 'paid', provider_ref = COALESCE(provider_ref, $2) WHERE id = $1 AND status IN ('pending','held')`,
      [p.id, ev.providerRef],
    );
    return null;
  }
  await failPayout(ctx, p.id, ev.failureCode ?? 'payout_failed', tx);
  return null;
}

export async function onAccountEvent(
  ctx: AppContext,
  tx: Queryable,
  provider: string,
  ev: NormalisedEvent,
): Promise<string | null> {
  if (!ev.providerRef || !ev.account) return 'malformed_account_event';
  const { rows } = await tx.query<PayoutAccountRow>(
    `SELECT ${ACCOUNT_COLS} FROM payout_accounts WHERE provider = $1 AND account_ref = $2 FOR UPDATE`,
    [provider, ev.providerRef],
  );
  const a = rows[0];
  if (!a) return 'unknown_account';
  if (a.kyc_status !== ev.account.kycStatus) {
    await setAccountKyc(tx, a.id, ev.account.kycStatus);
    await audit(
      ctx,
      {
        actorType: 'system',
        action: 'payout_account.kyc_changed',
        targetType: 'payout_account',
        targetId: a.id,
        metadata: { from: a.kyc_status, to: ev.account.kycStatus, source: 'webhook' },
      },
      undefined,
      tx,
    );
  }
  return null;
}

export { invalid };
