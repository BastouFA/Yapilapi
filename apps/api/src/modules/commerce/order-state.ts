import { AppError } from '@yapilapi/shared';

export const ORDER_STATUSES = [
  'pending_review',
  'pending_payment',
  'paid',
  'fulfilled',
  'completed',
  'cancelled',
  'refunded',
  'partially_refunded',
  'disputed',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Who is performing a transition. Enforced together with the transition table, in ONE place. */
export type OrderActor = 'buyer' | 'seller' | 'staff' | 'system';

/**
 * Order state machine.
 *
 *   pending_review --staff approve--> pending_payment          (held by the fraud rules at checkout)
 *   pending_review --staff reject / expiry--> cancelled
 *   pending_payment --(pay-time fraud rules)--> pending_review
 *   pending_payment --payment captured (webhook)--> paid
 *   pending_payment --buyer cancel / reservation expiry--> cancelled
 *   paid --seller ships / auto-fulfil--> fulfilled --buyer confirms / timeout--> completed
 *   paid | fulfilled | completed | partially_refunded --refund--> partially_refunded | refunded
 *   paid | fulfilled | completed | partially_refunded --dispute opened--> disputed
 *   disputed --won--> the status it had before | --lost--> refunded
 *   cancelled and refunded are terminal.
 *
 * Money moves only through payments/refunds; a paid order is never "cancelled", it is refunded.
 */
const T = (actors: OrderActor[]) => actors;
export const ORDER_TRANSITIONS: Readonly<
  Record<OrderStatus, Readonly<Partial<Record<OrderStatus, readonly OrderActor[]>>>>
> = {
  pending_review: { pending_payment: T(['staff']), cancelled: T(['staff', 'system']) },
  pending_payment: {
    pending_review: T(['system']),
    paid: T(['system']),
    cancelled: T(['buyer', 'staff', 'system']),
  },
  paid: {
    fulfilled: T(['seller', 'staff', 'system']),
    refunded: T(['system']),
    partially_refunded: T(['system']),
    disputed: T(['system']),
  },
  fulfilled: {
    completed: T(['buyer', 'system']),
    refunded: T(['system']),
    partially_refunded: T(['system']),
    disputed: T(['system']),
  },
  completed: {
    refunded: T(['system']),
    partially_refunded: T(['system']),
    disputed: T(['system']),
  },
  partially_refunded: {
    fulfilled: T(['seller', 'staff', 'system']),
    completed: T(['buyer', 'system']),
    refunded: T(['system']),
    partially_refunded: T(['system']),
    disputed: T(['system']),
  },
  disputed: {
    paid: T(['system']),
    fulfilled: T(['system']),
    completed: T(['system']),
    partially_refunded: T(['system']),
    refunded: T(['system']),
  },
  cancelled: {},
  refunded: {},
};

export const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = ['cancelled', 'refunded'];
/** Statuses in which money has been captured for the order. */
export const PAID_ORDER_STATUSES: readonly OrderStatus[] = [
  'paid',
  'fulfilled',
  'completed',
  'partially_refunded',
  'disputed',
  'refunded',
];
/** Statuses that entitle the buyer to their goods (downloads, tickets, reviews). */
export const ENTITLED_ORDER_STATUSES: readonly OrderStatus[] = [
  'paid',
  'fulfilled',
  'completed',
  'partially_refunded',
  'disputed',
];
/** Statuses in which a refund can be requested. */
export const REFUNDABLE_ORDER_STATUSES: readonly OrderStatus[] = [
  'paid',
  'fulfilled',
  'completed',
  'partially_refunded',
];
/** Unpaid statuses that hold a stock reservation. */
export const OPEN_ORDER_STATUSES: readonly OrderStatus[] = ['pending_payment', 'pending_review'];

export const isOrderStatus = (s: string): s is OrderStatus =>
  (ORDER_STATUSES as readonly string[]).includes(s);

export function canTransition(from: OrderStatus, to: OrderStatus, actor?: OrderActor): boolean {
  const allowed = ORDER_TRANSITIONS[from][to];
  if (!allowed) return false;
  return actor === undefined ? true : allowed.includes(actor);
}

/** Throws 409 `invalid_order_transition` (or 403 when the transition exists but not for this actor). */
export function assertTransition(from: OrderStatus, to: OrderStatus, actor: OrderActor): void {
  const allowed = ORDER_TRANSITIONS[from][to];
  if (!allowed)
    throw new AppError(
      'conflict',
      `An order that is ${from.replace(/_/g, ' ')} cannot become ${to.replace(/_/g, ' ')}`,
      { reason: 'invalid_order_transition', from, to },
    );
  if (!allowed.includes(actor))
    throw new AppError('forbidden', 'You cannot make that change to this order');
}
