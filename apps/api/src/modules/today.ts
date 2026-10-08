import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TODAY_HOURS, type TodayBriefing, type TodaySettings } from '@yapilapi/shared';
import type { AppContext } from '../lib/context.ts';
import { badRequest, notFound, parse } from '../lib/errors.ts';
import { dismissToday, notInterested, todayAvailable, todayById, todayFor, todaySettings, type TodayDeps } from '../lib/today.ts';
import { isKnownTimeZone } from '../lib/wrap.ts';
import { me, requireAuth } from '../plugins/auth.ts';

const idParam = z.object({ id: z.string().uuid() });

/**
 * Yapilapi Today (lib/today.ts, docs/product/yapilapi-today.md): the morning briefing on Pulse,
 * "Not interested in this", and its settings. Every briefing is private to its owner.
 */
export default async function todayModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;
  // Read when asked, so the configuration (and tests' stand-ins) apply.
  const deps = (): TodayDeps => ({
    db,
    storage: ctx.storage,
    speech: ctx.speech,
    realtime: ctx.realtime,
    provider: ctx.ai.briefer,
    config: ctx.config,
  });

  async function saveTimeZone(userId: string, tz: string | undefined) {
    if (!tz || !(await isKnownTimeZone(db, tz))) return;
    await db.query(
      `INSERT INTO user_preferences (user_id, timezone) VALUES ($1,$2)
       ON CONFLICT (user_id) DO UPDATE SET timezone = EXCLUDED.timezone, updated_at = now() WHERE user_preferences.timezone IS DISTINCT FROM EXCLUDED.timezone`,
      [userId, tz],
    );
  }

  /**
   * This morning's Today: segments with their text, the address of each one read aloud (when
   * listening is set up), and the posts each is about (a Yap's own clip with it). `today: null`
   * when there's none to show. `tz` is the device's time zone. Made here the first time it's
   * asked for when the morning sweep didn't make it.
   */
  app.get(
    '/v1/today',
    { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req): Promise<{ today: TodayBriefing | null }> => {
      const u = me(req);
      const { tz } = parse(z.object({ tz: z.string().max(64).optional() }), req.query);
      if (!(await todayAvailable(deps()))) return { today: null };
      await saveTimeZone(u.id, tz);
      return { today: await todayFor(deps(), u.id) };
    },
  );

  /** One of your briefings by id (what Yap Radio plays). */
  app.get('/v1/today/:id', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const today = (await todayAvailable(deps())) ? await todayById(db, me(req).id, id) : null;
    if (!today) throw notFound();
    return { today };
  });

  /** "Not interested in this": the segment goes, and what it was about stays out of your next Todays. */
  app.post(
    '/v1/today/:id/segments/:index/not-interested',
    { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req) => {
      const { id, index } = parse(idParam.extend({ index: z.coerce.number().int().min(0).max(20) }), req.params);
      const u = me(req);
      if (!(await notInterested(db, u.id, id, index))) throw notFound();
      return { today: await todayById(db, u.id, id) };
    },
  );

  /** "Hide": no card until tomorrow's Today. */
  app.post('/v1/today/:id/dismiss', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    if (!(await dismissToday(db, me(req).id, id))) throw notFound();
    return { ok: true };
  });

  app.get('/v1/me/today', { preHandler: requireAuth }, async (req): Promise<{ settings: TodaySettings }> => ({
    settings: await todaySettings(db, me(req).id),
  }));

  /** Today on or off, from which hour, with your city or not, and "Your Today is ready". */
  app.put(
    '/v1/me/today',
    { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 hour' } } },
    async (req): Promise<{ settings: TodaySettings }> => {
      const u = me(req);
      const input = parse(
        z.object({
          enabled: z.boolean().optional(),
          hour: z
            .number()
            .int()
            .refine((h) => (TODAY_HOURS as readonly number[]).includes(h))
            .optional(),
          city: z.boolean().optional(),
          notify: z.boolean().optional(),
          timezone: z.string().max(64).optional(),
        }),
        req.body,
      );
      if (input.timezone !== undefined && !(await isKnownTimeZone(db, input.timezone))) throw badRequest('That time zone isn’t recognized.');
      await db.query(
        `INSERT INTO user_preferences (user_id, today, today_hour, today_city, today_notify, timezone) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_id) DO UPDATE SET today = coalesce($2, user_preferences.today), today_hour = coalesce($3, user_preferences.today_hour),
         today_city = coalesce($4, user_preferences.today_city), today_notify = coalesce($5, user_preferences.today_notify),
         timezone = coalesce($6, user_preferences.timezone), updated_at = now()`,
        [u.id, input.enabled ?? null, input.hour ?? null, input.city ?? null, input.notify ?? null, input.timezone ?? null],
      );
      return { settings: await todaySettings(db, u.id) };
    },
  );
}
