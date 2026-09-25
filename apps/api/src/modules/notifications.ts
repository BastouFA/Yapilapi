import type { FastifyInstance } from 'fastify';
import { attentionSchema, NOTIFICATION_CATEGORIES, notificationPrefsSchema, pageQuerySchema, type NotificationItem } from '@yapilapi/shared';
import { parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { decodeCursor, keyCursorOf, type KeyCursor } from '../lib/cursor.ts';
import { publicUserFrom } from '../lib/users.ts';
import { me, requireAuth } from '../plugins/auth.ts';

export default async function notificationsModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;

  app.get('/v1/notifications', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const q = parse(pageQuerySchema, req.query);
    const c = decodeCursor<KeyCursor>(q.cursor);
    const { rows } = await db.query(
      `SELECT n.id, n.category, n.type, n.entity_type, n.entity_id, n.data, n.read_at, n.created_at,
              pr.user_id AS a_id, pr.username AS a_username, pr.display_name AS a_display_name, pr.avatar_url AS a_avatar_url, pr.mode AS a_mode
       FROM notifications n LEFT JOIN profiles pr ON pr.user_id = n.actor_id
       WHERE n.user_id = $1 ${c ? 'AND (n.created_at, n.id) < ($3::timestamptz, $4::uuid)' : ''}
       ORDER BY n.created_at DESC, n.id DESC LIMIT $2`,
      c ? [u.id, q.limit + 1, c.t, c.id] : [u.id, q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    const unread = (await db.query(`SELECT count(*) AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL`, [u.id])).rows[0].n;
    const items: NotificationItem[] = page.map((r) => ({
      id: r.id,
      category: r.category,
      type: r.type,
      actor: r.a_id ? publicUserFrom(r, 'a_') : null,
      entityType: r.entity_type,
      entityId: r.entity_id,
      data: r.data,
      readAt: r.read_at?.toISOString() ?? null,
      createdAt: r.created_at.toISOString(),
    }));
    return { items, unread, nextCursor: rows.length > q.limit ? keyCursorOf(page.at(-1)!) : null };
  });

  app.post('/v1/notifications/read', { preHandler: requireAuth }, async (req) => {
    const body = (req.body ?? {}) as { ids?: string[] };
    if (body.ids?.length) await db.query(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2::uuid[]) AND read_at IS NULL`, [me(req).id, body.ids]);
    else await db.query(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`, [me(req).id]);
    return { ok: true };
  });

  app.get('/v1/me/preferences', { preHandler: requireAuth }, async (req) => {
    const { rows } = await db.query(`SELECT * FROM user_preferences WHERE user_id = $1`, [me(req).id]);
    const p = rows[0] ?? {};
    return {
      notifications: Object.fromEntries(NOTIFICATION_CATEGORIES.map((c) => [c, p.notification_categories?.[c] !== false])),
      attention: {
        focusMode: !!p.focus_mode,
        quietMode: !!p.quiet_mode,
        friendsOnly: !!p.friends_only,
        reducedRecommendations: !!p.reduced_recommendations,
        dailyTimeBudgetMinutes: p.daily_time_budget_minutes ?? null,
        notificationsPausedUntil: p.notifications_paused_until ?? null,
      },
    };
  });

  app.put('/v1/me/preferences/notifications', { preHandler: requireAuth }, async (req) => {
    const { categories } = parse(notificationPrefsSchema, req.body);
    // Security notifications can't be turned off.
    const clean = Object.fromEntries(Object.entries(categories).filter(([k]) => (NOTIFICATION_CATEGORIES as readonly string[]).includes(k) && k !== 'security'));
    await db.query(
      `INSERT INTO user_preferences (user_id, notification_categories) VALUES ($1,$2)
       ON CONFLICT (user_id) DO UPDATE SET notification_categories = user_preferences.notification_categories || EXCLUDED.notification_categories, updated_at = now()`,
      [me(req).id, clean],
    );
    return { ok: true };
  });

  /** Attention controls: focus, quiet, friends-only, time budget, reduced recommendations, pause. */
  app.put('/v1/me/preferences/attention', { preHandler: requireAuth }, async (req) => {
    const a = parse(attentionSchema, req.body);
    await db.query(`INSERT INTO user_preferences (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [me(req).id]);
    await db.query(
      `UPDATE user_preferences SET
         focus_mode = coalesce($2, focus_mode), quiet_mode = coalesce($3, quiet_mode), friends_only = coalesce($4, friends_only),
         reduced_recommendations = coalesce($5, reduced_recommendations),
         daily_time_budget_minutes = CASE WHEN $6::boolean THEN $7 ELSE daily_time_budget_minutes END,
         notifications_paused_until = CASE WHEN $8::boolean THEN $9::timestamptz ELSE notifications_paused_until END,
         updated_at = now()
       WHERE user_id = $1`,
      [
        me(req).id, a.focusMode ?? null, a.quietMode ?? null, a.friendsOnly ?? null, a.reducedRecommendations ?? null,
        a.dailyTimeBudgetMinutes !== undefined, a.dailyTimeBudgetMinutes ?? null,
        a.notificationsPausedUntil !== undefined, a.notificationsPausedUntil ?? null,
      ],
    );
    return { ok: true };
  });
}
