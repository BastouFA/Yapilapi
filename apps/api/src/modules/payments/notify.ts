import type { AppContext } from '../../lib/context.js';
import { notify } from '../../lib/notify.js';
import { teamWith } from '../business/service.js';
import type { Payee } from './ledger.js';

/** Tell a seller (the individual, or everyone on the business team who handles orders) about something. Never throws. */
export async function notifySeller(
  ctx: AppContext,
  seller: Payee,
  n: {
    kind: string;
    actorId?: string | null;
    targetType: string;
    targetId: string;
    data?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    const users =
      seller.type === 'user' ? [seller.id] : await teamWith(ctx.db, seller.id, 'bookings.manage');
    for (const userId of users)
      await notify(ctx, {
        userId,
        kind: n.kind,
        actorId: n.actorId ?? null,
        targetType: n.targetType,
        targetId: n.targetId,
        data: n.data ?? {},
      });
  } catch (err) {
    ctx.log.warn({ err: (err as Error).message }, 'seller notification failed');
  }
}

export async function notifyUser(
  ctx: AppContext,
  userId: string,
  n: {
    kind: string;
    actorId?: string | null;
    targetType: string;
    targetId: string;
    data?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await notify(ctx, {
      userId,
      kind: n.kind,
      actorId: n.actorId ?? null,
      targetType: n.targetType,
      targetId: n.targetId,
      data: n.data ?? {},
    });
  } catch (err) {
    ctx.log.warn({ err: (err as Error).message }, 'notification failed');
  }
}
