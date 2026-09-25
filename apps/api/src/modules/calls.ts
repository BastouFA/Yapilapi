import type { FastifyInstance } from 'fastify';
import { tx } from '@yapilapi/database';
import { z } from 'zod';
import { AppError, badRequest, forbidden, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { notify, track } from '../lib/services.ts';
import { isBlockedEitherWay } from '../lib/users.ts';
import { me, requireAuth } from '../plugins/auth.ts';

const RING_SECONDS = 45;

/**
 * Audio and video calls. Media flows peer to peer over WebRTC; the API only
 * relays signaling (offer, answer, ICE candidates) between call participants
 * through the realtime socket, and keeps call history. Group calls beyond a
 * few people need an SFU (media server), which plugs in behind the same API.
 */
export default async function callsModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;

  function iceServers() {
    const servers: { urls: string | string[]; username?: string; credential?: string }[] = [{ urls: 'stun:stun.l.google.com:19302' }];
    const turn = process.env.TURN_URL;
    if (turn) servers.push({ urls: turn, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
    return servers;
  }

  async function loadCall(id: string, userId: string) {
    const { rows } = await db.query(
      `SELECT c.*, (SELECT array_agg(user_id) FROM call_participants WHERE call_id = c.id) AS participants FROM calls c
       WHERE c.id = $1 AND EXISTS (SELECT 1 FROM call_participants p WHERE p.call_id = c.id AND p.user_id = $2)`,
      [id, userId],
    );
    const c = rows[0];
    if (!c) throw notFound('Call');
    // Ringing calls nobody answered become missed.
    if (c.status === 'ringing' && Date.now() - c.created_at.getTime() > RING_SECONDS * 1000) {
      await db.query(`UPDATE calls SET status = 'missed', ended_at = now() WHERE id = $1 AND status = 'ringing'`, [id]);
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

  app.get('/v1/calls/ice-servers', { preHandler: requireAuth }, async () => ({ iceServers: iceServers() }));

  app.post('/v1/conversations/:id/calls', { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const { kind } = parse(z.object({ kind: z.enum(['audio', 'video']).default('video') }), req.body ?? {});
    const members = (
      await db.query<{ user_id: string }>(`SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND left_at IS NULL`, [id])
    ).rows.map((r) => r.user_id);
    if (!members.includes(u.id)) throw notFound('Conversation');
    if (members.length > 8) throw badRequest('Calls support up to 8 people.');
    for (const m of members) if (m !== u.id && (await isBlockedEitherWay(db, u.id, m))) throw forbidden("You can't call this conversation.");
    // Clear stale ringing calls before starting a new one.
    await db.query(
      `UPDATE calls SET status = 'missed', ended_at = now() WHERE conversation_id = $1 AND status = 'ringing' AND created_at < now() - make_interval(secs => $2)`,
      [id, RING_SECONDS],
    );
    const callId = await tx(db, async (c) => {
      const r = await c.query(`INSERT INTO calls (conversation_id, caller_id, kind) VALUES ($1,$2,$3) RETURNING id`, [id, u.id, kind]).catch((e) => {
        if (e.code === '23505') throw new AppError(409, 'call_in_progress', 'There is already a call in this conversation.');
        throw e;
      });
      await c.query(`INSERT INTO call_participants (call_id, user_id, joined_at) SELECT $1, unnest($2::uuid[]), NULL`, [r.rows[0].id, members]);
      await c.query(`UPDATE call_participants SET joined_at = now() WHERE call_id = $1 AND user_id = $2`, [r.rows[0].id, u.id]);
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
    return { call, iceServers: iceServers() };
  });

  app.get('/v1/calls/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    return { call: dto(await loadCall(id, me(req).id)), iceServers: iceServers() };
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
    return { call, iceServers: iceServers() };
  });

  app.post('/v1/calls/:id/decline', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const c = await loadCall(id, u.id);
    await db.query(`UPDATE call_participants SET left_at = now() WHERE call_id = $1 AND user_id = $2`, [id, u.id]);
    // A 1:1 call ends when the other person declines.
    if (c.status === 'ringing' && c.participants.length === 2) await db.query(`UPDATE calls SET status = 'declined', ended_at = now() WHERE id = $1`, [id]);
    await ctx.realtime.publish(c.participants, { type: 'call.declined', data: { callId: id, userId: u.id } });
    return { ok: true };
  });

  app.post('/v1/calls/:id/end', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const c = await loadCall(id, u.id);
    await db.query(`UPDATE call_participants SET left_at = now() WHERE call_id = $1 AND user_id = $2`, [id, u.id]);
    const still = await db.query(`SELECT count(*) AS n FROM call_participants WHERE call_id = $1 AND joined_at IS NOT NULL AND left_at IS NULL`, [id]);
    if (Number(still.rows[0].n) < 2 && ['ringing', 'active'].includes(c.status))
      await db.query(`UPDATE calls SET status = CASE WHEN status = 'ringing' THEN 'missed' ELSE 'ended' END, ended_at = now() WHERE id = $1`, [id]);
    await ctx.realtime.publish(c.participants, { type: 'call.left', data: { callId: id, userId: u.id } });
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
