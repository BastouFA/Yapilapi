import { createHash } from 'node:crypto';
import { z } from 'zod';
import { withTransaction, type Queryable, type Tx } from '@yapilapi/database';
import { hashIp } from '@yapilapi/security';
import { AppError, conflict, forbidden, invalid, notFound } from '@yapilapi/shared';
import {
  MoneyError,
  addMinor,
  assertMinorAmount,
  calculatePlatformFee,
  mulDiv,
  mulMinor,
} from '@yapilapi/payments';
import type { AppContext } from '../../lib/context.js';
import { audit } from '../../lib/audit.js';
import { isBlockedEitherWay } from '../../lib/users.js';
import { eventVisibleSql, EVENT_END_SQL } from '../events/access.js';
import { assess, storeSignal } from '../payments/fraud.js';
import type { Payee } from '../payments/ledger.js';
import { cancelAtProvider, voidOpenPayments } from '../payments/void.js';
import { getBusinessAccess } from '../business/access.js';
import { hasSellerAccess, orderSeller } from './access.js';
import {
  assertTransition,
  OPEN_ORDER_STATUSES,
  type OrderActor,
  type OrderStatus,
} from './order-state.js';
import { PRODUCT_COLS, shopperVisibleSql, stockStatus, type ProductRow } from './products.js';
import type { DbRow } from '../../lib/db-row.js';

// ------------------------------------------------------------------ input
export const shippingAddressSchema = z.object({
  name: z.string().trim().min(1).max(120),
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1).max(120),
  region: z.string().trim().max(120).optional(),
  postalCode: z.string().trim().min(1).max(20),
  country: z
    .string()
    .trim()
    .length(2)
    .transform((s) => s.toUpperCase()),
});

const quantity = z.number().int().min(1).max(100).default(1);
export const orderItemSchema = z.union([
  z.object({ productId: z.uuid(), quantity, bookingId: z.uuid().optional() }),
  z.object({ ticketTypeId: z.uuid(), quantity }),
]);
export const createOrderBody = z.object({
  items: z.array(orderItemSchema).min(1).max(20),
  shippingAddress: shippingAddressSchema.optional(),
});
export type CreateOrderBody = z.infer<typeof createOrderBody>;

export const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;

/** Stable JSON: sorted keys, so semantically equal payloads hash equally. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}
export const requestHash = (body: unknown): string =>
  createHash('sha256').update(canonicalJson(body)).digest('hex');

// ------------------------------------------------------------------ pricing (server side only)
export interface QuoteLine {
  itemType: 'product' | 'ticket' | 'booking';
  productId: string | null;
  ticketTypeId: string | null;
  eventId: string | null;
  bookingId: string | null;
  productKind: string;
  title: string;
  quantity: number;
  unitPrice: number;
  lineSubtotal: number;
  tax: number;
  shipping: number;
  physical: boolean;
  /** Product row or ticket-type row for the reservation step. */
  stock: number | null;
}

export interface Quote {
  seller: Payee;
  currency: string;
  lines: QuoteLine[];
  subtotal: number;
  shipping: number;
  tax: number;
  total: number;
  fee: number;
  hasPhysical: boolean;
}

/**
 * Pure pricing: totals from server-side unit prices. Shipping is a flat per-physical-line placeholder taken from the product's
 * delivery settings; tax is the seller-declared per-product rate (basis points, half-up per line). Neither is a real engine.
 * The platform fee applies to the merchandise subtotal only (shipping and tax pass through to the seller).
 */
export function priceLines(
  lines: Array<
    Pick<QuoteLine, 'quantity' | 'unitPrice' | 'physical'> & {
      taxBps: number;
      shippingCents: number;
    }
  >,
  feeBps: number,
): {
  subtotal: number;
  shipping: number;
  tax: number;
  total: number;
  fee: number;
  perLine: Array<{ lineSubtotal: number; tax: number; shipping: number }>;
} {
  const perLine = lines.map((l) => {
    const lineSubtotal = mulMinor(l.unitPrice, l.quantity);
    return {
      lineSubtotal,
      tax: mulDiv(lineSubtotal, l.taxBps, 10_000, 'half_up'),
      shipping: l.physical ? l.shippingCents : 0,
    };
  });
  const subtotal = addMinor(...perLine.map((l) => l.lineSubtotal));
  const shipping = addMinor(...perLine.map((l) => l.shipping));
  const tax = addMinor(...perLine.map((l) => l.tax));
  const total = assertMinorAmount(addMinor(subtotal, shipping, tax), 'total');
  return {
    subtotal,
    shipping,
    tax,
    total,
    fee: calculatePlatformFee(subtotal, { bps: feeBps }).fee,
    perLine,
  };
}

