import type { T } from '@/i18n';

/**
 * Call the translator with a key assembled at runtime (e.g. `places.kind.${kind}`), for the cases where the exact
 * literal union of possible keys cannot be threaded through TypeScript's generic inference for `t()`. Behaves exactly
 * like `t`: an unknown key falls back to itself. Prefer calling `t` directly with a literal key everywhere else.
 */
export function tKey(t: T, key: string, params?: Record<string, string | number>): string {
  return (t as unknown as (k: string, p?: Record<string, string | number>) => string)(key, params);
}
