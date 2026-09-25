import type { FastifyInstance } from 'fastify';
import { tx } from '@yapilapi/database';
import { z } from 'zod';
import { AppError, badRequest, forbidden, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { activeControls } from '../lib/family.ts';
import { audit, notify } from '../lib/services.ts';
import { ageOf, isBlockedEitherWay, usersByIds } from '../lib/users.ts';
import { me, requireAuth } from '../plugins/auth.ts';

const TIMEZONES = new Set(Intl.supportedValuesOf('timeZone').concat('UTC'));
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM.');

/**
 * Family links: an adult guardian and a teen (13 to 17) link accounts once the
 * teen accepts. The guardian sets who the teen can message, a daily time
 * reminder and quiet hours, and sees daily minutes. Guardians never see
 * messages, posts in private spaces or search history. Either side can end
 * the link; the other is told.
 */
export default async function familyModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;

  async function link(id: string) {
    const r = (await db.query(`SELECT * FROM family_links WHERE id = $1`, [id])).rows[0];
    if (!r) throw notFound('Family link');
    return r;
  }

  app.post('/v1/family/invite', { preHandler: requireAuth, config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    const { username } = parse(z.object({ username: z.string().trim().min(1).max(40) }), req.body);
    const guardianAge = ageOf(u.birthDate ?? null);
    if (guardianAge === null || guardianAge < 18) throw forbidden('Only adults can supervise an account.');
    const teen = (
      await db.query(
        `SELECT u.id, u.birth_date FROM users u JOIN profiles p ON p.user_id = u.id WHERE lower(p.username) = lower($1) AND u.status = 'active' AND u.deleted_at IS NULL`,
        [username],
      )
    ).rows[0];
    if (!teen) throw notFound('That person');
    if (teen.id === u.id) throw badRequest("You can't supervise yourself.");
    const teenAge = ageOf(teen.birth_date);
    if (teenAge === null || teenAge >= 18) throw badRequest('Supervision is for accounts under 18.');
    if (await isBlockedEitherWay(db, u.id, teen.id)) throw forbidden();
    const open = await db.query(`SELECT count(*) AS n FROM family_links WHERE teen_id = $1 AND status IN ('pending','active')`, [teen.id]);
    if (Number(open.rows[0].n) >= 2) throw new AppError(409, 'conflict', 'This account already has two guardians.');
    const { rows } = await db
      .query(`INSERT INTO family_links (guardian_id, teen_id) VALUES ($1,$2) RETURNING id, status`, [u.id, teen.id])
      .catch((e) => {
        if (e.code === '23505') throw new AppError(409, 'conflict', "You've already invited this account.");
        throw e;
      });
    await notify(db, ctx.realtime, { userId: teen.id, category: 'security', type: 'family_invite', actorId: u.id, entityType: 'family_link', entityId: rows[0].id });
    await audit(db, { actorId: u.id, action: 'family.invite', entityType: 'family_link', entityId: rows[0].id });
    reply.code(201);
    return { link: rows[0] };
  });

  app.get('/v1/family', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { rows } = await db.query(
      `SELECT fl.id, fl.guardian_id, fl.teen_id, fl.status, fl.created_at, fl.accepted_at,
              tc.messages_from, tc.daily_limit_minutes, to_char(tc.quiet_start, 'HH24:MI') AS quiet_start, to_char(tc.quiet_end, 'HH24:MI') AS quiet_end, tc.timezone
       FROM family_links fl LEFT JOIN teen_controls tc ON tc.teen_id = fl.teen_id
       WHERE (fl.guardian_id = $1 OR fl.teen_id = $1) AND fl.status IN ('pending','active') ORDER BY fl.created_at`,
      [u.id],
    );
    const users = await usersByIds(db, [...new Set(rows.flatMap((r) => [r.guardian_id, r.teen_id]))]);
    const teenIds = rows.filter((r) => r.guardian_id === u.id && r.status === 'active').map((r) => r.teen_id);
    const usage = teenIds.length
      ? (
          await db.query(`SELECT user_id, day, minutes FROM usage_days WHERE user_id = ANY($1) AND day > current_date - 7 ORDER BY day`, [teenIds])
        ).rows
      : [];
    return {
      items: rows.map((r) => ({
        id: r.id,
        role: r.guardian_id === u.id ? 'guardian' : 'teen',
        status: r.status,
        guardian: users.get(r.guardian_id) ?? null,
        teen: users.get(r.teen_id) ?? null,
        controls:
          r.status === 'active'
            ? { messagesFrom: r.messages_from, dailyLimitMinutes: r.daily_limit_minutes, quietStart: r.quiet_start, quietEnd: r.quiet_end, timezone: r.timezone }
            : null,
        // Only the guardian sees the teen's daily minutes; that is all usage data they get.
        usage: r.guardian_id === u.id ? usage.filter((x) => x.user_id === r.teen_id).map((x) => ({ day: x.day, minutes: x.minutes })) : undefined,
        createdAt: r.created_at,
      })),
    };
  });

  app.post('/v1/family/:id/accept', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const l = await link(id);
    if (l.teen_id !== u.id) throw forbidden();
    if (l.status !== 'pending') throw new AppError(409, 'conflict', 'This invitation is no longer open.');
    await tx(db, async (c) => {
      await c.query(`UPDATE family_links SET status = 'active', accepted_at = now() WHERE id = $1`, [id]);
      await c.query(`INSERT INTO teen_controls (teen_id, updated_by) VALUES ($1,$2) ON CONFLICT (teen_id) DO NOTHING`, [u.id, l.guardian_id]);
    });
    await notify(db, ctx.realtime, { userId: l.guardian_id, category: 'security', type: 'family_accepted', actorId: u.id, entityType: 'family_link', entityId: id });
    await audit(db, { actorId: u.id, action: 'family.accept', entityType: 'family_link', entityId: id });
    return { status: 'active' };
  });

  app.post('/v1/family/:id/end', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const l = await link(id);
    if (l.teen_id !== u.id && l.guardian_id !== u.id) throw forbidden();
    if (l.status === 'ended') return { status: 'ended' };
    await db.query(`UPDATE family_links SET status = 'ended', ended_at = now() WHERE id = $1`, [id]);
    const other = l.teen_id === u.id ? l.guardian_id : l.teen_id;
    if (l.status === 'active')
      await notify(db, ctx.realtime, { userId: other, category: 'security', type: 'family_ended', actorId: u.id, entityType: 'family_link', entityId: id });
    await audit(db, { actorId: u.id, action: 'family.end', entityType: 'family_link', entityId: id });
    return { status: 'ended' };
  });

  app.put('/v1/family/:id/controls', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const input = parse(
      z
        .object({
          messagesFrom: z.enum(['friends', 'nobody']),
          dailyLimitMinutes: z.number().int().min(15).max(720).nullable(),
          quietStart: hhmm.nullable(),
          quietEnd: hhmm.nullable(),
          timezone: z.string().refine((tz) => TIMEZONES.has(tz), 'Unknown time zone.'),
        })
        .refine((v) => (v.quietStart === null) === (v.quietEnd === null), { message: 'Set both quiet-hours times or neither.', path: ['quietEnd'] }),
      req.body,
    );
    const l = await link(id);
    if (l.guardian_id !== u.id || l.status !== 'active') throw forbidden();
    await db.query(
      `INSERT INTO teen_controls (teen_id, messages_from, daily_limit_minutes, quiet_start, quiet_end, timezone, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now())
       ON CONFLICT (teen_id) DO UPDATE SET messages_from = EXCLUDED.messages_from, daily_limit_minutes = EXCLUDED.daily_limit_minutes,
         quiet_start = EXCLUDED.quiet_start, quiet_end = EXCLUDED.quiet_end, timezone = EXCLUDED.timezone, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [l.teen_id, input.messagesFrom, input.dailyLimitMinutes, input.quietStart, input.quietEnd, input.timezone, u.id],
    );
    // The teen is always told when their settings change.
    await notify(db, ctx.realtime, { userId: l.teen_id, category: 'security', type: 'family_controls_changed', actorId: u.id, entityType: 'family_link', entityId: id });
    await audit(db, { actorId: u.id, action: 'family.controls', entityType: 'family_link', entityId: id, metadata: input });
    return { controls: input };
  });

  /**
   * The apps call this about once a minute while visible. It records daily
   * minutes (in the teen's time zone when supervised) and says whether a
   * daily reminder or quiet hours apply right now.
   */
  app.post('/v1/me/usage/heartbeat', { preHandler: requireAuth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const controls = await activeControls(db, u.id);
    const tz = controls?.timezone ?? 'UTC';
    const { rows } = await db.query(
      `INSERT INTO usage_days (user_id, day, minutes, last_beat_at) VALUES ($1, (now() AT TIME ZONE $2)::date, 1, now())
       ON CONFLICT (user_id, day) DO UPDATE SET
         minutes = usage_days.minutes + CASE WHEN usage_days.last_beat_at < now() - interval '50 seconds' THEN 1 ELSE 0 END,
         last_beat_at = CASE WHEN usage_days.last_beat_at < now() - interval '50 seconds' THEN now() ELSE usage_days.last_beat_at END
       RETURNING minutes`,
      [u.id, tz],
    );
    const minutes = rows[0].minutes as number;
    return {
      minutesToday: minutes,
      dailyLimitMinutes: controls?.dailyLimitMinutes ?? null,
      overLimit: controls?.dailyLimitMinutes ? minutes >= controls.dailyLimitMinutes : false,
      quietNow: controls?.quietNow ?? false,
      supervised: Boolean(controls),
    };
  });
}
