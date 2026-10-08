import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tx } from '@yapilapi/database';
import { pageQuerySchema, squadCreateSchema, squadEditSchema, squadInviteSchema, squadRoleSchema } from '@yapilapi/shared';
import type { AppContext } from '../lib/context.ts';
import { decodeCursor, keyCursorOf, type KeyCursor } from '../lib/cursor.ts';
import { featureDisabled, parse } from '../lib/errors.ts';
import { hydratePosts } from '../lib/posts.ts';
import { isEnabled, track } from '../lib/services.ts';
import {
  acceptInvite,
  activeMember,
  announceCreated,
  announceInvited,
  createSquad,
  declineInvite,
  deleteSquad,
  editSquad,
  inviteCandidates,
  inviteToSquad,
  leaveSquad,
  memoryFor,
  removeFromSquad,
  setSquadRole,
  squadCards,
  squadFor,
  squadPostIds,
  transferSquad,
} from '../lib/squads.ts';
import { me, requireAuth, requireRole } from '../plugins/auth.ts';

const idParam = z.object({ id: z.string().uuid() });
const memberParam = z.object({ id: z.string().uuid(), userId: z.string().uuid() });

/**
 * Squads (lib/squads.ts, docs/product/squads.md): small private groups of friends. Sharing to a
 * squad is posting with `visibility: 'squad'` and `squadId` (POST /v1/posts, POST /v1/moments);
 * its chat is an ordinary group conversation. Everything here is for people in the squad (or
 * invited to it); anyone else gets "not found".
 */
