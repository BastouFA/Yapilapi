import type { Queryable } from '@yapilapi/database';
import type { AppContext } from '../../lib/context.js';
import { hasConsent } from '../privacy/consent.js';
import { validateEvent } from './events.js';

/**
 * Record a SERVER-side analytics event. The privacy rules are enforced here, in one place:
 *  - the name and properties must pass the server allowlist (events.ts)
 *  - an event about a user is only stored if that user currently has the `analytics` consent (teens never do)
 *  - events without a user are allowed only for system-level facts and carry no identifier at all
 * Never throws and never blocks the caller's business flow: failures are logged at debug level.
 * Returns whether an event was stored.
 */
export async function track(
  ctx: AppContext,
  name: string,
  props: Record<string, unknown>,
  opts: { userId?: string | null; db?: Queryable } = {},
): Promise<boolean> {
  const inTx = Boolean(opts.db);
  const db = opts.db ?? ctx.db;
  try {
    const v = validateEvent(name, props, 'server');
    if (!v.ok) {
      ctx.log.debug({ name, reason: v.reason }, 'analytics: server event rejected');
      return false;
    }
    // Inside the caller's transaction a failing statement would poison it: isolate ourselves in a savepoint.
    if (inTx) await db.query('SAVEPOINT yl_analytics');
    try {
      if (opts.userId && !(await hasConsent(ctx, opts.userId, 'analytics', db))) {
        if (inTx) await db.query('RELEASE SAVEPOINT yl_analytics');
        return false;
      }
      await db.query(
        `INSERT INTO analytics_events (user_id, name, properties, source, platform) VALUES ($1,$2,$3,'server','server')`,
        [opts.userId ?? null, v.name, JSON.stringify(v.props)],
      );
      if (inTx) await db.query('RELEASE SAVEPOINT yl_analytics');
    } catch (err) {
      if (inTx) await db.query('ROLLBACK TO SAVEPOINT yl_analytics').catch(() => undefined);
      throw err;
    }
    ctx.metrics.events.inc({ name: `analytics_${name}` });
    return true;
  } catch (err) {
    ctx.log.debug({ err, name }, 'analytics: server event failed');
    return false;
  }
}

/** post_created for a freshly created, approved post (kind and visibility only; never content). Same transaction as the post. */
export async function trackPostCreated(
  ctx: AppContext,
  db: Queryable,
  post: { id: string; authorId: string },
): Promise<void> {
  try {
    if (!(await hasConsent(ctx, post.authorId, 'analytics', db))) return;
    const { rows } = await db.query<{ kind: string; visibility: string }>(
      'SELECT kind, visibility FROM posts WHERE id = $1',
      [post.id],
    );
    if (rows[0])
      await track(
        ctx,
        'post_created',
        { kind: rows[0].kind, visibility: rows[0].visibility },
        { userId: post.authorId, db },
      );
  } catch (err) {
    ctx.log.debug({ err }, 'analytics: post_created skipped');
  }
}

/** Retention job: raw events are kept for ANALYTICS_RETENTION_DAYS, then deleted. Idempotent. */
export async function purgeOldAnalytics(
  ctx: AppContext,
  days: number = ctx.config.ANALYTICS_RETENTION_DAYS,
): Promise<number> {
  const r = await ctx.db.query(
    `DELETE FROM analytics_events WHERE created_at < now() - make_interval(days => $1)`,
    [days],
  );
  return r.rowCount ?? 0;
}
