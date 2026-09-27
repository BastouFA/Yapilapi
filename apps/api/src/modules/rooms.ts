import type { FastifyInstance } from 'fastify';
import { tx } from '@yapilapi/database';
import { COMMUNITY_ROLE_RANK, ROOM_REACTIONS, ROOM_TITLE_MAX, type CommunityRole } from '@yapilapi/shared';
import { z } from 'zod';
import { AppError, badRequest, forbidden, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { communityRooms, endRoom, notePeak, publishRoomState, roomDetail, roomStageRuleSql, roomSummary, type RoomsDeps } from '../lib/rooms.ts';
import { audit, notify, track } from '../lib/services.ts';
import { isBlockedEitherWay } from '../lib/users.ts';
import { me, requireAuth } from '../plugins/auth.ts';

const idParam = z.object({ id: z.string().uuid() });
const targetParam = z.object({ id: z.string().uuid(), userId: z.string().uuid() });

const roomFull = (what: 'listeners' | 'speakers') =>
  new AppError(409, 'room_full', what === 'listeners' ? 'Room is full.' : 'Room is full: every speaker spot is taken.');
const notInRoom = () => new AppError(409, 'not_in_room', "You're not in this room. Join it again to listen.");
const roomOver = () => new AppError(409, 'room_ended', 'This room has ended.');

/**
 * Live audio rooms in communities.
 *
 * This module owns who is in a room and what they may do; every route checks
 * it on the server, and so does every signaling message. Audio goes through
 * `ctx.roomMedia` (lib/room-media.ts), a WebRTC mesh today with a boundary an
 * SFU can replace.
 *
 * Rules:
 * - Moderators, admins and the owner of a community start rooms (now or
 *   scheduled). They are the hosts, with the person who started the room.
 * - Only active members of the community join; bans apply, including to
 *   anyone already in a room. Nobody joins without being a member, which is
 *   also the rule for people under 18.
 * - Everyone joins as a listener (the person who started it joins on stage).
 *   Listeners raise a hand; a host invites them to speak, and they accept.
 *   An adult can't invite someone under 18 (or the reverse) unless they are
 *   friends or linked through family, as for messages. Blocks apply too.
 * - Hosts mute speakers, move them back to listening, or remove someone;
 *   removed people can't rejoin that room.
 * - Signaling is relayed only between two people in the same live room whom
 *   the media adapter connects (a speaker and anyone else, in the mesh).
 */
export default async function roomsModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;
  const media = ctx.roomMedia;
  const deps: RoomsDeps = { db, realtime: ctx.realtime, media };

  async function communityBySlug(slug: string, viewer: string | null) {
    const { rows } = await db.query(
      `SELECT c.id, c.visibility, cm.role AS my_role, cm.status AS my_status
       FROM communities c LEFT JOIN community_members cm ON cm.community_id = c.id AND cm.user_id = $2
       WHERE lower(c.slug) = lower($1) AND c.deleted_at IS NULL`,
      [slug, viewer],
    );
    if (!rows[0]) throw notFound('Community');
    return rows[0] as { id: string; visibility: string; my_role: CommunityRole | null; my_status: string | null };
  }

  const isModerator = (role: CommunityRole | null, status: string | null) =>
    status === 'active' && role !== null && COMMUNITY_ROLE_RANK[role] >= COMMUNITY_ROLE_RANK.moderator;

  /** The room plus the viewer's membership of its community and their row in the room, if any. */
  async function load(roomId: string, userId: string) {
    const { rows } = await db.query(
      `SELECT r.id, r.status, r.community_id, r.created_by, r.title,
              cm.role AS c_role, cm.status AS c_status,
              coalesce((SELECT u.birth_date > current_date - interval '18 years' FROM users u WHERE u.id = $2), false) AS minor,
              p.role, p.is_host, p.muted, p.invited_at, p.invited_by, p.left_at, p.removed_at
       FROM rooms r
       LEFT JOIN community_members cm ON cm.community_id = r.community_id AND cm.user_id = $2
       LEFT JOIN room_participants p ON p.room_id = r.id AND p.user_id = $2
       WHERE r.id = $1`,
      [roomId, userId],
    );
    const r = rows[0];
    if (!r) throw notFound('Room');
    return r as {
      id: string;
      status: 'scheduled' | 'live' | 'ended' | 'cancelled';
      community_id: string;
      created_by: string;
      title: string;
      c_role: CommunityRole | null;
      c_status: string | null;
      minor: boolean;
      role: 'speaker' | 'listener' | null;
      is_host: boolean | null;
      muted: boolean | null;
      invited_at: Date | null;
      invited_by: string | null;
      left_at: Date | null;
      removed_at: Date | null;
    };
  }
  type Loaded = Awaited<ReturnType<typeof load>>;

  function assertMember(r: Loaded) {
    if (r.c_status === 'banned') throw forbidden("You can't join this room.");
    if (r.c_status !== 'active') throw forbidden('Join this community to listen to its rooms.');
  }

  /** The caller must be in the live room right now (and still a member). */
  async function present(roomId: string, userId: string) {
    const r = await load(roomId, userId);
    if (r.status !== 'live') throw roomOver();
    if (r.c_status !== 'active') {
      // Left or banned from the community since joining: out of the room too.
      if (r.role && !r.left_at) {
        await db.query(`UPDATE room_participants SET left_at = now() WHERE room_id = $1 AND user_id = $2`, [roomId, userId]);
        await publishRoomState(deps, roomId, [userId]);
      }
      assertMember(r);
    }
    if (r.removed_at) throw new AppError(403, 'removed_from_room', 'A host removed you from this room.');
    if (!r.role || r.left_at) throw notInRoom();
    return r as Loaded & { role: 'speaker' | 'listener'; is_host: boolean };
  }

  /** The caller may manage the room: in it as a host. */
  async function host(roomId: string, userId: string) {
    const r = await present(roomId, userId);
    if (!r.is_host) throw forbidden('Only hosts can do that.');
    return r;
  }

  /** Someone else, in the room now, whom the host may manage (hosts don't manage each other). */
  async function target(roomId: string, userId: string) {
    const { rows } = await db.query(`SELECT role, is_host, left_at, removed_at FROM room_participants WHERE room_id = $1 AND user_id = $2`, [roomId, userId]);
    const t = rows[0];
    if (!t || t.left_at) throw notFound('That person in this room');
    if (t.is_host) throw forbidden("Hosts can't manage other hosts.");
    return t as { role: 'speaker' | 'listener'; is_host: boolean };
  }

  const count = async (c: { query: typeof db.query }, roomId: string, role: 'speaker' | 'listener') =>
    Number((await c.query(`SELECT count(*) AS n FROM room_participants WHERE room_id = $1 AND role = $2 AND left_at IS NULL`, [roomId, role])).rows[0].n);

  async function changed(roomId: string, userId: string, role: 'speaker' | 'listener' | null, also: string[] = []) {
    await media.participantChanged(roomId, userId, role);
    await publishRoomState(deps, roomId, also);
  }

  // ── Community rooms ────────────────────────────────────────────────────
  app.get('/v1/communities/:slug/rooms', async (req) => {
    const viewer = req.user?.id ?? null;
    const { slug } = parse(z.object({ slug: z.string().min(1).max(40) }), req.params);
    const c = await communityBySlug(slug, viewer);
    const member = c.my_status === 'active';
    if (c.visibility === 'private' && !member) return { items: [], canStart: false, locked: true };
    return { items: await communityRooms(deps, c.id, viewer), canStart: isModerator(c.my_role, c.my_status), limits: media.limits };
  });

  app.post('/v1/communities/:slug/rooms', { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    const { slug } = parse(z.object({ slug: z.string().min(1).max(40) }), req.params);
    const input = parse(
      z.object({
        title: z.string().trim().min(1).max(ROOM_TITLE_MAX),
        scheduledFor: z.string().datetime({ offset: true }).optional(),
      }),
      req.body,
    );
    const c = await communityBySlug(slug, u.id);
    if (!isModerator(c.my_role, c.my_status)) throw forbidden('Only moderators and owners can start rooms.');
    let when: Date | null = null;
    if (input.scheduledFor) {
      when = new Date(input.scheduledFor);
      if (when.getTime() < Date.now() - 60_000)
        throw new AppError(400, 'validation_failed', 'Pick a time in the future.', { fields: { scheduledFor: 'Pick a time in the future.' } });
      if (when.getTime() > Date.now() + 60 * 86_400_000)
        throw new AppError(400, 'validation_failed', 'Pick a time in the next 60 days.', { fields: { scheduledFor: 'Pick a time in the next 60 days.' } });
      const upcoming = await db.query(`SELECT count(*) AS n FROM rooms WHERE community_id = $1 AND status = 'scheduled'`, [c.id]);
      if (Number(upcoming.rows[0].n) >= 20) throw new AppError(409, 'conflict', 'A community can have up to 20 scheduled rooms.');
    }
    const { rows } = await db
      .query<{ id: string }>(
        `INSERT INTO rooms (community_id, created_by, title, status, scheduled_for, started_at, host_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING id`,
        [c.id, u.id, input.title, when ? 'scheduled' : 'live', when, when ? null : new Date()],
      )
      .catch((e) => {
        if (e.code === '23505') throw new AppError(409, 'room_in_progress', 'This community already has a live room.');
        throw e;
      });
    await audit(db, {
      actorId: u.id,
      action: when ? 'room.schedule' : 'room.start',
      entityType: 'room',
      entityId: rows[0]!.id,
      metadata: { communityId: c.id },
    });
    track(db, u.id, 'room_created', { scheduled: !!when });
    reply.code(201);
    return { room: await roomSummary(deps, rows[0]!.id, u.id) };
  });

  // ── One room ───────────────────────────────────────────────────────────
  app.get('/v1/rooms/:id', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const r = await load(id, u.id);
    assertMember(r);
    const room = await roomDetail(deps, id, u.id);
    const inRoom = !!r.role && !r.left_at && r.status === 'live';
    return {
      room,
      removed: !!r.removed_at,
      canHost: r.created_by === u.id || isModerator(r.c_role, r.c_status),
      media: inRoom ? media.session({ id: u.id, minor: r.minor }) : null,
    };
  });

  app.post('/v1/rooms/:id/start', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const r = await load(id, u.id);
    if (!(r.created_by === u.id && r.c_status === 'active') && !isModerator(r.c_role, r.c_status)) throw forbidden('Only hosts can start this room.');
    if (r.status !== 'scheduled') throw new AppError(409, 'conflict', r.status === 'live' ? 'This room is already live.' : 'This room is over.');
    await db.query(`UPDATE rooms SET status = 'live', started_at = now(), host_seen_at = now() WHERE id = $1 AND status = 'scheduled'`, [id]).catch((e) => {
      if (e.code === '23505') throw new AppError(409, 'room_in_progress', 'This community already has a live room.');
      throw e;
    });
    // Tell the members who asked, if they are still members.
    const want = await db.query<{ user_id: string }>(
      `SELECT rr.user_id FROM room_reminders rr JOIN community_members cm ON cm.user_id = rr.user_id AND cm.community_id = $2 AND cm.status = 'active'
       WHERE rr.room_id = $1`,
      [id, r.community_id],
    );
    for (const w of want.rows)
      await notify(db, ctx.realtime, {
        userId: w.user_id,
        category: 'communities',
        type: 'room_live',
        actorId: u.id,
        entityType: 'room',
        entityId: id,
        data: { title: r.title },
      });
    await audit(db, { actorId: u.id, action: 'room.start', entityType: 'room', entityId: id });
    return { room: await roomSummary(deps, id, u.id) };
  });

  app.post('/v1/rooms/:id/end', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const r = await load(id, u.id);
    const hostInRoom = !!r.is_host && !r.left_at;
    if (!(r.created_by === u.id && r.c_status === 'active') && !isModerator(r.c_role, r.c_status) && !hostInRoom)
      throw forbidden('Only hosts can end this room.');
    if (!(await endRoom(deps, id))) throw roomOver();
    await audit(db, { actorId: u.id, action: 'room.end', entityType: 'room', entityId: id });
    return { room: await roomSummary(deps, id, u.id) };
  });

  app.post('/v1/rooms/:id/remind', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { on } = parse(z.object({ on: z.boolean() }), req.body);
    const r = await load(id, u.id);
    assertMember(r);
    if (r.status !== 'scheduled') throw new AppError(409, 'conflict', "Reminders are for rooms that haven't started yet.");
    if (on) await db.query(`INSERT INTO room_reminders (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, u.id]);
    else await db.query(`DELETE FROM room_reminders WHERE room_id = $1 AND user_id = $2`, [id, u.id]);
    return { remindMe: on };
  });

  app.post('/v1/rooms/:id/join', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const before = await load(id, u.id);
    assertMember(before);
    if (before.status === 'scheduled') throw new AppError(409, 'room_not_started', "This room hasn't started yet.");
    if (before.status !== 'live') throw roomOver();
    if (before.removed_at) throw new AppError(403, 'removed_from_room', 'A host removed you from this room.');
    const isHost = before.created_by === u.id || isModerator(before.c_role, before.c_status);

    const result = await tx(db, async (c) => {
      // One join at a time per room, so the limits hold.
      const room = await c.query(`SELECT status FROM rooms WHERE id = $1 FOR UPDATE`, [id]);
      if (room.rows[0]?.status !== 'live') throw roomOver();
      const mine = await c.query(`SELECT role, left_at, removed_at FROM room_participants WHERE room_id = $1 AND user_id = $2`, [id, u.id]);
      if (mine.rows[0]?.removed_at) throw new AppError(403, 'removed_from_room', 'A host removed you from this room.');
      if (mine.rows[0] && !mine.rows[0].left_at) {
        await c.query(`UPDATE room_participants SET last_seen_at = now() WHERE room_id = $1 AND user_id = $2`, [id, u.id]);
        return { role: mine.rows[0].role as 'speaker' | 'listener', left: [] as string[], fresh: false };
      }
      // The person who started the room goes on stage when there's space.
      let role: 'speaker' | 'listener' = 'listener';
      if (before.created_by === u.id && (await count(c, id, 'speaker')) < media.limits.speakers) role = 'speaker';
      if (role === 'listener' && (await count(c, id, 'listener')) >= media.limits.listeners) throw roomFull('listeners');
      // One room at a time.
      const left = await c.query<{ room_id: string }>(
        `UPDATE room_participants SET left_at = now(), hand_raised_at = NULL, invited_at = NULL WHERE user_id = $1 AND room_id <> $2 AND left_at IS NULL RETURNING room_id`,
        [u.id, id],
      );
      await c.query(
        `INSERT INTO room_participants (room_id, user_id, role, is_host, muted) VALUES ($1, $2, $3, $4, true)
         ON CONFLICT (room_id, user_id) DO UPDATE SET role = EXCLUDED.role, is_host = EXCLUDED.is_host, muted = true, hand_raised_at = NULL,
           invited_at = NULL, invited_by = NULL, joined_at = now(), last_seen_at = now(), left_at = NULL`,
        [id, u.id, role, isHost],
      );
      if (isHost) await c.query(`UPDATE rooms SET host_seen_at = now() WHERE id = $1`, [id]);
      await notePeak(c, id);
      return { role, left: left.rows.map((x) => x.room_id), fresh: true };
    });
    for (const other of result.left) await changed(other, u.id, null, [u.id]);
    if (result.fresh) {
      await changed(id, u.id, result.role);
      track(db, u.id, 'room_joined', { roomId: id, role: result.role });
    }
    return {
      room: await roomDetail(deps, id, u.id),
      removed: false,
      canHost: isHost,
      media: media.session({ id: u.id, minor: before.minor }),
    };
  });

  app.post('/v1/rooms/:id/heartbeat', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const r = await present(id, u.id);
    await db.query(`UPDATE room_participants SET last_seen_at = now() WHERE room_id = $1 AND user_id = $2`, [id, u.id]);
    if (r.is_host) await db.query(`UPDATE rooms SET host_seen_at = now() WHERE id = $1`, [id]);
    return { ok: true };
  });

  app.post('/v1/rooms/:id/leave', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const r = await db.query(
      `UPDATE room_participants SET left_at = now(), hand_raised_at = NULL, invited_at = NULL WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL RETURNING user_id`,
      [id, u.id],
    );
    if (r.rowCount) await changed(id, u.id, null, [u.id]);
    return { ok: true };
  });

  app.post('/v1/rooms/:id/hand', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { raised } = parse(z.object({ raised: z.boolean() }), req.body);
    const r = await present(id, u.id);
    if (r.role !== 'listener') throw badRequest("You're already a speaker.");
    await db.query(`UPDATE room_participants SET hand_raised_at = CASE WHEN $3 THEN coalesce(hand_raised_at, now()) END WHERE room_id = $1 AND user_id = $2`, [
      id,
      u.id,
      raised,
    ]);
    await publishRoomState(deps, id);
    return { raised };
  });

  /** A speaker mutes or unmutes themselves. */
  app.post('/v1/rooms/:id/mute', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { muted } = parse(z.object({ muted: z.boolean() }), req.body);
    const r = await present(id, u.id);
    if (r.role !== 'speaker') throw badRequest('Only speakers have a microphone on.');
    await db.query(`UPDATE room_participants SET muted = $3 WHERE room_id = $1 AND user_id = $2`, [id, u.id, muted]);
    await publishRoomState(deps, id);
    return { muted };
  });

  /** A host asks a listener to speak. They accept or decline with /speak. */
  app.post('/v1/rooms/:id/participants/:userId/invite', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id, userId } = parse(targetParam, req.params);
    await host(id, u.id);
    if (userId === u.id) throw badRequest('Use Speak to go on stage yourself.');
    const t = await target(id, userId);
    if (t.role !== 'listener') throw badRequest('They are already a speaker.');
    if (await isBlockedEitherWay(db, u.id, userId)) throw forbidden("You can't invite this person to speak.");
    const safe = await db.query<{ ok: boolean }>(`SELECT ${roomStageRuleSql('$1::uuid', '$2::uuid')} AS ok`, [u.id, userId]);
    if (!safe.rows[0]?.ok) throw new AppError(403, 'minor_protection', 'To keep younger people safe, you can only invite them to speak once you are friends.');
    if ((await count(db, id, 'speaker')) >= media.limits.speakers) throw roomFull('speakers');
    await db.query(`UPDATE room_participants SET invited_at = now(), invited_by = $3 WHERE room_id = $1 AND user_id = $2`, [id, userId, u.id]);
    await ctx.realtime.publish([userId], { type: 'room.invited', data: { roomId: id, by: u.id } });
    await publishRoomState(deps, id);
    return { ok: true };
  });

  /** Go on stage: a listener accepting a host's invite, or a host stepping up. `accept: false` declines the invite. */
  app.post('/v1/rooms/:id/speak', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { accept } = parse(z.object({ accept: z.boolean().default(true) }), req.body ?? {});
    const r = await present(id, u.id);
    if (r.role === 'speaker') return { role: 'speaker' };
    if (!accept) {
      await db.query(`UPDATE room_participants SET invited_at = NULL, invited_by = NULL WHERE room_id = $1 AND user_id = $2`, [id, u.id]);
      await publishRoomState(deps, id);
      return { role: 'listener' };
    }
    if (!r.is_host && !r.invited_at) throw forbidden('A host needs to invite you to speak first. Raise your hand to ask.');
    await tx(db, async (c) => {
      await c.query(`SELECT 1 FROM rooms WHERE id = $1 FOR UPDATE`, [id]);
      if ((await count(c, id, 'speaker')) >= media.limits.speakers) throw roomFull('speakers');
      // The inviter may have left or lost the right since; the rule is checked again against them.
      if (!r.is_host && r.invited_by) {
        const safe = await c.query<{ ok: boolean }>(`SELECT ${roomStageRuleSql('$1::uuid', '$2::uuid')} AS ok`, [r.invited_by, u.id]);
        if (!safe.rows[0]?.ok) throw new AppError(403, 'minor_protection', 'To keep younger people safe, this invite no longer works.');
      }
      await c.query(
        `UPDATE room_participants SET role = 'speaker', muted = true, hand_raised_at = NULL, invited_at = NULL, invited_by = NULL WHERE room_id = $1 AND user_id = $2`,
        [id, u.id],
      );
    });
    await changed(id, u.id, 'speaker');
    return { role: 'speaker' };
  });

  /** A host mutes a speaker. The speaker can unmute when they are ready to talk again. */
  app.post('/v1/rooms/:id/participants/:userId/mute', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id, userId } = parse(targetParam, req.params);
    await host(id, u.id);
    const t = await target(id, userId);
    if (t.role !== 'speaker') throw badRequest('Only speakers can be muted.');
    await db.query(`UPDATE room_participants SET muted = true WHERE room_id = $1 AND user_id = $2`, [id, userId]);
    await publishRoomState(deps, id);
    return { ok: true };
  });

  /** Back to listening: a host moves a speaker, or a speaker steps down themselves. */
  app.post('/v1/rooms/:id/participants/:userId/listener', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id, userId } = parse(targetParam, req.params);
    if (userId === u.id) {
      const r = await present(id, u.id);
      if (r.role !== 'speaker') return { ok: true };
    } else {
      await host(id, u.id);
      if ((await target(id, userId)).role !== 'speaker') return { ok: true };
    }
    await db.query(
      `UPDATE room_participants SET role = 'listener', muted = true, hand_raised_at = NULL, invited_at = NULL, invited_by = NULL WHERE room_id = $1 AND user_id = $2`,
      [id, userId],
    );
    await changed(id, userId, 'listener');
    return { ok: true };
  });

  /** A host removes someone. They can't come back to this room. */
  app.post('/v1/rooms/:id/participants/:userId/remove', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id, userId } = parse(targetParam, req.params);
    await host(id, u.id);
    if (userId === u.id) throw badRequest('Use Leave to go.');
    await target(id, userId);
    await db.query(
      `UPDATE room_participants SET left_at = now(), removed_at = now(), removed_by = $3, hand_raised_at = NULL, invited_at = NULL WHERE room_id = $1 AND user_id = $2`,
      [id, userId, u.id],
    );
    await ctx.realtime.publish([userId], { type: 'room.removed', data: { roomId: id } });
    await changed(id, userId, null);
    await audit(db, { actorId: u.id, action: 'room.remove', entityType: 'room', entityId: id, metadata: { userId } });
    return { ok: true };
  });

  app.post('/v1/rooms/:id/reactions', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { kind } = parse(z.object({ kind: z.enum(ROOM_REACTIONS) }), req.body);
    await present(id, u.id);
    const { rows } = await db.query<{ user_id: string }>(`SELECT user_id FROM room_participants WHERE room_id = $1 AND left_at IS NULL`, [id]);
    await ctx.realtime.publish(
      rows.map((r) => r.user_id),
      { type: 'room.reaction', data: { roomId: id, userId: u.id, kind } },
    );
    return { ok: true };
  });

  /**
   * Relays WebRTC signaling to one other person in the room. Both must be in the
   * live room now, still members of the community, not blocking each other, and
   * connected by the media adapter (in the mesh: at least one is a speaker).
   */
  app.post('/v1/rooms/:id/signal', { preHandler: requireAuth, config: { rateLimit: { max: 900, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(z.object({ toUserId: z.string().uuid(), type: z.enum(['offer', 'answer', 'candidate']), data: z.unknown() }), req.body);
    if (JSON.stringify(input.data ?? null).length > 64_000) throw badRequest('Signal payload is too large.');
    if (input.toUserId === u.id) throw notFound('Participant');
    const { rows } = await db.query<{ from_role: 'speaker' | 'listener'; to_role: 'speaker' | 'listener' }>(
      `SELECT a.role AS from_role, b.role AS to_role
       FROM rooms r
       JOIN room_participants a ON a.room_id = r.id AND a.user_id = $2 AND a.left_at IS NULL
       JOIN room_participants b ON b.room_id = r.id AND b.user_id = $3 AND b.left_at IS NULL
       JOIN community_members ca ON ca.community_id = r.community_id AND ca.user_id = a.user_id AND ca.status = 'active'
       JOIN community_members cb ON cb.community_id = r.community_id AND cb.user_id = b.user_id AND cb.status = 'active'
       WHERE r.id = $1 AND r.status = 'live'
         AND NOT EXISTS (SELECT 1 FROM blocks bl WHERE (bl.blocker_id = $2 AND bl.blocked_id = $3) OR (bl.blocker_id = $3 AND bl.blocked_id = $2))`,
      [id, u.id, input.toUserId],
    );
    const pair = rows[0];
    if (!pair) throw notFound('Participant');
    if (!media.connects(pair.from_role, pair.to_role)) throw forbidden('Listeners only hear speakers.');
    await media.relay(id, u.id, input.toUserId, input.type, input.data);
    return { ok: true };
  });
}
