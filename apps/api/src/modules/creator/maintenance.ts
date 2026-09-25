import type { AppContext } from '../../lib/context.js';
import { attributeConversions, settleConversions } from './affiliate.js';
import { settlePartnershipPayments } from './partnerships.js';
import {
  processSubscriptionRenewals,
  settleCreatorPayments,
  type RenewalResult,
  type SettleResult,
} from './subscriptions.js';

export interface MaintenanceResult {
  settle: SettleResult;
  renewals: RenewalResult;
  partnershipsPaid: number;
  conversionsAttributed: number;
  conversions: { settled: number; reversed: number };
}

/** One idempotent pass over everything time- or webhook-driven in the creator economy. Safe to run concurrently; schedule every minute or so. */
export async function runCreatorMaintenance(
  ctx: AppContext,
  now: Date = new Date(),
): Promise<MaintenanceResult> {
  const settle = await settleCreatorPayments(ctx, { now });
  const renewals = await processSubscriptionRenewals(ctx, { now });
  const partnershipsPaid = await settlePartnershipPayments(ctx);
  const conversionsAttributed = await attributeConversions(ctx);
  const conversions = await settleConversions(ctx, { now });
  return { settle, renewals, partnershipsPaid, conversionsAttributed, conversions };
}
