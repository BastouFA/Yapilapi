import pg from 'pg';

export { migrate, ensureDatabase } from './migrate.ts';

// Return bigint counts and ids as numbers where safe; timestamps stay Date objects.
pg.types.setTypeParser(20, (v) => Number(v));

export type Db = pg.Pool;
export type DbClient = pg.PoolClient | pg.Pool;

/**
 * Connection pool for request handling. A query never waits forever: a
 * connection dropped silently (a proxy or container port forward going away)
 * fails within a minute instead of hanging until the OS gives up on TCP.
 */
export function createPool(connectionString: string, max = 10): pg.Pool {
  return new pg.Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    statement_timeout: 60_000,
    query_timeout: 65_000,
  });
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