interface TicketRow {
  id: string;
  event_id: string;
  name: string;
  price_cents: number;
  currency: string;
  quantity: number;
  sold: number;
  max_per_user: number;
  sales_start: Date | null;
  sales_end: Date | null;
  archived_at: Date | null;
  event_title: string;
  host_id: string | null;
  host_business_id: string | null;
  event_status: string;
  event_end: Date;
  visible: boolean;
  held: number;
}

/**
 * Validate the request against live data and compute the quote. With `lock`, product and ticket-type rows are locked (in id order,
 * so concurrent checkouts cannot deadlock) which serialises stock checks: exactly one of two buyers gets the last unit.
 */
export async function buildQuote(
  ctx: AppContext,
  db: Queryable,
  buyerId: string,
  body: CreateOrderBody,
  opts: { lock?: boolean } = {},
): Promise<Quote> {
  const lock = opts.lock ? 'FOR UPDATE OF pd' : '';
  const productReqs = body.items.filter(
    (i): i is { productId: string; quantity: number; bookingId?: string | undefined } =>
      'productId' in i,
  );
  const ticketReqs = body.items.filter(
    (i): i is { ticketTypeId: string; quantity: number } => 'ticketTypeId' in i,
  );
  const productIds = [...new Set(productReqs.map((i) => i.productId))];
  const ticketIds = [...new Set(ticketReqs.map((i) => i.ticketTypeId))];
  if (productIds.length !== productReqs.length || ticketIds.length !== ticketReqs.length)
    throw invalid('List each product or ticket type once and use quantity');

  const products = productIds.length
    ? (
        await db.query<ProductRow & { visible: boolean }>(
          `SELECT ${PRODUCT_COLS}, ${shopperVisibleSql('$2::uuid')} AS visible FROM products pd WHERE pd.id = ANY($1::uuid[]) AND pd.deleted_at IS NULL ORDER BY pd.id ${lock}`,
          [productIds, buyerId],
        )
      ).rows
    : [];
  const tickets = ticketIds.length
    ? (
        await db.query<TicketRow>(
          `SELECT tt.id, tt.event_id, tt.name, tt.price_cents, tt.currency, tt.quantity, tt.sold, tt.max_per_user, tt.sales_start, tt.sales_end, tt.archived_at,
                e.title AS event_title, e.host_id, e.host_business_id, e.status AS event_status, ${EVENT_END_SQL} AS event_end, ${eventVisibleSql('$2::uuid', 'e')} AS visible,
                COALESCE((SELECT sum(oi.quantity) FROM order_items oi JOIN orders o ON o.id = oi.order_id
                           WHERE oi.ticket_type_id = tt.id AND o.status IN ('pending_payment','pending_review') AND o.reserved_until > now()), 0)::int AS held
           FROM event_ticket_types tt JOIN events e ON e.id = tt.event_id WHERE tt.id = ANY($1::uuid[]) AND e.deleted_at IS NULL ORDER BY tt.id ${opts.lock ? 'FOR UPDATE OF tt' : ''}`,
          [ticketIds, buyerId],
        )
      ).rows
    : [];
  if (products.length !== productIds.length || tickets.length !== ticketIds.length)
    throw notFound('Item');

  const rawLines: Array<
    Omit<QuoteLine, 'unitPrice' | 'lineSubtotal' | 'tax' | 'shipping'> & {
      unitPrice: number;
      taxBps: number;
      shippingCents: number;
      seller: Payee;
      currency: string;
    }
  > = [];
  const now = new Date();

  for (const req of productReqs) {
    const p = products.find((x) => x.id === req.productId)!;
    if (!p.visible) throw notFound('Product');
    if (p.status !== 'active')
      throw new AppError('conflict', 'This product is sold out', {
        reason: 'out_of_stock',
        productId: p.id,
      });
    if (p.kind === 'ticket')
      throw new AppError('unprocessable', 'Event tickets are bought through their event');
    const seller: Payee = p.business_id
      ? { type: 'business', id: p.business_id }
      : { type: 'user', id: p.seller_user_id! };
    if (p.kind === 'physical') {
      if (p.stock === null || p.stock < req.quantity)
        throw new AppError('conflict', 'Not enough stock', {
          reason: 'out_of_stock',
          productId: p.id,
          available: p.stock ?? 0,
        });
    } else if (req.quantity !== 1) {
      throw invalid('Digital products, services and bookings are bought one at a time');
    }
    let bookingId: string | null = null;
    if (p.kind === 'booking' || req.bookingId) {
      if (!req.bookingId)
        throw invalid('A booking product needs the bookingId of your booking request');
      const bk = await db.query<{
        id: string;
        status: string;
        starts_at: Date;
        customer_id: string;
        product_id: string | null;
        order_id: string | null;
      }>(
        'SELECT id, status, starts_at, customer_id, product_id, order_id FROM bookings WHERE id = $1',
        [req.bookingId],
      );
      const b = bk.rows[0];
      if (!b || b.customer_id !== buyerId) throw notFound('Booking');
      if (b.product_id !== p.id) throw invalid('That booking is not for this product');
      if (!['requested', 'confirmed'].includes(b.status) || b.starts_at <= now)
        throw conflict('That booking can no longer be paid for', { reason: 'booking_unavailable' });
      if (b.order_id)
        throw conflict('That booking already belongs to an order', {
          reason: 'booking_already_ordered',
        });
      bookingId = b.id;
    }
    if (p.kind === 'digital') {
      const owned = await db.query(
        `SELECT 1 FROM order_entitlements WHERE user_id = $1 AND kind = 'digital' AND ref_id = $2 AND status IN ('pending','granted') LIMIT 1`,
        [buyerId, p.id],
      );
      if (owned.rowCount)
        throw conflict('You already own this product', { reason: 'already_purchased' });
    }
    rawLines.push({
      itemType: p.kind === 'booking' ? 'booking' : 'product',
      productId: p.id,
      ticketTypeId: null,
      eventId: null,
      bookingId,
      productKind: p.kind,
      title: p.title,
      quantity: req.quantity,
      unitPrice: p.price_cents,
      physical: p.kind === 'physical',
      stock: p.stock,
      taxBps: p.tax_bps,
      shippingCents: p.delivery.shippingCents ?? 0,
      seller,
      currency: p.currency,
    });
  }

  for (const req of ticketReqs) {
    const t = tickets.find((x) => x.id === req.ticketTypeId)!;
    if (!t.visible) throw notFound('Ticket');
    if (
      t.archived_at ||
      t.event_status !== 'published' ||
      t.event_end <= now ||
      (t.sales_start && t.sales_start > now) ||
      (t.sales_end && t.sales_end <= now)
    ) {
      throw new AppError('conflict', 'This ticket is not on sale', {
        reason: 'ticket_not_on_sale',
      });
    }
    if (t.price_cents <= 0)
      throw new AppError('unprocessable', 'Free tickets are claimed by RSVP, not bought', {
        reason: 'free_ticket',
      });
    if (req.quantity > t.max_per_user)
      throw new AppError('conflict', 'Ticket limit per person exceeded', {
        reason: 'ticket_limit',
        max: t.max_per_user,
      });
    if (t.quantity - t.sold - t.held < req.quantity)
      throw new AppError('conflict', 'Not enough tickets left', {
        reason: 'ticket_sold_out',
        available: Math.max(0, t.quantity - t.sold - t.held),
      });
    if (!t.host_id && !t.host_business_id) throw notFound('Ticket');
    let seller: Payee;
    if (t.host_business_id) {
      const b = await db.query<{ status: string }>(
        'SELECT status FROM businesses WHERE id = $1 AND deleted_at IS NULL',
        [t.host_business_id],
      );
      if (b.rows[0]?.status !== 'active') throw notFound('Ticket');
      seller = { type: 'business', id: t.host_business_id };
    } else seller = { type: 'user', id: t.host_id! };
    rawLines.push({
      itemType: 'ticket',
      productId: null,
      ticketTypeId: t.id,
      eventId: t.event_id,
      bookingId: null,
      productKind: 'ticket',
      title: `${t.event_title}: ${t.name}`,
      quantity: req.quantity,
      unitPrice: t.price_cents,
      physical: false,
      stock: null,
      taxBps: 0,
      shippingCents: 0,
      seller,
      currency: t.currency,
    });
  }

  const first = rawLines[0]!;
  if (
    rawLines.some((l) => l.seller.type !== first.seller.type || l.seller.id !== first.seller.id)
  ) {
    throw new AppError('unprocessable', 'An order can only contain items from one seller', {
      reason: 'mixed_sellers',
    });
  }
  if (rawLines.some((l) => l.currency !== first.currency))
    throw new AppError('unprocessable', 'An order can only use one currency', {
      reason: 'mixed_currency',
    });

  // Sellers cannot buy from themselves (or their own business team), and blocked pairs cannot trade.
  if (await hasSellerAccess(db, first.seller, buyerId, 'catalog', { allowInactive: true }))
    throw forbidden('You cannot buy from yourself');
  const owner =
    first.seller.type === 'user'
      ? first.seller.id
      : (
          await db.query<{ owner_id: string | null }>(
            'SELECT owner_id FROM businesses WHERE id = $1',
            [first.seller.id],
          )
        ).rows[0]?.owner_id;
  if (owner && (await isBlockedEitherWay(db, buyerId, owner))) throw notFound('Item');
  if (first.seller.type === 'business' && (await getBusinessAccess(db, first.seller.id, buyerId)))
    throw forbidden('You cannot buy from your own business');

  const priced = priceLines(rawLines, ctx.config.PLATFORM_FEE_BPS);
  const lines: QuoteLine[] = rawLines.map((l, i) => ({
    itemType: l.itemType,
    productId: l.productId,
    ticketTypeId: l.ticketTypeId,
    eventId: l.eventId,
    bookingId: l.bookingId,
    productKind: l.productKind,
    title: l.title,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    lineSubtotal: priced.perLine[i]!.lineSubtotal,
    tax: priced.perLine[i]!.tax,
    shipping: priced.perLine[i]!.shipping,
    physical: l.physical,
    stock: l.stock,
  }));
  if (priced.total <= 0) throw invalid('Nothing to pay for');
  return {
    seller: first.seller,
    currency: first.currency,
    lines,
    subtotal: priced.subtotal,
    shipping: priced.shipping,
    tax: priced.tax,
    total: priced.total,
    fee: priced.fee,
    hasPhysical: lines.some((l) => l.physical),
  };
}

