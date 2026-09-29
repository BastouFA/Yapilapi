import type { FastifyInstance } from 'fastify';
import { tx } from '@yapilapi/database';
import { z } from 'zod';
import { AppError, badRequest, forbidden, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { iceServers as turnIceServers } from '../lib/ice.ts';
import { messagesAllowed } from '../lib/interactions.ts';
import { enqueue } from '../lib/jobs.ts';
import { notify, track } from '../lib/services.ts';
import { ageOf, areFriends, isBlockedEitherWay, publicUserFrom } from '../lib/users.ts';
import { me, requireAuth } from '../plugins/auth.ts';

const RING_SECONDS = 45;
const RING_TIMEOUT_JOB = 'calls.ring_timeout';

/**
 * Audio and video calls. Media flows peer to peer over WebRTC; the API only
 * relays signaling (offer, answer, ICE candidates) between call participants
 * through the realtime socket, and keeps call history. Group calls beyond a
 * few people need an SFU (media server), which plugs in behind the same API.
 *
 * When a call is over (missed, declined or ended) a line goes in the chat ("Missed video call",
 * "Audio call, 3 minutes"), so the chat keeps its history, and everyone in the call gets `call.ended`.
 */
export default async function callsModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;

  /** STUN plus time-limited TURN credentials (see lib/ice.ts; audio rooms use the same ones). */
  const iceServers = (userId?: string) => turnIceServers(ctx.config, userId);

  /**
   * Close a call that is still ringing or going (a no-op otherwise): `status` for a ringing one
   * ('missed' or 'declined'); a going one ends. Writes the line in the chat and tells everyone in it.
   */
  async function finish(callId: string, ringing: 'missed' | 'declined' = 'missed') {
    const { rows } = await db.query(
      `UPDATE calls SET status = CASE WHEN status = 'ringing' THEN $2 ELSE 'ended' END, ended_at = now()
       WHERE id = $1 AND status IN ('ringing', 'active')
       RETURNING id, conversation_id, caller_id, kind, status, answered_at, ended_at,
                 (SELECT array_agg(user_id) FROM call_participants WHERE call_id = calls.id) AS participants`,
      [callId, ringing],
    );
    const c = rows[0];
    if (!c) return;
    const seconds = c.answered_at ? Math.max(0, Math.round((c.ended_at.getTime() - c.answered_at.getTime()) / 1000)) : null;
    const line = await db.query(`INSERT INTO messages (conversation_id, sender_id, body, kind, meta) VALUES ($1,$2,'','system',$3) RETURNING id, created_at`, [
      c.conversation_id,
      c.caller_id,
      { type: 'call', callId, kind: c.kind, outcome: c.status, seconds },
    ]);
    await db.query(`UPDATE conversations SET last_message_at = now() WHERE id = $1`, [c.conversation_id]);
    const sender = await db.query(
      `SELECT user_id AS s_id, username AS s_username, display_name AS s_display_name, avatar_url AS s_avatar_url, mode AS s_mode FROM profiles WHERE user_id = $1`,
      [c.caller_id],
    );
    const members = (
      await db.query<{ user_id: string }>(`SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND left_at IS NULL`, [c.conversation_id])
    ).rows.map((r) => r.user_id);
    await ctx.realtime.publish(members, {
      type: 'message.created',
      data: {
        id: line.rows[0].id,
        conversationId: c.conversation_id,
        sender: publicUserFrom(sender.rows[0] ?? {}, 's_'),
        body: '',
        replyToId: null,
        attachments: [],
        createdAt: line.rows[0].created_at.toISOString(),
        clientId: null,
        kind: 'system',
        system: { type: 'call', callId, kind: c.kind, outcome: c.status, seconds },
      },
    });
    await ctx.realtime.publish(c.participants ?? [], { type: 'call.ended', data: { callId, status: c.status } });
  }

  // Nobody answered in time: the call is missed, even when every app that rang has gone.
  ctx.jobs[RING_TIMEOUT_JOB] = async ({ id }: { id: string }) => {
    const r = await db.query(`SELECT 1 FROM calls WHERE id = $1 AND status = 'ringing'`, [id]);
    if (r.rowCount) await finish(id, 'missed');
  };

  async function loadCall(id: string, userId: string) {
    const { rows } = await db.query(
      `SELECT c.*, (SELECT array_agg(user_id) FROM call_participants WHERE call_id = c.id) AS participants,
              (c.status = 'ringing' AND c.created_at < now() - make_interval(secs => $3)) AS ring_expired
       FROM calls c
       WHERE c.id = $1 AND EXISTS (SELECT 1 FROM call_participants p WHERE p.call_id = c.id AND p.user_id = $2)`,
      [id, userId, RING_SECONDS],
    );
    const c = rows[0];
    if (!c) throw notFound('Call');
    // Ringing calls nobody answered become missed. Timed by the database clock, which also stamped created_at.
    if (c.ring_expired) {
      await finish(id, 'missed');
      c.status = 'missed';
    }
    return c;
  }

  function dto(c: Record<string, any>) {
    return {
      id: c.id,
      conversationId: c.conversation_id,
      callerId: c.caller_id,
      kind: c.kind,
      status: c.status,
      participants: c.participants,
      createdAt: c.created_at,
      answeredAt: c.answered_at,
      endedAt: c.ended_at,
    };
  }

  /**
   * One-to-one calls follow the rules for messaging: an adult can call someone under 18 only when
   * they're friends (or linked through family), and "Who can message you" covers calls too.
   */
  async function assertCanCall(callerId: string, otherId: string) {
    const { rows } = await db.query<{ id: string; birth_date: Date | null }>(`SELECT id, birth_date FROM users WHERE id = ANY($1::uuid[])`, [
      [callerId, otherId],
    ]);
    const minor = (id: string) => {
      const age = ageOf(rows.find((r) => r.id === id)?.birth_date ?? null);
      return age !== null && age < 18;
    };
    if (minor(callerId) !== minor(otherId)) {
      const linked = (
        await db.query(`SELECT 1 FROM family_links WHERE status = 'active' AND ((guardian_id = $1 AND teen_id = $2) OR (guardian_id = $2 AND teen_id = $1))`, [
          callerId,
          otherId,
        ])
      ).rowCount;
      if (!linked && !(await areFriends(db, callerId, otherId)))
        throw new AppError(403, 'minor_protection', 'To keep younger people safe, you can only call them once you are friends.');
    }
    if (!(await messagesAllowed(db, callerId, otherId))) throw new AppError(403, 'messages_limited', 'This person only gets calls from people they know.');
  }

  app.get('/v1/calls/ice-servers', { preHandler: requireAuth }, async (req) => ({ iceServers: iceServers(me(req).id) }));

  app.post('/v1/conversations/:id/calls', { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const { kind } = parse(z.object({ kind: z.enum(['audio', 'video']).default('video') }), req.body ?? {});
    const members = (
      await db.query<{ user_id: string }>(`SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND left_at IS NULL`, [id])
    ).rows.map((r) => r.user_id);
    if (!members.includes(u.id)) throw notFound('Conversation');
    const conv = (await db.query<{ kind: string }>(`SELECT kind FROM conversations WHERE id = $1`, [id])).rows[0]!;
    if (conv.kind === 'community') throw badRequest('Calls work in one-to-one chats and groups of up to 8 people.');
    if (members.length < 2) throw badRequest('There’s nobody else here to call.');
    if (members.length > 8) throw badRequest('Calls support up to 8 people.');
    for (const m of members) if (m !== u.id && (await isBlockedEitherWay(db, u.id, m))) throw forbidden("You can't call this conversation.");
    if (conv.kind === 'direct')
      await assertCanCall(
        u.id,
        members.find((m) => m !== u.id)!,
      );
    // Clear stale ringing calls before starting a new one.
    const stale = await db.query<{ id: string }>(
      `SELECT id FROM calls WHERE conversation_id = $1 AND status = 'ringing' AND created_at < now() - make_interval(secs => $2)`,
      [id, RING_SECONDS],
    );
    for (const s of stale.rows) await finish(s.id, 'missed');
    const callId = await tx(db, async (c) => {
      const r = await c.query(`INSERT INTO calls (conversation_id, caller_id, kind) VALUES ($1,$2,$3) RETURNING id`, [id, u.id, kind]).catch((e) => {
        if (e.code === '23505') throw new AppError(409, 'call_in_progress', 'There is already a call in this conversation.');
        throw e;
      });
      await c.query(`INSERT INTO call_participants (call_id, user_id, joined_at) SELECT $1, unnest($2::uuid[]), NULL`, [r.rows[0].id, members]);
      await c.query(`UPDATE call_participants SET joined_at = now() WHERE call_id = $1 AND user_id = $2`, [r.rows[0].id, u.id]);
      await enqueue(c, RING_TIMEOUT_JOB, { id: r.rows[0].id }, RING_SECONDS + 2);
      return r.rows[0].id as string;
    });
    const call = dto(await loadCall(callId, u.id));
    await ctx.realtime.publish(
      members.filter((m) => m !== u.id),
      { type: 'call.incoming', data: call },
    );
    for (const m of members.filter((x) => x !== u.id))
      await notify(db, ctx.realtime, {
        userId: m,
        category: 'messages',
        type: 'call_incoming',
        actorId: u.id,
        entityType: 'call',
        entityId: callId,
        data: { kind },
      });
    track(db, u.id, 'call_started', { kind, size: members.length });
    reply.code(201);
    return { call, iceServers: iceServers(me(req).id) };
  });

  app.get('/v1/calls/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    return { call: dto(await loadCall(id, me(req).id)), iceServers: iceServers(me(req).id) };
  });

  app.post('/v1/calls/:id/answer', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const c = await loadCall(id, u.id);
    if (!['ringing', 'active'].includes(c.status)) throw badRequest('This call has ended.');
    await db.query(`UPDATE calls SET status = 'active', answered_at = coalesce(answered_at, now()) WHERE id = $1`, [id]);
    await db.query(`UPDATE call_participants SET joined_at = now(), left_at = NULL WHERE call_id = $1 AND user_id = $2`, [id, u.id]);
    const call = dto(await loadCall(id, u.id));
    await ctx.realtime.publish(call.participants, { type: 'call.answered', data: { callId: id, userId: u.id } });
    return { call, iceServers: iceServers(me(req).id) };
  });

  /** Say no to a call (`busy`: the app did, because you're on another one). When nobody else is left, it's over. */
  app.post('/v1/calls/:id/decline', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const { busy } = parse(z.object({ busy: z.boolean().default(false) }), req.body ?? {});
    const c = await loadCall(id, u.id);
    await db.query(`UPDATE call_participants SET left_at = now() WHERE call_id = $1 AND user_id = $2`, [id, u.id]);
    await ctx.realtime.publish(c.participants, { type: 'call.declined', data: { callId: id, userId: u.id, ...(busy ? { busy: true } : {}) } });
    // Over when fewer than two are in it and nobody else is still being rung.
    const left = (
      await db.query<{ joined: number; ringing: number }>(
        `SELECT count(*) FILTER (WHERE joined_at IS NOT NULL AND left_at IS NULL)::int AS joined,
                count(*) FILTER (WHERE joined_at IS NULL AND left_at IS NULL)::int AS ringing
         FROM call_participants WHERE call_id = $1`,
        [id],
      )
    ).rows[0]!;
    if (left.joined < 2 && !left.ringing) await finish(id, 'declined');
    return { ok: true };
  });

  app.post('/v1/calls/:id/end', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const c = await loadCall(id, u.id);
    await db.query(`UPDATE call_participants SET left_at = now() WHERE call_id = $1 AND user_id = $2`, [id, u.id]);
    await ctx.realtime.publish(c.participants, { type: 'call.left', data: { callId: id, userId: u.id } });
    const still = await db.query(`SELECT count(*) AS n FROM call_participants WHERE call_id = $1 AND joined_at IS NOT NULL AND left_at IS NULL`, [id]);
    if (Number(still.rows[0].n) < 2) await finish(id, 'missed');
    return { call: dto(await loadCall(id, u.id)) };
  });

  /** Relays WebRTC signaling to one other participant. Payloads are opaque and size-capped. */
  app.post('/v1/calls/:id/signal', { preHandler: requireAuth, config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const input = parse(z.object({ toUserId: z.string().uuid(), type: z.enum(['offer', 'answer', 'candidate', 'renegotiate']), data: z.unknown() }), req.body);
    if (JSON.stringify(input.data ?? null).length > 64_000) throw badRequest('Signal payload is too large.');
    const c = await loadCall(id, u.id);
    if (!['ringing', 'active'].includes(c.status)) throw badRequest('This call has ended.');
    if (!c.participants.includes(input.toUserId) || input.toUserId === u.id) throw notFound('Participant');
    await ctx.realtime.publish([input.toUserId], { type: 'call.signal', data: { callId: id, from: u.id, type: input.type, data: input.data } });
    return { ok: true };
  });

  app.get('/v1/conversations/:id/calls', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const { rows } = await db.query(
      `SELECT c.*, (SELECT array_agg(user_id) FROM call_participants WHERE call_id = c.id) AS participants FROM calls c
       WHERE c.conversation_id = $1 AND EXISTS (SELECT 1 FROM call_participants p WHERE p.call_id = c.id AND p.user_id = $2) ORDER BY c.created_at DESC LIMIT 50`,
      [id, u.id],
    );
    return { items: rows.map(dto) };
  });
}
