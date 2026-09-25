import type { FastifyRequest } from 'fastify';
import { withTransaction, type Queryable } from '@yapilapi/database';
import { DevPaymentProvider } from '@yapilapi/payments';
import { AppError, conflict, forbidden, notFound } from '@yapilapi/shared';
import type { AppContext } from '../../lib/context.js';
import type { AuthContext } from '../../lib/auth-context.js';
import { audit } from '../../lib/audit.js';
import { notify } from '../../lib/notify.js';
import { createPayoutAccount, findAccount, setAccountKyc } from '../payments/payouts.js';
import { getPaymentProvider } from '../payments/provider.js';
import { deliverLocalWebhooks } from '../payments/webhook.js';
import { nextKycStatus, type KycStatus } from './rules.js';

/** Bump when the creator terms change: creators must re-accept before new monetisation actions (enforced by `terms_version` comparison). */
export const CREATOR_TERMS_VERSION = '2027-01';

export interface CreatorRow {
  user_id: string;
  status: 'active' | 'suspended' | 'closed';
  kyc_status: KycStatus;
  category: string | null;
  terms_accepted_at: Date | null;
  terms_version: string | null;
  kyc_submitted_at: Date | null;
  kyc_decided_at: Date | null;
  kyc_note: string | null;
  created_at: Date;
}
const COLS =
  'c.user_id, c.status, c.kyc_status, c.category, c.terms_accepted_at, c.terms_version, c.kyc_submitted_at, c.kyc_decided_at, c.kyc_note, c.created_at';

export async function loadCreator(db: Queryable, userId: string): Promise<CreatorRow | null> {
  const { rows } = await db.query<CreatorRow>(
    `SELECT ${COLS} FROM creators c WHERE c.user_id = $1`,
    [userId],
  );
  return rows[0] ?? null;
}

export async function requireCreator(
  db: Queryable,
  userId: string,
  opts: { active?: boolean } = {},
): Promise<CreatorRow> {
  const c = await loadCreator(db, userId);
  if (!c) throw new AppError('forbidden', 'Become a creator first', { reason: 'not_a_creator' });
  if (opts.active !== false && c.status !== 'active')
    throw new AppError('forbidden', `Your creator account is ${c.status}`, {
      reason: 'creator_not_active',
      status: c.status,
    });
  if (opts.active !== false && (!c.terms_accepted_at || c.terms_version !== CREATOR_TERMS_VERSION))
    throw new AppError('forbidden', 'Accept the current creator terms first', {
      reason: 'terms_outdated',
      termsVersion: CREATOR_TERMS_VERSION,
    });
  return c;
}

export const creatorView = (c: CreatorRow, mode: string | null = null) => ({
  userId: c.user_id,
  status: c.status,
  kycStatus: c.kyc_status,
  category: c.category,
  termsVersion: c.terms_version,
  currentTermsVersion: CREATOR_TERMS_VERSION,
  termsAccepted: Boolean(c.terms_accepted_at) && c.terms_version === CREATOR_TERMS_VERSION,
  kycSubmittedAt: c.kyc_submitted_at?.toISOString() ?? null,
  kycDecidedAt: c.kyc_decided_at?.toISOString() ?? null,
  kycNote: c.kyc_status === 'rejected' ? c.kyc_note : null,
  mode,
  createdAt: c.created_at.toISOString(),
});

/**
 * Become a creator: adults only (minors cannot monetise), explicit acceptance of the CURRENT terms, profile mode switches to `creator`
 * (the previous mode is remembered). Idempotent; a `closed` creator can re-open by accepting the terms again, a `suspended` one cannot (staff decide).
 */