// ------------------------------------------------------------------ rows and views
export interface OrderRow {
  id: string;
  buyer_id: string;
  seller_business_id: string | null;
  seller_user_id: string | null;
  status: OrderStatus;
  currency: string;
  subtotal_cents: number;
  shipping_cents: number;
  tax_cents: number;
  platform_fee_cents: number;
  total_cents: number;
  refunded_cents: number;
  idempotency_key: string;
  request_hash: string | null;
  shipping_address: unknown;
  shipping_country: string | null;
  fraud_score: number;
  fraud_flags: string[];
  fraud_decision: string | null;
  reserved_until: Date | null;
  prior_status: string | null;
  tracking: unknown;
  cancel_reason: string | null;
  created_at: Date;
  updated_at: Date;
  paid_at: Date | null;
  fulfilled_at: Date | null;
  completed_at: Date | null;
  cancelled_at: Date | null;
}

export const ORDER_COLS = `o.id, o.buyer_id, o.seller_business_id, o.seller_user_id, o.status, o.currency, o.subtotal_cents, o.shipping_cents, o.tax_cents, o.platform_fee_cents,
  o.total_cents, o.refunded_cents, o.idempotency_key, o.request_hash, o.shipping_address, o.shipping_country, o.fraud_score, o.fraud_flags, o.fraud_decision, o.reserved_until,
  o.prior_status, o.tracking, o.cancel_reason, o.created_at, o.updated_at, o.paid_at, o.fulfilled_at, o.completed_at, o.cancelled_at`;

