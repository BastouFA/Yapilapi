import type { Queryable } from '@yapilapi/database';
import { forbidden, notFound } from '@yapilapi/shared';
import { getBusinessAccess } from '../business/access.js';
import type { Payee } from '../payments/ledger.js';

/**
 * What a user may do for a seller:
 *  - `catalog`: manage products (business: offers.manage)
 *  - `orders`:  see and fulfil orders, decide refunds (business: bookings.manage, i.e. owner/admin/support)
 *  - `money`:   payout accounts, balances, payouts (business: the owner only)
 * Individual sellers can do everything for themselves.
 */
export type SellerNeed = 'catalog' | 'orders' | 'money';

export async function hasSellerAccess(
  db: Queryable,
  seller: Payee,
  userId: string,
  need: SellerNeed,
  opts: { allowInactive?: boolean } = {},
): Promise<boolean> {
  if (seller.type === 'user') return seller.id === userId;
  const a = await getBusinessAccess(db, seller.id, userId);
  if (!a) return false;
  if (!opts.allowInactive && a.status !== 'active') return false;
  if (need === 'catalog') return a.permissions.includes('offers.manage');
  if (need === 'orders') return a.permissions.includes('bookings.manage');
  return a.role === 'owner';
}

/** 404 for non-members (never reveal the seller's management surface), 403 for members without the permission. */
export async function requireSellerAccess(
  db: Queryable,
  seller: Payee,
  userId: string,
  need: SellerNeed,
  opts: { allowInactive?: boolean } = {},
): Promise<void> {
  if (seller.type === 'user') {
    if (seller.id !== userId) throw notFound('Resource');
    return;
  }
  const a = await getBusinessAccess(db, seller.id, userId);
  if (!a) throw notFound('Resource');
  if (!(await hasSellerAccess(db, seller, userId, need, opts)))
    throw forbidden('Your role does not allow that');
}

export interface OrderPartyRow {
  buyer_id: string;
  seller_user_id: string | null;
  seller_business_id: string | null;
}

export const orderSeller = (
  o: Pick<OrderPartyRow, 'seller_user_id' | 'seller_business_id'>,
): Payee =>
  o.seller_business_id
    ? { type: 'business', id: o.seller_business_id }
    : { type: 'user', id: o.seller_user_id! };

export const productSeller = (p: {
  business_id: string | null;
  seller_user_id: string | null;
}): Payee =>
  p.business_id ? { type: 'business', id: p.business_id } : { type: 'user', id: p.seller_user_id! };
