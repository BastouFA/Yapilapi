import { randomBytes } from 'node:crypto';
import { DevPaymentProvider } from '@yapilapi/payments';
import { uniq, type ResponseBody, type Res, type TestApp, type TestUser } from './helpers.js';
import { getPaymentProvider } from '../src/modules/payments/index.js';

export const key = (): string => `k-${uniq('i')}-${randomBytes(4).toString('hex')}`;
/** A successful test card with its own fingerprint (the shared `tok_success` fingerprint would trip the card-sharing fraud rule after 3 buyers). */
export const okToken = (): string => `tok_success:fp=${randomBytes(6).toString('hex')}`;
export const idem = (k: string = key()): Record<string, string> => ({ 'idempotency-key': k });
export const US_ADDR = {
  name: 'Ada Buyer',
  line1: '1 Main St',
  city: 'Springfield',
  postalCode: '12345',
  country: 'US',
};

export const devProvider = (t: TestApp): DevPaymentProvider => {
  const p = getPaymentProvider(t.ctx);
  if (!(p instanceof DevPaymentProvider)) throw new Error('tests run against the dev provider');
  return p;
};

export async function mkProduct(
  seller: TestUser,
  over: Record<string, unknown> = {},
): Promise<ResponseBody> {
  const r = await seller.client.post('/v1/products', {
    kind: 'physical',
    title: `Widget ${uniq('w')}`,
    priceCents: 2000,
    currency: 'USD',
    stock: 5,
    status: 'active',
    delivery: { methods: ['post'], shippingCents: 0 },
    ...over,
  });
  if (r.status !== 201)
    throw new Error(`create product failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

export const checkout = (
  u: TestUser,
  items: unknown[],
  opts: { key?: string; shipping?: unknown | null; extra?: Record<string, unknown> } = {},
): Promise<Res> =>
  u.client.request('POST', '/v1/orders', {
    headers: idem(opts.key),
    body: {
      items,
      ...(opts.shipping === null ? {} : { shippingAddress: opts.shipping ?? US_ADDR }),
      ...opts.extra,
    },
  });

export const payWith = (
  u: TestUser,
  orderId: string,
  token: string | null = okToken(),
  k?: string,
): Promise<Res> =>
  u.client.request('POST', `/v1/orders/${orderId}/pay`, {
    headers: idem(k),
    body: token ? { paymentMethod: token } : {},
  });

/** Order + successful payment. Returns the paid order body and payment. */
export async function buy(
  u: TestUser,
  items: unknown[],
  opts: { token?: string; shipping?: unknown | null } = {},
): Promise<{ order: ResponseBody; pay: Res; orderId: string }> {
  const o = await checkout(u, items, { shipping: opts.shipping });
  if (o.status !== 201) throw new Error(`checkout failed: ${o.status} ${JSON.stringify(o.body)}`);
  const pay = await payWith(u, o.body.order.id, opts.token ?? okToken());
  if (pay.status !== 201) throw new Error(`pay failed: ${pay.status} ${JSON.stringify(pay.body)}`);
  return { order: pay.body.order, pay, orderId: o.body.order.id };
}

export interface LedgerLine {
  account: string;
  direction: 'debit' | 'credit';
  amount: number;
}
/** All ledger entries booked for a (kind, ref_type, ref_id) transaction. */
export async function ledgerOf(
  t: TestApp,
  kind: string,
  refType: string,
  refId: string,
): Promise<LedgerLine[]> {
  const { rows } = await t.ctx.db.query<LedgerLine>(
    `SELECT e.account, e.direction, e.amount_cents::bigint AS amount FROM ledger_entries e JOIN ledger_transactions x ON x.id = e.transaction_id
      WHERE x.kind = $1 AND x.ref_type = $2 AND x.ref_id = $3 ORDER BY e.account, e.direction`,
    [kind, refType, refId],
  );
  return rows.map((r) => ({ ...r, amount: Number(r.amount) }));
}

/** Every ledger transaction must have debits == credits (per currency transaction). Returns the offenders. */
export async function unbalancedTransactions(t: TestApp): Promise<unknown[]> {
  const { rows } = await t.ctx.db.query(
    `SELECT transaction_id, sum(CASE WHEN direction = 'debit' THEN amount_cents ELSE 0 END) AS debits, sum(CASE WHEN direction = 'credit' THEN amount_cents ELSE 0 END) AS credits
       FROM ledger_entries GROUP BY transaction_id HAVING sum(CASE WHEN direction = 'debit' THEN amount_cents ELSE -amount_cents END) <> 0`,
  );
  return rows;
}

export const balanceOf = async (t: TestApp, account: string): Promise<number> =>
  Number(
    (
      await t.ctx.db.query(
        `SELECT COALESCE(sum(CASE WHEN direction = 'credit' THEN amount_cents ELSE -amount_cents END), 0)::bigint AS b FROM ledger_entries WHERE account = $1`,
        [account],
      )
    ).rows[0].b,
  );

export const sellerAccount = (id: string, type: 'user' | 'business' = 'user'): string =>
  `seller:${type}:${id}:payable`;
