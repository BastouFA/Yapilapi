import type { FastifyInstance } from 'fastify';
import type { PulseCards, WeeklyWrapSettings } from '@yapilapi/shared';
import { z } from 'zod';
import { badRequest, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { isEnabled } from '../lib/services.ts';
import { currentWrapCard, isKnownTimeZone, listWraps, onThisDay, renderWrapCard, TIMEZONE_SQL, wrapFor } from '../lib/wrap.ts';
import { me, requireAuth } from '../plugins/auth.ts';

const idParam = z.object({ id: z.string().uuid() });

/**
 * The weekly wrap (lib/wrap.ts) and the cards on Pulse. Every wrap is private: only its owner
 * reads it, its card image and its notification. Turning the wrap off stops new ones and hides
 * the Pulse card; past ones stay until deleted.
 */
export default async function wrapsModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;

  async function settings(userId: string): Promise<WeeklyWrapSettings> {
    const { rows } = await db.query(
      `SELECT coalesce(up.weekly_wrap, true) AS enabled, coalesce(up.weekly_wrap_notify, true) AS notify, ${TIMEZONE_SQL('up')} AS timezone
       FROM (SELECT $1::uuid AS id) u LEFT JOIN user_preferences up ON up.user_id = u.id`,
      [userId],
    );
    return { enabled: rows[0].enabled, notify: rows[0].notify, timezone: rows[0].timezone };
  }

  async function saveTimeZone(userId: string, tz: string) {
    await db.query(
      `INSERT INTO user_preferences (user_id, timezone) VALUES ($1,$2)
       ON CONFLICT (user_id) DO UPDATE SET timezone = EXCLUDED.timezone, updated_at = now() WHERE user_preferences.timezone IS DISTINCT FROM EXCLUDED.timezone`,
      [userId, tz],
    );
  }

  app.get('/v1/me/weekly-wrap', { preHandler: requireAuth }, async (req) => ({ settings: await settings(me(req).id) }));

  /** Weekly wrap on or off, its notification on or off, and the time zone Sunday evening is worked out in. */
  app.put('/v1/me/weekly-wrap', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const input = parse(z.object({ enabled: z.boolean().optional(), notify: z.boolean().optional(), timezone: z.string().max(64).optional() }), req.body);
    if (input.timezone !== undefined && !(await isKnownTimeZone(db, input.timezone))) throw badRequest('That time zone isn’t recognized.');
    await db.query(`INSERT INTO user_preferences (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [u.id]);
    await db.query(
      `UPDATE user_preferences SET weekly_wrap = coalesce($2, weekly_wrap), weekly_wrap_notify = coalesce($3, weekly_wrap_notify),
         timezone = coalesce($4, timezone), updated_at = now() WHERE user_id = $1`,
      [u.id, input.enabled ?? null, input.notify ?? null, input.timezone ?? null],
    );
    return { settings: await settings(u.id) };
  });

  /**
   * The gentle cards at the top of Pulse: this week's wrap (for a few days, unless put away) and
   * "On this day" (your own posts from this day in earlier years; it links to Memories, so only
   * when Memories is on). `tz` is the device's time zone, saved for the weekly wrap.
   */
  app.get('/v1/me/pulse-cards', { preHandler: requireAuth }, async (req): Promise<PulseCards> => {
    const u = me(req);
    const { tz } = parse(z.object({ tz: z.string().max(64).optional() }), req.query);
    if (tz && (await isKnownTimeZone(db, tz))) await saveTimeZone(u.id, tz);
    const s = await settings(u.id);
    return {
      wrap: s.enabled ? await currentWrapCard(db, u.id) : null,
      onThisDay: (await isEnabled(db, 'MEMORY')) ? await onThisDay(db, u.id, s.timezone) : null,
    };
  });

  app.get('/v1/wraps', { preHandler: requireAuth }, async (req) => ({ items: await listWraps(db, me(req).id) }));

  app.get('/v1/wraps/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    const wrap = await wrapFor(db, id, me(req).id);
    if (!wrap) throw notFound('Weekly wrap');
    return { wrap };
  });

  /** The shareable card image, drawn on request (only for the wrap's owner; never cached by others). */
  app.get('/v1/wraps/:id/card.png', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const png = await renderWrapCard(db, ctx.storage, id, me(req).id);
    if (!png) throw notFound('Weekly wrap');
    return reply
      .header('content-type', 'image/png')
      .header('cache-control', 'private, max-age=300')
      .header('content-disposition', `inline; filename="yapilapi-week.png"`)
      .send(png);
  });

  /** Put the card on Pulse away. The wrap stays in your wraps. */
  app.post('/v1/wraps/:id/dismiss', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    const r = await db.query(`UPDATE weekly_wraps SET dismissed_at = coalesce(dismissed_at, now()) WHERE id = $1 AND user_id = $2 AND NOT empty`, [
      id,
      me(req).id,
    ]);
    if (!r.rowCount) throw notFound('Weekly wrap');
    return { ok: true };
  });

  app.delete('/v1/wraps/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    // Kept as an empty week so it isn't made again.
    const r = await db.query(`UPDATE weekly_wraps SET empty = true, summary = '{}', moment_post_id = NULL WHERE id = $1 AND user_id = $2 AND NOT empty`, [
      id,
      me(req).id,
    ]);
    if (!r.rowCount) throw notFound('Weekly wrap');
    await db.query(`DELETE FROM notifications WHERE user_id = $1 AND entity_type = 'wrap' AND entity_id = $2`, [me(req).id, id]);
    return { ok: true };
  });
}
