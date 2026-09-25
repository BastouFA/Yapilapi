import type { AppContext } from '../../lib/context.js';
import {
  categoryFor,
  shouldDeliver,
  type NotificationCategory,
} from '../../lib/notification-policy.js';
import { CATEGORY_LABELS } from './service.js';

export interface DigestOptions {
  now?: Date;
  /** Users processed per run. */
  limit?: number;
  /** At most one digest per user in this window. */
  minIntervalHours?: number;
  /** Only notifications newer than this are included; older ones are left alone. */
  lookbackDays?: number;
}
export interface DigestResult {
  users: number;
  sent: number;
  notifications: number;
  skipped: number;
  failed: number;
}

/**
 * Email digests of UNREAD notifications, for users who opted in to the email channel for a category (defaults: only
 * security and moderation notices are emailed). The same `shouldDeliver` policy that governs push decides which
 * notifications may be emailed, so quiet hours, pause and focus mode apply here too.
 *
 * Privacy: the email contains counts per category and a link, never message text, names or other content.
 * Idempotency: notifications are claimed (`emailed_at`) before sending and released if sending fails, so overlapping
 * runs never send the same item twice, and a user gets at most one digest per `minIntervalHours`.
 */
export async function sendEmailDigests(
  ctx: AppContext,
  opts: DigestOptions = {},
): Promise<DigestResult> {
  const now = opts.now ?? new Date();
  const result: DigestResult = { users: 0, sent: 0, notifications: 0, skipped: 0, failed: 0 };
  const candidates = await ctx.db.query<{ id: string; email: string }>(
    `SELECT u.id, u.email::text AS email
       FROM users u
      WHERE u.status = 'active' AND u.deleted_at IS NULL AND u.email_verified_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = u.id AND n.read_at IS NULL AND n.emailed_at IS NULL AND n.created_at > $1::timestamptz - make_interval(days => $3))
        AND NOT EXISTS (SELECT 1 FROM email_digest_log l WHERE l.user_id = u.id AND l.sent_at > $1::timestamptz - make_interval(hours => $4))
      ORDER BY u.id LIMIT $2`,
    [now, opts.limit ?? 200, opts.lookbackDays ?? 7, opts.minIntervalHours ?? 20],
  );

  for (const u of candidates.rows) {
    result.users += 1;
    const items = await ctx.db.query<{ id: string; kind: string }>(
      `SELECT id, kind FROM notifications WHERE user_id = $1 AND read_at IS NULL AND emailed_at IS NULL AND created_at > $2::timestamptz - make_interval(days => $3)
        ORDER BY created_at DESC LIMIT 200`,
      [u.id, now, opts.lookbackDays ?? 7],
    );
    const decisionByKind = new Map<string, boolean>();
    const eligible: Array<{ id: string; category: NotificationCategory }> = [];
    for (const n of items.rows) {
      if (!decisionByKind.has(n.kind))
        decisionByKind.set(n.kind, (await shouldDeliver(ctx, u.id, n.kind, now)).email);
      if (decisionByKind.get(n.kind)) eligible.push({ id: n.id, category: categoryFor(n.kind) });
    }
    if (!eligible.length) {
      result.skipped += 1;
      continue;
    }
    const claimed = await ctx.db.query<{ id: string }>(
      `UPDATE notifications SET emailed_at = $2 WHERE id = ANY($1::uuid[]) AND emailed_at IS NULL AND read_at IS NULL RETURNING id`,
      [eligible.map((e) => e.id), now],
    );
    const claimedIds = new Set(claimed.rows.map((r) => r.id));
    const counts = new Map<NotificationCategory, number>();
    for (const e of eligible)
      if (claimedIds.has(e.id)) counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
    const total = claimedIds.size;
    if (!total) continue; // someone else got there first

    const lines = [...counts].map(([c, n]) => `  - ${CATEGORY_LABELS[c]}: ${n}`);
    try {
      await ctx.email.send({
        to: u.email,
        subject:
          total === 1
            ? 'You have 1 unread notification on YAPILAPI'
            : `You have ${total} unread notifications on YAPILAPI`,
        text: [
          'Here is what you have not seen yet:',
          '',
          ...lines,
          '',
          `Open YAPILAPI: ${ctx.config.WEB_PUBLIC_URL}/notifications`,
          `Change which emails you get: ${ctx.config.WEB_PUBLIC_URL}/settings/notifications`,
        ].join('\n'),
      });
      await ctx.db.query(
        'INSERT INTO email_digest_log (user_id, item_count, sent_at) VALUES ($1,$2,$3)',
        [u.id, total, now],
      );
      result.sent += 1;
      result.notifications += total;
    } catch (err) {
      ctx.log.warn({ err, userId: u.id }, 'digest email failed; releasing notifications');
      await ctx.db.query('UPDATE notifications SET emailed_at = NULL WHERE id = ANY($1::uuid[])', [
        [...claimedIds],
      ]);
      result.failed += 1;
    }
  }
  return result;
}
