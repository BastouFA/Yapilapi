import { badRequest } from './errors.ts';

/** Keyset cursor over (created_at, id), opaque to clients. */
export interface KeyCursor {
  t: string;
  id: string;
}

export function encodeCursor(c: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

export function decodeCursor<T = KeyCursor>(s: string | undefined): T | null {
  if (!s) return null;
  try {
    return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as T;
  } catch {
    throw badRequest('Invalid cursor.');
  }
}

export function keyCursorOf(row: { created_at: Date | string; id: string }): string {
  const t = row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at;
  return encodeCursor({ t, id: row.id });
}