export type OrderViewer = 'buyer' | 'seller' | 'staff';

export async function orderViews(ctx: AppContext, rows: OrderRow[], viewer: OrderViewer) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [items, pays, buyers, ents] = await Promise.all([
    ctx.db.query<DbRow>(
      `SELECT id, order_id, item_type, product_id, ticket_type_id, title_snapshot, quantity, unit_price_cents, tax_cents, product_kind, booking_id, event_id, refunded_cents, stock_state
         FROM order_items WHERE order_id = ANY($1::uuid[]) ORDER BY id`,
      [ids],
    ),
    ctx.db.query<DbRow>(
      `SELECT DISTINCT ON (order_id) id, order_id, status, failure_code, provider, created_at FROM payments WHERE order_id = ANY($1::uuid[]) ORDER BY order_id, created_at DESC`,
      [ids],
    ),
    viewer === 'buyer'
      ? { rows: [] }
      : ctx.db.query<{ user_id: string; username: string; display_name: string }>(
          'SELECT user_id, username::text AS username, display_name FROM profiles WHERE user_id = ANY($1::uuid[])',
          [rows.map((r) => r.buyer_id)],
        ),
    ctx.db.query<{ order_item_id: string; kind: string; status: string }>(
      'SELECT order_item_id, kind, status FROM order_entitlements WHERE order_id = ANY($1::uuid[])',
      [ids],
    ),
  ]);
  const buyerBy = new Map(buyers.rows.map((b) => [b.user_id, b]));
  const entBy = new Map(ents.rows.map((e) => [e.order_item_id, e]));
  return rows.map((r) => {
    const pay = pays.rows.find((p) => p.order_id === r.id);
    const b = buyerBy.get(r.buyer_id);
    return {
      id: r.id,
      status: r.status,
      currency: r.currency,
      subtotalCents: r.subtotal_cents,
      shippingCents: r.shipping_cents,
      taxCents: r.tax_cents,
      totalCents: r.total_cents,
      refundedCents: r.refunded_cents,
      ...(viewer !== 'buyer' ? { platformFeeCents: r.platform_fee_cents } : {}),
      items: items.rows
        .filter((i) => i.order_id === r.id)
        .map((i) => ({
          id: i.id,
          type: i.item_type,
          kind: i.product_kind,
          productId: i.product_id,
          ticketTypeId: i.ticket_type_id,
          eventId: i.event_id,
          bookingId: i.booking_id,
          title: i.title_snapshot,
          quantity: i.quantity,
          unitPriceCents: i.unit_price_cents,
          lineTotalCents: i.unit_price_cents * i.quantity,
          taxCents: i.tax_cents,
          refundedCents: i.refunded_cents,
          entitlement: entBy.get(i.id)
            ? { kind: entBy.get(i.id)!.kind, status: entBy.get(i.id)!.status }
            : null,
        })),
      shippingAddress:
        viewer === 'buyer' || viewer === 'seller' || viewer === 'staff'
          ? r.shipping_address
          : undefined,
      tracking: r.tracking ?? null,
      seller: r.seller_business_id
        ? { type: 'business', id: r.seller_business_id }
        : { type: 'user', id: r.seller_user_id },
      ...(b
        ? { buyer: { id: b.user_id, username: b.username, displayName: b.display_name } }
        : viewer === 'buyer'
          ? {}
          : { buyer: { id: r.buyer_id } }),
      payment: pay
        ? { id: pay.id, status: pay.status, failureCode: pay.failure_code, provider: pay.provider }
        : null,
      reservedUntil:
        r.status === 'pending_payment' || r.status === 'pending_review'
          ? (r.reserved_until?.toISOString() ?? null)
          : null,
      heldForReview: r.status === 'pending_review',
      cancelReason: r.cancel_reason,
      createdAt: r.created_at.toISOString(),
      paidAt: r.paid_at?.toISOString() ?? null,
      fulfilledAt: r.fulfilled_at?.toISOString() ?? null,
      completedAt: r.completed_at?.toISOString() ?? null,
      cancelledAt: r.cancelled_at?.toISOString() ?? null,
      ...(viewer === 'staff'
        ? { fraud: { score: r.fraud_score, decision: r.fraud_decision, flags: r.fraud_flags } }
        : {}),
    };
  });
}

