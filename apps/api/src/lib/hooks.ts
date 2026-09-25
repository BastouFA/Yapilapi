import type { PoolClient } from 'pg';
import type { AppContext } from './context.js';

export type UserDeletionHook = (ctx: AppContext, tx: PoolClient, userId: string) => Promise<void>;

const deletionHooks: UserDeletionHook[] = [];

/** Modules that own user data register a hook so account deletion can anonymize/remove it. */
export function registerDeletionHook(hook: UserDeletionHook): void {
  deletionHooks.push(hook);
}
export const getDeletionHooks = (): readonly UserDeletionHook[] => deletionHooks;
