import type { FastifyInstance } from 'fastify';
import { tx } from '@yapilapi/database';
import { createConversationSchema, pageQuerySchema, sendMessageSchema, type Conversation, type Message } from '@yapilapi/shared';
import { z } from 'zod';
import { activeControls } from '../lib/family.ts';
import { AppError, badRequest, forbidden, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { decodeCursor, keyCursorOf, type KeyCursor } from '../lib/cursor.ts';
import { analyzeText } from '../lib/moderation.ts';
import { track } from '../lib/services.ts';
import { ageOf, areFriends, isBlockedEitherWay, publicUserFrom, usersByIds } from '../lib/users.ts';
import { me, requireAuth, resolveSession, sessionTokenOf } from '../plugins/auth.ts';

const idParam = z.object({ id: z.string().uuid() });

export default async function messagingModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;

  async function assertMember(conversationId: string, userId: string) {
    const r = await db.query(`SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`, [conversationId, userId]);
    if (!r.rowCount) throw notFound('Conversation');
  }

  async function memberIds(conversationId: string): Promise<string[]> {
    const { rows } = await db.query<{ user_id: string }>(`SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND left_at IS NULL`, [
      conversationId,
    ]);
    return rows.map((r) => r.user_id);
  }

  /**
   * Minor safety + anti-abuse: nobody can message someone who blocked them, and
   * adults can only message a minor they are already friends with.
   */
  async function assertCanMessage(senderId: string, senderBirth: Date | null, recipientId: string) {
    if (await isBlockedEitherWay(db, senderId, recipientId)) throw forbidden("You can't message this person.");
    const r = await db.query<{ birth_date: Date | null; status: string }>(`SELECT birth_date, status FROM users WHERE id = $1`, [recipientId]);
    if (!r.rows[0] || r.rows[0].status !== 'active') throw notFound('That person');
    const recipientAge = ageOf(r.rows[0].birth_date);
    const senderAge = ageOf(senderBirth);
    const minorInvolved = (recipientAge !== null && recipientAge < 18) !== (senderAge !== null && senderAge < 18);
    // A guardian the teen accepted through a family link counts like a friend here.
    const linked = minorInvolved
      ? (
          await db.query(
            `SELECT 1 FROM family_links WHERE status = 'active' AND ((guardian_id = $1 AND teen_id = $2) OR (guardian_id = $2 AND teen_id = $1))`,
            [senderId, recipientId],
          )
        ).rowCount
      : 0;
    if (minorInvolved && !linked && !(await areFriends(db, senderId, recipientId)))
      throw new AppError(403, 'minor_protection', 'To keep younger people safe, you can only message them once you are friends.');
    // Family controls apply both ways: a supervised teen's setting limits who they can message and who can message them. Guardians can always.
    for (const [teen, other] of [
      [recipientId, senderId],
      [senderId, recipientId],
    ] as const) {
      const controls = await activeControls(db, teen);
      if (!controls || controls.guardianIds.includes(other)) continue;
      if (controls.messagesFrom === 'nobody' || !(await areFriends(db, senderId, recipientId)))
        throw new AppError(403, 'family_controls', 'Family settings on this account limit who it can message.');
    }
  }

  async function loadConversations(userId: string, ids?: string[]): Promise<Conversation[]> {
    const { rows } = await db.query(
      `SELECT c.id, c.kind, c.title, c.last_message_at, cm.last_read_at,
         (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id AND m.created_at > cm.last_read_at AND m.sender_id <> $1 AND m.deleted_at IS NULL) AS unread,
         (SELECT array_agg(user_id) FROM conversation_members WHERE conversation_id = c.id AND left_at IS NULL) AS member_ids,
         lm.id AS lm_id, lm.body AS lm_body, lm.created_at AS lm_created_at, lm.sender_id AS lm_sender, lm.attachments AS lm_attachments
       FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id
       LEFT JOIN LATERAL (SELECT id, body, created_at, sender_id, attachments FROM messages WHERE conversation_id = c.id AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1) lm ON true
       WHERE cm.user_id = $1 AND cm.left_at IS NULL ${ids ? 'AND c.id = ANY($2)' : ''}
       ORDER BY c.last_message_at DESC LIMIT 100`,
      ids ? [userId, ids] : [userId],
    );
    const users = await usersByIds(db, [...new Set(rows.flatMap((r) => r.member_ids ?? []))]);
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      members: (r.member_ids ?? []).map((id: string) => users.get(id)).filter(Boolean),
      lastMessage: r.lm_id
        ? {
            id: r.lm_id,
            conversationId: r.id,
            sender: users.get(r.lm_sender)!,
            body: r.lm_body,
            replyToId: null,
            attachments: r.lm_attachments,
            createdAt: r.lm_created_at.toISOString(),
          }
        : null,
      unreadCount: r.unread,
      updatedAt: r.last_message_at.toISOString(),
    }));
  }

  app.get('/v1/conversations', { preHandler: requireAuth }, async (req) => ({ items: await loadConversations(me(req).id) }));

  app.get('/v1/conversations/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    await assertMember(id, me(req).id);
    const [conversation] = await loadConversations(me(req).id, [id]);
    return { conversation };
  });

  /** One member → direct conversation (reused if it exists). Several → a group. */
  app.post('/v1/conversations', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = me(req);
    const input = parse(createConversationSchema, req.body);
    const others = [...new Set(input.memberIds.filter((id) => id !== u.id))];
    if (!others.length) throw badRequest('Add at least one other person.');
    for (const id of others) await assertCanMessage(u.id, u.birthDate, id);

    if (others.length === 1 && !input.title) {
      const key = [u.id, others[0]!].sort().join(':');
      const id = await tx(db, async (c) => {
        const existing = await c.query<{ id: string }>(`SELECT id FROM conversations WHERE direct_key = $1`, [key]);
        if (existing.rows[0]) {
          await c.query(`UPDATE conversation_members SET left_at = NULL WHERE conversation_id = $1 AND user_id = $2`, [existing.rows[0].id, u.id]);
          return existing.rows[0].id;
        }
        const { rows } = await c.query<{ id: string }>(`INSERT INTO conversations (kind, direct_key, created_by) VALUES ('direct',$1,$2) RETURNING id`, [
          key,
          u.id,
        ]);
        await c.query(`INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1,$2),($1,$3)`, [rows[0]!.id, u.id, others[0]]);
        return rows[0]!.id;
      });
      reply.code(201);
      return { conversation: (await loadConversations(u.id, [id]))[0] };
    }

    const id = await tx(db, async (c) => {
      const { rows } = await c.query<{ id: string }>(`INSERT INTO conversations (kind, title, created_by) VALUES ('group',$1,$2) RETURNING id`, [
        input.title ?? null,
        u.id,
      ]);
      const cid = rows[0]!.id;
      await c.query(`INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1,$2,'admin')`, [cid, u.id]);
      await c.query(`INSERT INTO conversation_members (conversation_id, user_id) SELECT $1, unnest($2::uuid[])`, [cid, others]);
      return cid;
    });
    await ctx.realtime.publish(others, { type: 'conversation.created', data: { id } });
    reply.code(201);
    return { conversation: (await loadConversations(u.id, [id]))[0] };
  });

  app.post('/v1/conversations/:id/members', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { userIds } = parse(z.object({ userIds: z.array(z.string().uuid()).min(1).max(50) }), req.body);
    const conv = await db.query(
      `SELECT c.kind, cm.role FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id WHERE c.id = $1 AND cm.user_id = $2 AND cm.left_at IS NULL`,
      [id, u.id],
    );
    if (!conv.rows[0]) throw notFound('Conversation');
    if (conv.rows[0].kind !== 'group') throw badRequest('You can only add people to group conversations.');
    for (const other of userIds) await assertCanMessage(u.id, u.birthDate, other);
    await db.query(
      `INSERT INTO conversation_members (conversation_id, user_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT (conversation_id, user_id) DO UPDATE SET left_at = NULL`,
      [id, userIds],
    );
    return { ok: true };
  });

  app.post('/v1/conversations/:id/leave', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    await assertMember(id, me(req).id);
    await db.query(`UPDATE conversation_members SET left_at = now() WHERE conversation_id = $1 AND user_id = $2`, [id, me(req).id]);
    return { ok: true };
  });

  app.get('/v1/conversations/:id/messages', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const q = parse(pageQuerySchema, req.query);
    await assertMember(id, u.id);
    const c = decodeCursor<KeyCursor>(q.cursor);
    const { rows } = await db.query(
      `SELECT m.id, m.conversation_id, m.body, m.reply_to_id, m.attachments, m.created_at, m.client_id,
              pr.user_id AS s_id, pr.username AS s_username, pr.display_name AS s_display_name, pr.avatar_url AS s_avatar_url, pr.mode AS s_mode
       FROM messages m JOIN profiles pr ON pr.user_id = m.sender_id
       WHERE m.conversation_id = $1 AND m.deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = $2 AND b.blocked_id = m.sender_id)
         ${c ? 'AND (m.created_at, m.id) < ($4::timestamptz, $5::uuid)' : ''}
       ORDER BY m.created_at DESC, m.id DESC LIMIT $3`,
      c ? [id, u.id, q.limit + 1, c.t, c.id] : [id, u.id, q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    const items: Message[] = page.map(toMessage).reverse();
    return { items, nextCursor: rows.length > q.limit ? keyCursorOf(page.at(-1)!) : null };
  });

  app.post('/v1/conversations/:id/messages', { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(sendMessageSchema, req.body);
    await assertMember(id, u.id);
    const members = await memberIds(id);
    const conv = (await db.query(`SELECT kind FROM conversations WHERE id = $1`, [id])).rows[0];
    if (conv.kind === 'direct') {
      const other = members.find((m) => m !== u.id);
      if (other) await assertCanMessage(u.id, u.birthDate, other);
    }
    const analysis = analyzeText(input.body);
    if (analysis.risk === 'escalate') {
      await db.query(
        `INSERT INTO moderation_cases (target_type, target_id, subject_user_id, source, risk, signals) VALUES ('message', $1, $2, 'automated', 'escalate', $3) ON CONFLICT DO NOTHING`,
        [id, u.id, { signals: analysis.signals }],
      );
      throw new AppError(422, 'content_blocked', "This message wasn't sent because it may put someone at risk.");
    }
    // Attachments are the sender's own uploads; their address and kind come from storage, never from the request.
    let attachments: Message['attachments'] = [];
    if (input.attachments.length) {
      const ids = input.attachments.map((a) => a.mediaId);
      const { rows: media } = await db.query(
        `SELECT id, kind, url, variants, poster_url, duration_ms FROM media WHERE id = ANY($1::uuid[]) AND owner_id = $2 AND status <> 'failed'`,
        [ids, u.id],
      );
      if (media.length !== new Set(ids).size) throw notFound('That photo, video or voice message');
      const byId = new Map(media.map((m) => [m.id as string, m]));
      attachments = input.attachments.map((a) => {
        const m = byId.get(a.mediaId)!;
        return {
          mediaId: m.id,
          kind: m.kind,
          url: m.variants?.mp4 ?? m.variants?.large ?? m.url,
          name: a.name,
          durationMs: m.duration_ms ?? null,
          posterUrl: m.poster_url ?? null,
        };
      });
    }
    const row = await tx(db, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO messages (conversation_id, sender_id, body, reply_to_id, attachments, client_id) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (sender_id, client_id) WHERE client_id IS NOT NULL DO UPDATE SET client_id = EXCLUDED.client_id
         RETURNING id, conversation_id, body, reply_to_id, attachments, created_at, client_id`,
        [id, u.id, input.body, input.replyToId ?? null, JSON.stringify(attachments), input.clientId ?? null],
      );
      await c.query(`UPDATE conversations SET last_message_at = now() WHERE id = $1`, [id]);
      await c.query(`UPDATE conversation_members SET last_read_at = now() WHERE conversation_id = $1 AND user_id = $2`, [id, u.id]);
      return rows[0];
    });
    const sender = (await usersByIds(db, [u.id])).get(u.id)!;
    const message: Message = {
      id: row.id,
      conversationId: id,
      sender,
      body: row.body,
      replyToId: row.reply_to_id,
      attachments: row.attachments,
      createdAt: row.created_at.toISOString(),
      clientId: row.client_id,
    };
    await ctx.realtime.publish(members, { type: 'message.created', data: message });
    track(db, u.id, 'message_sent', { kind: conv.kind });
    reply.code(201);
    return { message };
  });

  app.post('/v1/conversations/:id/read', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    await assertMember(id, me(req).id);
    await db.query(`UPDATE conversation_members SET last_read_at = now() WHERE conversation_id = $1 AND user_id = $2`, [id, me(req).id]);
    return { ok: true };
  });

  app.delete('/v1/messages/:id', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const r = await db.query(
      `UPDATE messages SET deleted_at = now(), body = '', attachments = '[]' WHERE id = $1 AND sender_id = $2 AND deleted_at IS NULL RETURNING conversation_id`,
      [id, u.id],
    );
    if (!r.rowCount) throw notFound('Message');
    await ctx.realtime.publish(await memberIds(r.rows[0].conversation_id), {
      type: 'message.deleted',
      data: { id, conversationId: r.rows[0].conversation_id },
    });
    return { ok: true };
  });

  app.put('/v1/messages/:id/reactions/:emoji', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id, emoji } = parse(z.object({ id: z.string().uuid(), emoji: z.string().min(1).max(16) }), req.params);
    const m = await db.query(`SELECT conversation_id FROM messages WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!m.rows[0]) throw notFound('Message');
    await assertMember(m.rows[0].conversation_id, u.id);
    await db.query(`INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [id, u.id, emoji]);
    await ctx.realtime.publish(await memberIds(m.rows[0].conversation_id), { type: 'message.reaction', data: { id, emoji, userId: u.id } });
    return { ok: true };
  });

  // Plans: turn a conversation into a structured activity. The AI suggests; people confirm.
  app.post('/v1/conversations/:id/plans', { preHandler: requireAuth }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(z.object({ title: z.string().trim().min(1).max(120), details: z.record(z.string(), z.unknown()).default({}) }), req.body);
    await assertMember(id, u.id);
    const { rows } = await db.query(
      `INSERT INTO plans (conversation_id, created_by, title, details) VALUES ($1,$2,$3,$4) RETURNING id, title, details, status, created_at`,
      [id, u.id, input.title, input.details],
    );
    await ctx.realtime.publish(await memberIds(id), { type: 'plan.created', data: rows[0] });
    reply.code(201);
    return { plan: rows[0] };
  });

  app.get('/v1/conversations/:id/plans', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    await assertMember(id, me(req).id);
    const { rows } = await db.query(`SELECT id, title, details, status, created_at FROM plans WHERE conversation_id = $1 ORDER BY created_at DESC`, [id]);
    return { items: rows };
  });

  // ── Realtime socket ───────────────────────────────────────────────────
  app.get('/v1/realtime', { websocket: true }, async (socket, req) => {
    const user = await resolveSession(ctx, sessionTokenOf(req) ?? (req.query as { token?: string }).token);
    if (!user) {
      socket.close(4401, 'unauthorized');
      return;
    }
    const remove = ctx.realtime.add(user.id, socket);
    socket.send(JSON.stringify({ type: 'ready', data: { userId: user.id } }));
    socket.on('message', async (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type: string; conversationId?: string };
        if (msg.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
        if (msg.type === 'typing' && msg.conversationId) {
          const ids = await memberIds(msg.conversationId);
          if (ids.includes(user.id))
            await ctx.realtime.publish(
              ids.filter((i) => i !== user.id),
              { type: 'typing', data: { conversationId: msg.conversationId, userId: user.id } },
            );
        }
      } catch {
        /* ignore malformed frames */
      }
    });
    socket.on('close', remove);
  });
}

function toMessage(r: Record<string, any>): Message {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    sender: publicUserFrom(r, 's_'),
    body: r.body,
    replyToId: r.reply_to_id,
    attachments: r.attachments,
    createdAt: r.created_at.toISOString(),
    clientId: r.client_id,
  };
}