export async function loadOrder(
  db: Queryable,
  id: string,
  opts: { lock?: boolean } = {},
): Promise<OrderRow> {
  const { rows } = await db.query<OrderRow>(
    `SELECT ${ORDER_COLS} FROM orders o WHERE o.id = $1 ${opts.lock ? 'FOR UPDATE' : ''}`,
    [id],
  );
  if (!rows[0]) throw notFound('Order');
  return rows[0];
}

/** Which side of the order is this user? Buyers see their orders, sellers (or their business team) orders containing their items, nobody else anything. */
export async function orderViewer(
  db: Queryable,
  o: OrderRow,
  userId: string,
  need: 'catalog' | 'orders' | 'money' = 'orders',
): Promise<'buyer' | 'seller' | null> {
  if (o.buyer_id === userId) return 'buyer';
  if (await hasSellerAccess(db, orderSeller(o), userId, need, { allowInactive: true }))
    return 'seller';
  return null;
}

// ------------------------------------------------------------------ state transitions: the ONLY writer of orders.status
const STAMP: Partial<Record<OrderStatus, string>> = {
  paid: 'paid_at',
  fulfilled: 'fulfilled_at',
  completed: 'completed_at',
  cancelled: 'cancelled_at',
};

/** Lock the order, validate the transition (table + actor) and apply it. Returns the previous status. */
export async function transitionOrder(
  tx: Queryable,
  orderId: string,
  to: OrderStatus,
  actor: OrderActor,
  patch: { cancelReason?: string; priorStatus?: string | null; reservedUntil?: Date | null } = {},
): Promise<{ from: OrderStatus }> {
  const { rows } = await tx.query<{ status: OrderStatus }>(
    'SELECT status FROM orders WHERE id = $1 FOR UPDATE',
    [orderId],
  );
  if (!rows[0]) throw notFound('Order');
  const from = rows[0].status;
  assertTransition(from, to, actor);
  const stamp = STAMP[to];
  await tx.query(
    `UPDATE orders SET status = $2, ${stamp ? `${stamp} = now(),` : ''} cancel_reason = COALESCE($3::text, cancel_reason),
       prior_status = CASE WHEN $2 = 'disputed' THEN $4::text WHEN $5::boolean THEN NULL ELSE prior_status END,
       reserved_until = CASE WHEN $2 IN ('pending_payment','pending_review') THEN COALESCE($6::timestamptz, reserved_until) ELSE NULL END
     WHERE id = $1`,
    [
      orderId,
      to,
      patch.cancelReason ?? null,
      patch.priorStatus ?? null,
      from === 'disputed',
      patch.reservedUntil ?? null,
    ],
  );
  return { from };
}