export async function becomeCreator(
  ctx: AppContext,
  auth: AuthContext,
  input: { termsVersion: string; category?: string | undefined },
  req?: FastifyRequest,
): Promise<{ creator: CreatorRow; created: boolean }> {
  if (auth.ageBand === 'teen')
    throw forbidden('Accounts under 18 cannot join the creator programme');
  if (input.termsVersion !== CREATOR_TERMS_VERSION)
    throw new AppError('unprocessable', 'Those are not the current creator terms', {
      reason: 'terms_outdated',
      termsVersion: CREATOR_TERMS_VERSION,
    });
  return withTransaction(ctx.db, async (tx) => {
    const cur = (
      await tx.query<CreatorRow>(`SELECT ${COLS} FROM creators c WHERE c.user_id = $1 FOR UPDATE`, [
        auth.userId,
      ])
    ).rows[0];
    if (cur?.status === 'suspended')
      throw new AppError('forbidden', 'Your creator account is suspended', {
        reason: 'creator_not_active',
        status: 'suspended',
      });
    const mode =
      (
        await tx.query<{ mode: string }>(
          'SELECT mode FROM profiles WHERE user_id = $1 FOR UPDATE',
          [auth.userId],
        )
      ).rows[0]?.mode ?? 'personal';
    let created = false;
    if (!cur) {
      await tx.query(
        `INSERT INTO creators (user_id, status, terms_accepted_at, terms_version, category, previous_mode) VALUES ($1,'active', now(), $2, $3, $4)`,
        [
          auth.userId,
          CREATOR_TERMS_VERSION,
          input.category ?? null,
          mode === 'creator' ? null : mode,
        ],
      );
      created = true;
    } else {
      await tx.query(
        `UPDATE creators SET status = 'active', terms_accepted_at = now(), terms_version = $2, category = COALESCE($3, category),
                previous_mode = COALESCE(previous_mode, CASE WHEN $4 = 'creator' THEN NULL ELSE $4 END) WHERE user_id = $1`,
        [auth.userId, CREATOR_TERMS_VERSION, input.category ?? null, mode],
      );
    }
    await tx.query(`UPDATE profiles SET mode = 'creator' WHERE user_id = $1`, [auth.userId]);
    await audit(
      ctx,
      {
        actorId: auth.userId,
        action: created ? 'creator.joined' : 'creator.terms_accepted',
        targetType: 'creator',
        targetId: auth.userId,
        metadata: { termsVersion: CREATOR_TERMS_VERSION, category: input.category ?? null },
      },
      req,
      tx,
    );
    return {
      creator: (
        await tx.query<CreatorRow>(`SELECT ${COLS} FROM creators c WHERE c.user_id = $1`, [
          auth.userId,
        ])
      ).rows[0]!,
      created,
    };
  });
}

/** Switch the profile mode. Going back to `personal` keeps the creator account (subscriptions, balances) intact: it only changes how the profile is presented. */
export async function switchProfileMode(
  ctx: AppContext,
  auth: AuthContext,
  mode: 'creator' | 'personal',
  req?: FastifyRequest,
): Promise<{ mode: string }> {
  if (mode === 'creator') await requireCreator(ctx.db, auth.userId, { active: false });
  const cur = await loadCreator(ctx.db, auth.userId);
  if (mode === 'creator' && cur?.status !== 'active')
    throw new AppError('forbidden', `Your creator account is ${cur?.status ?? 'missing'}`, {
      reason: 'creator_not_active',
    });
  const r = await ctx.db.query<{ mode: string }>(
    'UPDATE profiles SET mode = $2 WHERE user_id = $1 AND mode <> $2 RETURNING mode',
    [auth.userId, mode],
  );
  if (r.rows[0])
    await audit(
      ctx,
      {
        actorId: auth.userId,
        action: 'creator.mode_switched',
        targetType: 'profile',
        targetId: auth.userId,
        metadata: { to: mode },
      },
      req,
    );
  return { mode };
}

async function kycEvent(
  db: Queryable,
  creatorId: string,
  from: string,
  to: string,
  actorType: 'creator' | 'staff' | 'provider' | 'system',
  actorId: string | null,
  note: string | null,
): Promise<void> {
  await db.query(
    'INSERT INTO creator_kyc_events (creator_id, from_status, to_status, actor_id, actor_type, note) VALUES ($1,$2,$3,$4,$5,$6)',
    [creatorId, from, to, actorId, actorType, note],
  );
}

/**
 * Creator submits verification. Creates the payout account with the payment provider when there is none (that is where real KYC happens:
 * the response carries the provider's hosted onboarding link, if any). unverified|rejected -> pending. Idempotent while pending.
 */
