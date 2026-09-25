import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { COMMUNITY_ROLE_RANK } from '@yapilapi/shared';
import { z } from 'zod';
import { badRequest, featureDisabled, forbidden, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { audit, isEnabled } from '../lib/services.ts';
import { me, requireAuth, requireRole } from '../plugins/auth.ts';

const SURFACES = ['conversation', 'community', 'event', 'profile', 'business'] as const;
type Surface = (typeof SURFACES)[number];

/**
 * Mini Apps: small web apps from developers that run inside conversations,
 * communities, events and profiles. They load in a sandboxed iframe with no
 * access to YAPILAPI cookies; the host page gives them a short-lived signed
 * context token, which their server verifies here. Anything that acts for the
 * user (like posting a message) is performed by the host after the user confirms.
 */
export default async function miniAppsModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;
  const secret = ctx.config.LIVE_HOOK_SECRET + ':mini-apps';
  const gate = async (req: FastifyRequest) => {
    await requireAuth(req, undefined as never);
    if (!(await isEnabled(db, 'MINI_APPS'))) throw featureDisabled('Mini Apps');
  };

  const sign = (claims: object) => {
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
  };
  const verify = (token: string): Record<string, any> | null => {
    const [body, mac] = token.split('.');
    if (!body || !mac) return null;
    const expected = createHmac('sha256', secret).update(body).digest('base64url');
    if (expected.length !== mac.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(mac))) return null;
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
    return claims.exp > Date.now() / 1000 ? claims : null;
  };

  /** Can this user use (or, with manage, install into) this surface? */
  async function surfaceAccess(surface: Surface, id: string, userId: string, manage: boolean): Promise<boolean> {
    if (surface === 'conversation')
      return !!(await db.query(`SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`, [id, userId])).rowCount;
    if (surface === 'community') {
      const r = await db.query(`SELECT role FROM community_members WHERE community_id = $1 AND user_id = $2 AND status = 'active'`, [id, userId]);
      const role = r.rows[0]?.role as keyof typeof COMMUNITY_ROLE_RANK | undefined;
      return !!role && (!manage || COMMUNITY_ROLE_RANK[role] >= COMMUNITY_ROLE_RANK.admin);
    }
    if (surface === 'event') {
      if (manage) return !!(await db.query(`SELECT 1 FROM events WHERE id = $1 AND host_id = $2`, [id, userId])).rowCount;
      return !!(
        await db.query(`SELECT 1 FROM event_attendees WHERE event_id = $1 AND user_id = $2 UNION SELECT 1 FROM events WHERE id = $1 AND host_id = $2`, [
          id,
          userId,
        ])
      ).rowCount;
    }
    if (surface === 'profile') return manage ? id === userId : true;
    if (surface === 'business') return manage ? !!(await db.query(`SELECT 1 FROM businesses WHERE id = $1 AND owner_id = $2`, [id, userId])).rowCount : true;
    return false;
  }

  // ── Developers submit; admins review ──────────────────────────────────
  app.post('/v1/developer/apps/:id/mini-apps', { preHandler: requireAuth }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const input = parse(
      z.object({
        name: z.string().trim().min(1).max(60),
        description: z.string().trim().max(500).default(''),
        entryUrl: z.string().url().startsWith('https://', 'Mini Apps must be served over https.').max(500),
        permissions: z.array(z.enum(['profile', 'members', 'post_message'])).default([]),
        surfaces: z.array(z.enum(SURFACES)).min(1),
      }),
      req.body,
    );
    const own = await db.query(`SELECT 1 FROM developer_apps WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL`, [id, u.id]);
    if (!own.rowCount) throw notFound('App');
    const { rows } = await db.query(
      `INSERT INTO mini_apps (app_id, name, description, entry_url, permissions, surfaces) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, status`,
      [id, input.name, input.description, input.entryUrl, [...new Set(input.permissions)], [...new Set(input.surfaces)]],
    );
    reply.code(201);
    return { miniApp: rows[0], message: 'Submitted for review. It becomes installable once approved.' };
  });

  app.get('/v1/admin/mini-apps', { preHandler: requireRole('admin') }, async () => {
    const { rows } = await db.query(
      `SELECT m.*, a.name AS developer_app FROM mini_apps m JOIN developer_apps a ON a.id = m.app_id WHERE m.status = 'review' ORDER BY m.created_at`,
    );
    return { items: rows };
  });

  app.post('/v1/admin/mini-apps/:id/decide', { preHandler: requireRole('admin') }, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const { approve } = parse(z.object({ approve: z.boolean() }), req.body);
    const r = await db.query(`UPDATE mini_apps SET status = $2 WHERE id = $1 RETURNING id, status`, [id, approve ? 'approved' : 'rejected']);
    if (!r.rowCount) throw notFound('Mini App');
    await audit(db, { actorId: me(req).id, action: `mini_app.${approve ? 'approve' : 'reject'}`, entityType: 'mini_app', entityId: id });
    return r.rows[0];
  });

  // ── Users ─────────────────────────────────────────────────────────────
  app.get('/v1/mini-apps', { preHandler: gate }, async (req) => {
    const q = parse(z.object({ surface: z.enum(SURFACES) }), req.query);
    const { rows } = await db.query(`SELECT id, name, description, permissions FROM mini_apps WHERE status = 'approved' AND $1 = ANY(surfaces) ORDER BY name`, [
      q.surface,
    ]);
    return { items: rows };
  });

  app.get('/v1/mini-apps/installed', { preHandler: gate }, async (req) => {
    const q = parse(z.object({ surface: z.enum(SURFACES), surfaceId: z.string().uuid() }), req.query);
    if (!(await surfaceAccess(q.surface, q.surfaceId, me(req).id, false))) throw notFound('That place');
    const { rows } = await db.query(
      `SELECT m.id, m.name, m.description, m.entry_url, m.permissions FROM mini_app_installs i JOIN mini_apps m ON m.id = i.mini_app_id
       WHERE i.surface = $1 AND i.surface_id = $2 AND m.status = 'approved' ORDER BY i.created_at`,
      [q.surface, q.surfaceId],
    );
    return { items: rows.map((r) => ({ id: r.id, name: r.name, description: r.description, entryUrl: r.entry_url, permissions: r.permissions })) };
  });

  app.post('/v1/mini-apps/:id/install', { preHandler: gate }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const input = parse(z.object({ surface: z.enum(SURFACES), surfaceId: z.string().uuid() }), req.body);
    const m = (await db.query(`SELECT surfaces FROM mini_apps WHERE id = $1 AND status = 'approved'`, [id])).rows[0];
    if (!m) throw notFound('Mini App');
    if (!m.surfaces.includes(input.surface)) throw badRequest(`This Mini App can't be added to a ${input.surface}.`);
    if (!(await surfaceAccess(input.surface, input.surfaceId, u.id, true))) throw forbidden(`You can't add apps here.`);
    await db.query(`INSERT INTO mini_app_installs (mini_app_id, surface, surface_id, installed_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [
      id,
      input.surface,
      input.surfaceId,
      u.id,
    ]);
    reply.code(201);
    return { ok: true };
  });

  app.delete('/v1/mini-apps/:id/install', { preHandler: gate }, async (req) => {
    const u = me(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const input = parse(z.object({ surface: z.enum(SURFACES), surfaceId: z.string().uuid() }), req.body);
    if (!(await surfaceAccess(input.surface, input.surfaceId, u.id, true))) throw forbidden();
    await db.query(`DELETE FROM mini_app_installs WHERE mini_app_id = $1 AND surface = $2 AND surface_id = $3`, [id, input.surface, input.surfaceId]);
    return { ok: true };
  });

  /** Context token for the iframe. Contains only what the app's permissions allow. */
  app.post('/v1/mini-apps/:id/context', { preHandler: gate }, async (req) => {
    const u = me(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const input = parse(z.object({ surface: z.enum(SURFACES), surfaceId: z.string().uuid() }), req.body);
    const m = (
      await db.query(
        `SELECT m.permissions, m.app_id FROM mini_apps m JOIN mini_app_installs i ON i.mini_app_id = m.id AND i.surface = $2 AND i.surface_id = $3 WHERE m.id = $1 AND m.status = 'approved'`,
        [id, input.surface, input.surfaceId],
      )
    ).rows[0];
    if (!m || !(await surfaceAccess(input.surface, input.surfaceId, u.id, false))) throw notFound('Mini App');
    const claims: Record<string, unknown> = {
      app: m.app_id,
      miniApp: id,
      surface: input.surface,
      surfaceId: input.surfaceId,
      sub: createHmac('sha256', secret).update(`${m.app_id}:${u.id}`).digest('hex').slice(0, 32),
      exp: Math.floor(Date.now() / 1000) + 600,
    };
    if (m.permissions.includes('profile')) {
      const p = (await db.query(`SELECT username, display_name, avatar_url FROM profiles WHERE user_id = $1`, [u.id])).rows[0];
      claims.user = { username: p.username, displayName: p.display_name, avatarUrl: p.avatar_url };
    }
    if (m.permissions.includes('members') && input.surface === 'conversation') {
      const r = await db.query(
        `SELECT pr.display_name FROM conversation_members cm JOIN profiles pr ON pr.user_id = cm.user_id WHERE cm.conversation_id = $1 AND cm.left_at IS NULL`,
        [input.surfaceId],
      );
      claims.members = r.rows.map((x) => x.display_name);
    }
    return { token: sign(claims), permissions: m.permissions };
  });

  /** For Mini App servers: check a context token and read its claims. */
  app.post('/v1/mini-apps/verify', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { token } = parse(z.object({ token: z.string().max(4000) }), req.body);
    const claims = verify(token);
    if (!claims) return reply.code(401).send({ valid: false });
    return { valid: true, claims };
  });
}