// ------------------------------------------------------------------ stock
export async function releaseStock(tx: Queryable, orderId: string): Promise<void> {
  const { rows } = await tx.query<{ id: string; product_id: string; quantity: number }>(
    `UPDATE order_items SET stock_state = 'released' WHERE order_id = $1 AND stock_state = 'held' RETURNING id, product_id, quantity`,
    [orderId],
  );
  for (const r of rows.sort((a, b) => (a.product_id < b.product_id ? -1 : 1)))
    await restoreProductStock(tx, r.product_id, r.quantity);
}

export async function restoreProductStock(
  tx: Queryable,
  productId: string,
  qty: number,
): Promise<void> {
  const { rows } = await tx.query<{
    status: ProductRow['status'];
    stock: number;
    kind: ProductRow['kind'];
  }>(
    'UPDATE products SET stock = stock + $2 WHERE id = $1 AND stock IS NOT NULL RETURNING status, stock, kind',
    [productId, qty],
  );
  const p = rows[0];
  if (p) {
    const s = stockStatus(p.status, p.stock, p.kind);
    if (s !== p.status)
      await tx.query('UPDATE products SET status = $2 WHERE id = $1', [productId, s]);
  }
}

// ------------------------------------------------------------------ create
export class ReplayError extends Error {}

export interface CreateOrderResult {
  order: OrderRow;
  replayed: boolean;
  held: boolean;
}