export default async function squadsModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;
  const deps = { db, realtime: ctx.realtime };
  const on = async () => {
    if (!(await isEnabled(db, 'SQUADS'))) throw featureDisabled('Squads');
  };

  /** Your squads, and invites waiting for you first. */
  app.get('/v1/squads', { preHandler: requireAuth }, async (req) => {
    if (!(await isEnabled(db, 'SQUADS'))) return { items: [] };
    return { items: await squadCards(db, me(req).id) };
  });

  /** Make a squad and invite 2 to 9 people (each accepts or declines). */
  app.post('/v1/squads', { preHandler: requireAuth, config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req, reply) => {
    await on();
    const u = me(req);
    const input = parse(squadCreateSchema, req.body);
    const made = await tx(db, (c) => createSquad(deps, c, u.id, input));
    await announceCreated(deps, made.id, u.id, made.invited);
    track(db, u.id, 'squad_created', { invited: made.invited.length });
    reply.code(201);
    return { squad: await squadFor(db, made.id, u.id) };
  });

  /** People you could invite (friends, and people you follow who follow you back), for a new squad or one you're in. */
  app.get('/v1/squads/candidates', { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    await on();
    const u = me(req);
    const q = parse(z.object({ squadId: z.string().uuid().optional(), q: z.string().trim().max(60).optional() }), req.query);
    if (q.squadId) await activeMember(db, q.squadId, u.id);
    return { items: await inviteCandidates(db, u.id, q.squadId ?? null, q.q || null) };
  });

  app.get('/v1/squads/:id', { preHandler: requireAuth }, async (req) => {
    await on();
    const { id } = parse(idParam, req.params);
    return { squad: await squadFor(db, id, me(req).id) };
  });

  /** Rename it or change its cover (owner and admins). */
  app.patch('/v1/squads/:id', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req) => {
    await on();
    const u = me(req);
    const { id } = parse(idParam, req.params);
    await editSquad(deps, id, u.id, parse(squadEditSchema, req.body));
    return { squad: await squadFor(db, id, u.id) };
  });

  /** Delete it (its owner). What was shared stays with the people who shared it, for them alone. */
  app.delete('/v1/squads/:id', { preHandler: requireAuth }, async (req) => {
    await on();
    const { id } = parse(idParam, req.params);
    await deleteSquad(deps, id, me(req).id);
    return { ok: true };
  });

  /** Invite more people (anyone in it can; the squad stays at 10 people at most, invites included). */
  app.post('/v1/squads/:id/invites', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req) => {
    await on();
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { userIds } = parse(squadInviteSchema, req.body);
    const invited = await tx(db, (c) => inviteToSquad(deps, c, id, u.id, userIds));
    await announceInvited(deps, id, u.id, invited);
    return { invited: invited.length, squad: await squadFor(db, id, u.id) };
  });

  app.post('/v1/squads/:id/accept', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    await on();
    const u = me(req);
    const { id } = parse(idParam, req.params);
    await acceptInvite(deps, id, u.id);
    return { squad: await squadFor(db, id, u.id) };
  });

  app.post('/v1/squads/:id/decline', { preHandler: requireAuth }, async (req) => {
    await on();
    const { id } = parse(idParam, req.params);
    await declineInvite(deps, id, me(req).id);
    return { ok: true };
  });

  /** Leave (the owner makes someone else the owner first, or deletes the squad). */
  app.post('/v1/squads/:id/leave', { preHandler: requireAuth }, async (req) => {
    await on();
    const { id } = parse(idParam, req.params);
    await leaveSquad(deps, id, me(req).id);
    return { ok: true };
  });

  /** Take someone out, or take back an invite (the owner; admins for members). */
  app.delete('/v1/squads/:id/members/:userId', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 hour' } } }, async (req) => {
    await on();
    const u = me(req);
    const { id, userId } = parse(memberParam, req.params);
    await removeFromSquad(deps, id, u.id, userId);
    return userId === u.id ? { ok: true } : { ok: true, squad: await squadFor(db, id, u.id) };
  });

  /** Make someone an admin, or a member again (the owner). */
  app.put('/v1/squads/:id/members/:userId/role', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 hour' } } }, async (req) => {
    await on();
    const u = me(req);
    const { id, userId } = parse(memberParam, req.params);
    const { role } = parse(squadRoleSchema, req.body);
    await setSquadRole(deps, id, u.id, userId, role);
    return { squad: await squadFor(db, id, u.id) };
  });

  /** Hand the squad to someone in it (the owner, who stays on as an admin). */
  app.post('/v1/squads/:id/owner', { preHandler: requireAuth, config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req) => {
    await on();
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { userId } = parse(z.object({ userId: z.string().uuid() }), req.body);
    await transferSquad(deps, id, u.id, userId);
    return { squad: await squadFor(db, id, u.id) };
  });

  /** The squad's posts and reels, newest first. */
  app.get('/v1/squads/:id/posts', { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    await on();
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const q = parse(pageQuerySchema, req.query);
    await activeMember(db, id, u.id);
    const rows = await squadPostIds(db, id, u.id, q.limit, decodeCursor<KeyCursor>(q.cursor));
    const page = rows.slice(0, q.limit);
    return {
      items: await hydratePosts(
        db,
        page.map((r) => r.id),
        u.id,
      ),
      nextCursor: rows.length > q.limit ? keyCursorOf(page.at(-1)!) : null,
    };
  });

  /** One of the squad's weekly memories. */
  app.get('/v1/squads/:id/memories/:memoryId', { preHandler: requireAuth }, async (req) => {
    await on();
    const { id, memoryId } = parse(z.object({ id: z.string().uuid(), memoryId: z.string().uuid() }), req.params);
    return { memory: await memoryFor(db, id, memoryId, me(req).id) };
  });

  // ── Admin ─────────────────────────────────────────────────────────────

  /** For the admin console: how many squads, people in them, and what they shared this week. Reports on squad posts go through the usual queue. */
  app.get('/v1/admin/squads', { preHandler: requireRole('admin') }, async () => {
    const { rows } = await db.query(
      `SELECT (SELECT count(*) FROM squads)::int AS squads,
              (SELECT count(*) FROM squad_members WHERE status = 'active')::int AS members,
              (SELECT count(*) FROM squad_members WHERE status = 'invited')::int AS invites,
              (SELECT count(*) FROM posts WHERE visibility = 'squad' AND squad_id IS NOT NULL AND deleted_at IS NULL AND created_at > now() - interval '7 days')::int AS posts_this_week`,
    );
    const r = rows[0];
    return { squads: r.squads as number, members: r.members as number, invites: r.invites as number, postsThisWeek: r.posts_this_week as number };
  });
}
