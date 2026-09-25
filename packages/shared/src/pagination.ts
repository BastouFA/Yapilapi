import { AppError } from './errors.js';

/** Opaque, URL-safe cursor. Never trusted for authorization, only for position. */
export function encodeCursor(payload: Record<string, string | number | null>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor<T extends Record<string, string | number | null>>(
  cursor: string | undefined,
): T | null {
  if (!cursor) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      throw new Error('shape');
    return parsed as T;
  } catch {
    throw new AppError('validation_failed', 'Invalid cursor');
  }
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;
export const clampLimit = (n: number | undefined) =>
  Math.min(Math.max(Math.trunc(n ?? DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE);