export async function createOrder(
  ctx: AppContext,
  buyer: { userId: string; ageBand: 'teen' | 'adult' },
  key: string,
  body: CreateOrderBody,
  req: { id?: string; clientIp: string },
  reqForAudit?: Parameters<typeof audit>[2],
): Promise<CreateOrderResult> {
  if (buyer.ageBand === 'teen')
    throw new AppError('forbidden', 'Accounts under 18 cannot make purchases');
  const hash = requestHash(body);

  const existing = async (db: Queryable): Promise<CreateOrderResult | null> => {
    const { rows } = await db.query<OrderRow>(
      `SELECT ${ORDER_COLS} FROM orders o WHERE o.buyer_id = $1 AND o.idempotency_key = $2`,
      [buyer.userId, key],
    );
    const o = rows[0];
    if (!o) return null;
    if (o.request_hash !== hash)
      throw new AppError(
        'conflict',
        'This Idempotency-Key was already used with a different request',
        { reason: 'idempotency_key_reuse' },
      );
    return { order: o, replayed: true, held: o.status === 'pending_review' };
  };
  const prior = await existing(ctx.db);
  if (prior) return prior;

  // Read-only pass: validate, price, and run the fraud rules before taking any locks.
  const quote0 = await buildQuote(ctx, ctx.db, buyer.userId, body);
  if (quote0.hasPhysical && !body.shippingAddress)
    throw new AppError('unprocessable', 'A shipping address is required for physical products', {
      reason: 'shipping_address_required',
    });
  const ipHash = hashIp(req.clientIp, ctx.config.IP_HASH_SALT ?? 'dev-salt');
  const sig = {
    userId: buyer.userId,
    ipHash,
    amountMinor: quote0.total,
    currency: quote0.currency,
    shippingCountry: body.shippingAddress?.country ?? null,
  };
  const assessment = await assess(ctx.db, sig);
  if (assessment.result.decision === 'block') {
    await storeSignal(ctx.db, { ...sig, stage: 'checkout', subjectType: 'order' }, assessment);
    await audit(
      ctx,
      {
        actorId: buyer.userId,
        action: 'order.blocked',
        targetType: 'order',
        metadata: {
          score: assessment.result.score,
          reasons: assessment.result.reasons.map((r) => r.code),
          amountCents: quote0.total,
          currency: quote0.currency,
        },
      },
      reqForAudit,
    );
    ctx.metrics.events.inc({ name: 'order_blocked' });
    throw new AppError(
      'forbidden',
      'We could not process this order. Please contact support if you think this is a mistake.',
      { reason: 'risk_declined' },
    );
  }
  const held = assessment.result.decision === 'review';

  try {
    const order = await withTransaction(ctx.db, async (tx) => {
      const quote = await buildQuote(ctx, tx, buyer.userId, body, { lock: true });
      if (quote.total !== quote0.total || quote.currency !== quote0.currency)
        throw new AppError(
          'conflict',
          'Prices changed while you were checking out. Review the order and try again.',
          { reason: 'price_changed' },
        );
      const reserveMs = held
        ? ctx.config.ORDER_REVIEW_HOLD_HOURS * 3_600_000
        : ctx.config.ORDER_RESERVATION_MINUTES * 60_000;
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO orders (buyer_id, seller_business_id, seller_user_id, status, currency, subtotal_cents, shipping_cents, tax_cents, platform_fee_cents, total_cents, idempotency_key,
                             request_hash, shipping_address, shipping_country, fraud_score, fraud_flags, fraud_decision, reserved_until, ip_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now() + ($18::bigint * interval '1 millisecond'), $19)
         ON CONFLICT (buyer_id, idempotency_key) DO NOTHING RETURNING id`,
        [
          buyer.userId,
          quote.seller.type === 'business' ? quote.seller.id : null,
          quote.seller.type === 'user' ? quote.seller.id : null,
          held ? 'pending_review' : 'pending_payment',
          quote.currency,
          quote.subtotal,
          quote.shipping,
          quote.tax,
          quote.fee,
          quote.total,
          key,
          hash,
          body.shippingAddress ? JSON.stringify(body.shippingAddress) : null,
          body.shippingAddress?.country ?? null,
          assessment.result.score,
          assessment.result.reasons.map((r) => r.code),
          assessment.result.decision,
          reserveMs,
          ipHash,
        ],
      );
      const orderId = ins.rows[0]?.id;
      if (!orderId) throw new ReplayError();

      for (const l of quote.lines) {
        if (l.physical) {
          const upd = await tx.query<{
            stock: number;
            status: ProductRow['status'];
            kind: ProductRow['kind'];
          }>(
            `UPDATE products SET stock = stock - $2 WHERE id = $1 AND stock >= $2 AND status = 'active' RETURNING stock, status, kind`,
            [l.productId, l.quantity],
          );
          if (!upd.rows[0])
            throw new AppError('conflict', 'Not enough stock', {
              reason: 'out_of_stock',
              productId: l.productId,
            });
          const s = stockStatus(upd.rows[0].status, upd.rows[0].stock, upd.rows[0].kind);
          if (s !== upd.rows[0].status)
            await tx.query('UPDATE products SET status = $2 WHERE id = $1', [l.productId, s]);
        }
        const item = await tx.query<{ id: string }>(
          `INSERT INTO order_items (order_id, item_type, product_id, ticket_type_id, title_snapshot, quantity, unit_price_cents, tax_cents, product_kind, booking_id, event_id, stock_state)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
          [
            orderId,
            l.itemType,
            l.productId,
            l.ticketTypeId,
            l.title,
            l.quantity,
            l.unitPrice,
            l.tax,
            l.productKind,
            l.bookingId,
            l.eventId,
            l.physical ? 'held' : 'none',
          ],
        );
        void item;
        if (l.bookingId) {
          const link = await tx.query(
            'UPDATE bookings SET order_id = $2 WHERE id = $1 AND order_id IS NULL',
            [l.bookingId, orderId],
          );
          if (!link.rowCount)
            throw conflict('That booking already belongs to an order', {
              reason: 'booking_already_ordered',
            });
        }
      }
      await storeSignal(
        tx,
        { ...sig, stage: 'checkout', subjectType: 'order', subjectId: orderId },
        assessment,
      );
      await audit(
        ctx,
        {
          actorId: buyer.userId,
          action: held ? 'order.held_for_review' : 'order.created',
          targetType: 'order',
          targetId: orderId,
          metadata: {
            totalCents: quote.total,
            currency: quote.currency,
            feeCents: quote.fee,
            items: quote.lines.length,
            sellerType: quote.seller.type,
            sellerId: quote.seller.id,
            fraudScore: assessment.result.score,
            reasons: held ? assessment.result.reasons.map((r) => r.code) : undefined,
          },
        },
        reqForAudit,
        tx,
      );
      return loadOrder(tx, orderId);
    });
    ctx.metrics.events.inc({ name: held ? 'order_held' : 'order_created' });
    return { order, replayed: false, held };
  } catch (err) {
    if (err instanceof ReplayError) {
      const again = await existing(ctx.db);
      if (again) return again;
    }
    if (err instanceof MoneyError) throw invalid(err.message);
    throw err;
  }
}

