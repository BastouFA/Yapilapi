import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient } from 'pg';

/**
 * Per-request facts that SQL predicates need but that aren't a query
 * parameter everywhere, such as the country a trusted CDN reports for a
 * logged-out visitor. Set once per request (onRequest hook).
 */
const store = new AsyncLocalStorage<{ country: string | null }>();

/** Run the rest of a request inside its context (everything it awaits inherits it). */
export function runInRequest(country: string | null, next: () => void) {
  store.run({ country: country && /^[A-Z]{2}$/.test(country) ? country : null }, next);
}

/**
 * Placeholder the visibility predicate uses for the request's country. It is
 * replaced right before a query is sent with a validated two-letter literal
 * or NULL, so it can't carry anything else into SQL.
 */
export const REQUEST_COUNTRY = 'ypl__request_country__';

function substitute(text: string): string {
  if (!text.includes(REQUEST_COUNTRY)) return text;
  const c = store.getStore()?.country;
  return text.replaceAll(REQUEST_COUNTRY, c && /^[A-Z]{2}$/.test(c) ? `'${c}'::char(2)` : 'NULL::char(2)');
}

function wrap(target: { query: (...args: any[]) => any }) {
  const original = target.query.bind(target);
  target.query = (...args: any[]) => {
    if (typeof args[0] === 'string') args[0] = substitute(args[0]);
    else if (args[0] && typeof args[0].text === 'string') args[0] = { ...args[0], text: substitute(args[0].text) };
    return original(...args);
  };
}

/** Apply the substitution to a pool and every client it hands out (transactions). */
export function withRequestContext(pool: Pool): Pool {
  wrap(pool as unknown as { query: (...args: any[]) => any });
  pool.on('connect', (client: PoolClient) => wrap(client as unknown as { query: (...args: any[]) => any }));
  return pool;
}
