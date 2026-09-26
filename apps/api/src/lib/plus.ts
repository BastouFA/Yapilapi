import type { Pool, PoolClient } from 'pg';

type Q = Pool | PoolClient;

/** One purchase or one referral reward is 30 days of Plus. Nothing renews on its own. */
export const PLUS_DAYS = 30;
/** How far ahead Plus can be bought, so nobody stacks years by accident. */
export const PLUS_MAX_AHEAD_DAYS = 365;

/** Reel length: 3 minutes, or 10 minutes with Plus. */
export const REEL_MAX_MS = 180_000;
export const PLUS_REEL_MAX_MS = 600_000;

/** Resumable uploads (large files, mostly video): 200 MB, or 500 MB with Plus. */
export const MAX_RESUMABLE_BYTES = 200 * 1024 * 1024;
export const PLUS_MAX_RESUMABLE_BYTES = 500 * 1024 * 1024;

export async function isPlus(db: Q, userId: string): Promise<boolean> {
  const { rows } = await db.query<{ plus: boolean | null }>(`SELECT plus_until > now() AS plus FROM profiles WHERE user_id = $1`, [userId]);
  return rows[0]?.plus === true;
}

/**
 * Add a period of Plus, starting when the current one ends (or now). Each paid
 * order and each referral batch is granted once: a replayed webhook or a
 * second reward check does nothing. Returns the new end date, or null when
 * this grant already exists. Call inside a transaction.
 */
export async function grantPlus(
  c: PoolClient,
  userId: string,
  source: 'purchase' | 'referral',
  ref: { orderId?: string; referralBatch?: number },
  days = PLUS_DAYS,
): Promise<Date | null> {
  const cur = await c.query<{ start: Date }>(`SELECT greatest(coalesce(plus_until, now()), now()) AS start FROM profiles WHERE user_id = $1 FOR UPDATE`, [
    userId,
  ]);
  if (!cur.rows[0]) return null;
  const ins = await c.query<{ ends_at: Date }>(
    `INSERT INTO plus_grants (user_id, source, days, order_id, referral_batch, starts_at, ends_at)
     VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $6::timestamptz + make_interval(days => $3))
     ON CONFLICT DO NOTHING RETURNING ends_at`,
    [userId, source, days, ref.orderId ?? null, ref.referralBatch ?? null, cur.rows[0].start],
  );
  const endsAt = ins.rows[0]?.ends_at;
  if (!endsAt) return null;
  await c.query(`UPDATE profiles SET plus_until = $2 WHERE user_id = $1`, [userId, endsAt]);
  return endsAt;
}

/** A refunded Plus purchase takes its days back. */
export async function revokePlusForOrder(c: PoolClient, orderId: string): Promise<void> {
  const g = await c.query<{ user_id: string; days: number }>(
    `UPDATE plus_grants SET revoked_at = now() WHERE order_id = $1 AND revoked_at IS NULL RETURNING user_id, days`,
    [orderId],
  );
  const row = g.rows[0];
  if (!row) return;
  await c.query(
    `UPDATE profiles SET plus_until = CASE WHEN plus_until - make_interval(days => $2) > now() THEN plus_until - make_interval(days => $2) ELSE now() END
     WHERE user_id = $1 AND plus_until IS NOT NULL`,
    [row.user_id, row.days],
  );
}
