import type { Queryable } from '@yapilapi/database';
import { evaluateFraud, type FraudInput, type FraudResult } from '@yapilapi/payments';

export interface SignalContext {
  userId: string;
  ipHash: string | null;
  amountMinor: number;
  currency: string;
  shippingCountry?: string | null | undefined;
  cardFingerprint?: string | null | undefined;
  cardCountry?: string | null | undefined;
}

/** Collect the counters the pure rules engine needs. Everything is derived from our own tables: no third-party data, no card data. */
export async function gatherFraudInput(
  db: Queryable,
  s: SignalContext,
  now: Date = new Date(),
): Promise<FraudInput> {
  const { rows: u } = await db.query<{ created_at: Date; country_code: string | null }>(
    'SELECT created_at, country_code FROM users WHERE id = $1',
    [s.userId],
  );
  const since1h = new Date(now.getTime() - 3_600_000);
  const since24h = new Date(now.getTime() - 86_400_000);
  const [orders, failed, avg, ip, fp] = await Promise.all([
    db.query<{ h: number; d: number }>(
      `SELECT count(*) FILTER (WHERE created_at > $2)::int AS h, count(*)::int AS d FROM orders WHERE buyer_id = $1 AND created_at > $3`,
      [s.userId, since1h, since24h],
    ),
    db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM payments WHERE payer_id = $1 AND status = 'failed' AND created_at > $2`,
      [s.userId, since24h],
    ),
    db.query<{ avg: string | null; n: number }>(
      `SELECT avg(total_cents)::float8 AS avg, count(*)::int AS n FROM orders
        WHERE buyer_id = $1 AND currency = $2 AND status IN ('paid','fulfilled','completed','partially_refunded')`,
      [s.userId, s.currency],
    ),
    s.ipHash
      ? db.query<{ n: number }>(
          `SELECT count(DISTINCT uid)::int AS n FROM (
             SELECT buyer_id AS uid FROM orders WHERE ip_hash = $1 AND created_at > $3
             UNION SELECT payer_id FROM payments WHERE ip_hash = $1 AND created_at > $3) x WHERE uid <> $2`,
          [s.ipHash, s.userId, since24h],
        )
      : { rows: [{ n: 0 }] },
    s.cardFingerprint
      ? db.query<{ n: number }>(
          `SELECT count(DISTINCT payer_id)::int AS n FROM payments WHERE card_fingerprint = $1 AND payer_id <> $2 AND created_at > $3`,
          [s.cardFingerprint, s.userId, since24h],
        )
      : { rows: [{ n: 0 }] },
  ]);
  return {
    amountMinor: s.amountMinor,
    currency: s.currency,
    accountAgeHours: u[0] ? (now.getTime() - u[0].created_at.getTime()) / 3_600_000 : 0,
    user: {
      ordersLastHour: orders.rows[0]!.h,
      ordersLast24h: orders.rows[0]!.d,
      failedPaymentsLast24h: failed.rows[0]!.n,
      avgPaidOrderMinor: avg.rows[0]!.avg === null ? null : Math.round(Number(avg.rows[0]!.avg)),
      paidOrders: avg.rows[0]!.n,
    },
    network: { ipDistinctUsers24h: ip.rows[0]!.n, fingerprintDistinctUsers24h: fp.rows[0]!.n },
    geo: {
      accountCountry: u[0]?.country_code ?? null,
      shippingCountry: s.shippingCountry ?? null,
      cardCountry: s.cardCountry ?? null,
    },
  };
}

export interface Assessment {
  input: FraudInput;
  result: FraudResult;
}

export async function assess(db: Queryable, s: SignalContext): Promise<Assessment> {
  const input = await gatherFraudInput(db, s);
  return { input, result: evaluateFraud(input) };
}

/** Persist what the engine saw and decided (counters and country codes only). Blocked attempts have no subject. */
export async function storeSignal(
  db: Queryable,
  s: SignalContext & {
    stage: 'checkout' | 'payment';
    subjectType: 'order' | 'payment';
    subjectId?: string | null;
  },
  a: Assessment,
): Promise<void> {
  await db.query(
    `INSERT INTO fraud_signals (user_id, subject_type, subject_id, stage, decision, score, reasons, signals, ip_hash, card_fingerprint)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      s.userId,
      s.subjectType,
      s.subjectId ?? null,
      s.stage,
      a.result.decision,
      a.result.score,
      JSON.stringify(a.result.reasons),
      JSON.stringify({
        user: a.input.user,
        network: a.input.network,
        geo: a.input.geo,
        accountAgeHours: Math.round(a.input.accountAgeHours),
        amountMinor: a.input.amountMinor,
        currency: a.input.currency,
      }),
      s.ipHash,
      s.cardFingerprint ?? null,
    ],
  );
}
