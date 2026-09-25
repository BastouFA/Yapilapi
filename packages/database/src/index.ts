import pg from 'pg';

export { migrate, ensureDatabase } from './migrate.ts';

// Return bigint counts and ids as numbers where safe; timestamps stay Date objects.
pg.types.setTypeParser(20, (v) => Number(v));

export type Db = pg.Pool;
export type DbClient = pg.PoolClient | pg.Pool;

export function createPool(connectionString: string, max = 10): pg.Pool {
  // JIT off: our queries are short OLTP reads and writes. On larger tables the planner's
  // cost estimate for the ranked feed crosses jit_above_cost and Postgres spent over a
  // second compiling a query that runs in a fraction of that (docs/architecture/performance.md).
  return new pg.Pool({ connectionString, max, idleTimeoutMillis: 30_000, options: '-c jit=off' });
}

/** Run fn inside a transaction; rolls back on any thrown error. */
export async function tx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