// ------------------------------------------------------------------ cancel / expire
/** Cancel an unpaid order: state machine, stock, unpaid payments and booking links, in the caller's transaction. */
export async function cancelOrderTx(
  ctx: AppContext,
  tx: Tx,
  orderId: string,
  actor: OrderActor,
  reason: string,
): Promise<Array<{ id: string; providerRef: string }>> {
  await transitionOrder(tx, orderId, 'cancelled', actor, { cancelReason: reason });
  await releaseStock(tx, orderId);
  await tx.query(`UPDATE bookings SET order_id = NULL WHERE order_id = $1`, [orderId]);
  void ctx;
  return voidOpenPayments(tx, orderId);
}

export async function cancelOrder(
  ctx: AppContext,
  orderId: string,
  actor: OrderActor,
  actorId: string | null,
  reason: string,
  req?: Parameters<typeof audit>[2],
): Promise<void> {
  const voided = await withTransaction(ctx.db, async (tx) => {
    const v = await cancelOrderTx(ctx, tx, orderId, actor, reason);
    await audit(
      ctx,
      {
        actorId,
        actorType: actor === 'system' ? 'system' : actor === 'staff' ? 'staff' : 'user',
        action: 'order.cancelled',
        targetType: 'order',
        targetId: orderId,
        metadata: { reason, actor },
      },
      req,
      tx,
    );
    return v;
  });
  await cancelAtProvider(ctx, voided);
}

/**
 * Job (exported; also `npm run commerce:maintenance`): cancel unpaid orders whose reservation ran out and give the stock back.
 * Idempotent and safe to run concurrently (rows are claimed with SKIP LOCKED). A payment that is still in flight for such an order
 * and succeeds later is refunded automatically by the webhook handler.
 */
export async function releaseExpiredReservations(
  ctx: AppContext,
  now: Date = new Date(),
  limit = 200,
): Promise<number> {
  let released = 0;
  for (;;) {
    const done = await withTransaction(ctx.db, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM orders WHERE status = ANY($1::text[]) AND reserved_until IS NOT NULL AND reserved_until < $2 ORDER BY reserved_until LIMIT $3 FOR UPDATE SKIP LOCKED`,
        [[...OPEN_ORDER_STATUSES], now, limit],
      );
      const voided: Array<{ id: string; providerRef: string }> = [];
      for (const r of rows) {
        voided.push(...(await cancelOrderTx(ctx, tx, r.id, 'system', 'reservation_expired')));
        await audit(
          ctx,
          {
            actorType: 'system',
            action: 'order.reservation_expired',
            targetType: 'order',
            targetId: r.id,
          },
          undefined,
          tx,
        );
      }
      return { n: rows.length, voided };
    });
    released += done.n;
    await cancelAtProvider(ctx, done.voided);
    if (done.n < limit) break;
  }
  if (released) ctx.metrics.events.inc({ name: 'order_reservation_expired' }, released);
  return released;
}

/** Job: fulfilled orders with no dispute or refund request complete on their own after ORDER_AUTO_COMPLETE_DAYS. */
export async function autoCompleteOrders(ctx: AppContext, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - ctx.config.ORDER_AUTO_COMPLETE_DAYS * 86_400_000);
  const { rows } = await ctx.db.query<{ id: string }>(
    `SELECT o.id FROM orders o WHERE o.status = 'fulfilled' AND o.fulfilled_at < $1
        AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.order_id = o.id AND r.status IN ('requested','approved','processing')) LIMIT 500`,
    [cutoff],
  );
  let n = 0;
  for (const r of rows) {
    try {
      await withTransaction(ctx.db, async (tx) => {
        await transitionOrder(tx, r.id, 'completed', 'system');
        await audit(
          ctx,
          {
            actorType: 'system',
            action: 'order.auto_completed',
            targetType: 'order',
            targetId: r.id,
          },
          undefined,
          tx,
        );
      });
      n += 1;
    } catch (err) {
      if (!(err instanceof AppError)) throw err; // raced with a refund/dispute: leave it
    }
  }
  return n;
}