export async function submitKyc(
  ctx: AppContext,
  auth: AuthContext,
  input: { country: string; returnUrl?: string | undefined },
  req?: FastifyRequest,
): Promise<{ creator: CreatorRow; onboardingUrl: string | null }> {
  const c = await requireCreator(ctx.db, auth.userId);
  if (c.kyc_status === 'pending') return { creator: c, onboardingUrl: null };
  if (nextKycStatus(c.kyc_status, 'submit') === null)
    throw conflict(`Verification is already ${c.kyc_status}`, {
      reason: 'kyc_state',
      kycStatus: c.kyc_status,
    });
  const actor = { userId: auth.userId, ageBand: auth.ageBand };
  let onboardingUrl: string | null = null;
  const existing = await findAccount(ctx.db, { type: 'user', id: auth.userId });
  if (!existing) {
    const r = await createPayoutAccount(
      ctx,
      actor,
      { country: input.country, returnUrl: input.returnUrl },
      req,
    );
    onboardingUrl = r.onboardingUrl;
  } else if (getPaymentProvider(ctx).name === 'dev') {
    await setAccountKyc(ctx.db, existing.id, 'pending');
  } else {
    throw conflict(
      'Resubmit through the provider onboarding link (POST /v1/payout-accounts/:id/refresh after finishing it)',
      { reason: 'resubmit_via_provider' },
    );
  }
  await ctx.db.query(
    `UPDATE creators SET kyc_status = 'pending', kyc_submitted_at = now(), kyc_decided_at = NULL, kyc_note = NULL WHERE user_id = $1`,
    [auth.userId],
  );
  await kycEvent(ctx.db, auth.userId, c.kyc_status, 'pending', 'creator', auth.userId, null);
  await audit(
    ctx,
    {
      actorId: auth.userId,
      action: 'creator.kyc_submitted',
      targetType: 'creator',
      targetId: auth.userId,
      metadata: { from: c.kyc_status, country: input.country },
    },
    req,
  );
  return { creator: (await loadCreator(ctx.db, auth.userId))!, onboardingUrl };
}

/**
 * Staff decision on a submitted creator. Only `pending` creators can be decided. With the dev provider the outcome is pushed to the (fake)
 * provider so payouts really work; with a real provider staff can REJECT but never mark verified (that comes from the provider's account event).
 */
export async function decideKyc(
  ctx: AppContext,
  staff: { userId: string },
  creatorId: string,
  decision: 'verify' | 'reject',
  note: string,
  req?: FastifyRequest,
): Promise<CreatorRow> {
  const c = await loadCreator(ctx.db, creatorId);
  if (!c) throw notFound('Creator');
  if (staff.userId === creatorId) throw forbidden('You cannot verify your own account');
  const to = nextKycStatus(c.kyc_status, decision);
  if (!to)
    throw conflict(
      `Verification is ${c.kyc_status}: only submitted (pending) creators can be decided`,
      { reason: 'kyc_state', kycStatus: c.kyc_status },
    );
  const provider = getPaymentProvider(ctx);
  if (decision === 'verify' && provider.name !== 'dev')
    throw new AppError(
      'forbidden',
      'Verification comes from the payment provider and cannot be granted manually',
      { reason: 'kyc_provider_only' },
    );
  const account = await findAccount(ctx.db, { type: 'user', id: creatorId });
  if (!account)
    throw conflict('The creator has no payout account yet', { reason: 'payout_account_required' });
  if (provider instanceof DevPaymentProvider) {
    provider.devSetKyc(account.account_ref, to);
    await deliverLocalWebhooks(ctx);
  }
  await withTransaction(ctx.db, async (tx) => {
    await setAccountKyc(tx, account.id, to);
    await tx.query(
      'UPDATE creators SET kyc_status = $2, kyc_decided_at = now(), kyc_decided_by = $3, kyc_note = $4 WHERE user_id = $1',
      [creatorId, to, staff.userId, note],
    );
    await kycEvent(tx, creatorId, c.kyc_status, to, 'staff', staff.userId, note);
    await audit(
      ctx,
      {
        actorId: staff.userId,
        actorType: 'staff',
        action: `creator.kyc_${to}`,
        targetType: 'creator',
        targetId: creatorId,
        metadata: { from: c.kyc_status, to, note },
      },
      req,
      tx,
    );
  });
  await notify(ctx, {
    userId: creatorId,
    kind: `creator_kyc_${to}`,
    data: { note: to === 'rejected' ? note : undefined },
  });
  return (await loadCreator(ctx.db, creatorId))!;
}

export async function kycHistory(db: Queryable, creatorId: string) {
  const { rows } = await db.query(
    `SELECT from_status, to_status, actor_type, note, created_at FROM creator_kyc_events WHERE creator_id = $1 ORDER BY id DESC LIMIT 50`,
    [creatorId],
  );
  return rows.map((r) => ({
    from: r.from_status as string,
    to: r.to_status as string,
    by: r.actor_type as string,
    note: r.note as string | null,
    at: (r.created_at as Date).toISOString(),
  }));
}
