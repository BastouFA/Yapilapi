import { badRequest } from './errors.ts';

/** Keyset cursor over (created_at, id), opaque to clients. */
export interface KeyCursor {
  t: string;
  id: string;
}

export function encodeCursor(c: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A moment as the cursors write it: an ISO string, or Postgres text ("2026-09-29 07:00:00.123+00"). */
const MOMENT = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/;

/**
 * Whether the fields a cursor has are the kind the queries expect, so a cursor someone made up
 * is refused with a 400 instead of failing in the database: `t` and `asOf` are moments, `id` a
 * UUID (or the number of a table counted by bigserial), `o` an offset from 0, `p` a position and
 * `s` a kept feed order (a UUID).
 */
function wellFormed(c: unknown): boolean {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return false;
  const o = c as Record<string, unknown>;
  const moment = (v: unknown) => typeof v === 'string' && MOMENT.test(v) && !Number.isNaN(Date.parse(v.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')));
  if ('t' in o && !moment(o.t)) return false;
  if ('asOf' in o && !moment(o.asOf)) return false;
  if ('id' in o && !((typeof o.id === 'string' && (UUID.test(o.id) || /^\d{1,18}$/.test(o.id))) || (typeof o.id === 'number' && Number.isSafeInteger(o.id))))
    return false;
  if ('o' in o && !(typeof o.o === 'number' && Number.isSafeInteger(o.o) && o.o >= 0)) return false;
  if ('p' in o && !(typeof o.p === 'number' && Number.isSafeInteger(o.p))) return false;
  if ('s' in o && !(typeof o.s === 'string' && UUID.test(o.s))) return false;
  return true;
}

export function decodeCursor<T = KeyCursor>(s: string | undefined): T | null {
  if (!s) return null;
  let c: unknown;
  try {
    c = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
  } catch {
    throw badRequest('Invalid cursor.');
  }
  if (!wellFormed(c)) throw badRequest('Invalid cursor.');
  return c as T;
}

export function keyCursorOf(row: { created_at: Date | string; id: string }): string {
  const t = row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at;
  return encodeCursor({ t, id: row.id });
}
