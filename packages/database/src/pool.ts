import pg from 'pg';

const { Pool, types } = pg;

// Return bigint (int8) as number when safe; counters and ids we use never exceed 2^53.
types.setTypeParser(20, (v: string) => Number(v));

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = Pick<pg.Pool, 'query'>;

export function createPool(connectionString: string, opts: { max?: number } = {}): Db {
  return new Pool({ connectionString, max: opts.max ?? 10, idleTimeoutMillis: 30_000 });
}

/** Run `fn` in a transaction. Rolls back on throw. */
export async function withTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection already broken; original error is what matters */
    }
    throw err;
  } finally {
    client.release();
  }
}
