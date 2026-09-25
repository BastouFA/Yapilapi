import type { FastifyInstance } from 'fastify';
import { tx } from '@yapilapi/database';
import { COMMUNITY_ROLE_RANK, createCommunitySchema, pageQuerySchema, setMemberRoleSchema, type Community, type CommunityRole } from '@yapilapi/shared';
import { z } from 'zod';
import { AppError, badRequest, forbidden, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { decodeCursor, keyCursorOf, type KeyCursor } from '../lib/cursor.ts';
import { hydratePosts } from '../lib/posts.ts';
import { audit, notify, track } from '../lib/services.ts';
import { PUBLIC_USER_COLS, toPublicUser, type PublicUserRow } from '../lib/users.ts';
import { postVisibleSql } from '../lib/visibility.ts';
import { me, requireAuth } from '../plugins/auth.ts';

const slugParam = z.object({ slug: z.string().min(1).max(40) });

export default async function communitiesModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;

  const SELECT = `SELECT c.id, c.slug, c.name, c.description, c.visibility, c.member_count, c.topics, c.rules, c.created_at,
                         (SELECT role FROM community_members cm WHERE cm.community_id = c.id AND cm.user_id = $1 AND cm.status = 'active') AS my_role,
                         (SELECT status FROM community_members cm WHERE cm.community_id = c.id AND cm.user_id = $1) AS my_status
                  FROM communities c`;

  function toCommunity(r: Record<string, any>): Community & { membershipStatus: string | null } {
    return {
      id: r.id,
      slug: r.slug,
      name: r.name,
      description: r.description,
      visibility: r.visibility,
      memberCount: r.member_count,
      topics: r.topics,
      rules: r.rules,
      myRole: r.my_role,
      createdAt: r.created_at.toISOString(),
      membershipStatus: r.my_status ?? null,
    };
  }

  async function bySlug(slug: string, viewer: string | null) {
    const { rows } = await db.query(`${SELECT} WHERE lower(c.slug) = lower($2) AND c.deleted_at IS NULL`, [viewer, slug]);
    if (!rows[0]) throw notFound('Community');
    return rows[0];
  }

  async function roleOf(communityId: string, userId: string): Promise<CommunityRole | null> {
    const r = await db.query(`SELECT role FROM community_members WHERE community_id = $1 AND user_id = $2 AND status = 'active'`, [communityId, userId]);
    return r.rows[0]?.role ?? null;
  }

  function atLeast(role: CommunityRole | null, min: CommunityRole) {
    return role !== null && COMMUNITY_ROLE_RANK[role] >= COMMUNITY_ROLE_RANK[min];
  }

  app.post('/v1/communities', { preHandler: requireAuth, config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    const input = parse(createCommunitySchema, req.body);
    const id = await tx(db, async (c) => {
      const exists = await c.query(`SELECT 1 FROM communities WHERE lower(slug) = $1`, [input.slug]);
      if (exists.rowCount) throw new AppError(409, 'conflict', 'That address is taken. Try another.', { fields: { slug: 'Taken.' } });
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO communities (slug, name, description, visibility, owner_id, member_count, topics, rules) VALUES ($1,$2,$3,$4,$5,1,$6,$7) RETURNING id`,
        [input.slug, input.name, input.description, input.visibility, u.id, input.topics.map((t) => t.toLowerCase()), input.rules],
      );
      const cid = rows[0]!.id;
      await c.query(`INSERT INTO community_members (community_id, user_id, role) VALUES ($1,$2,'owner')`, [cid, u.id]);
      // Every community gets a shared chat.
      const conv = await c.query<{ id: string }>(
        `INSERT INTO conversations (kind, title, community_id, created_by) VALUES ('community',$1,$2,$3) RETURNING id`,
        [input.name, cid, u.id],
      );
      await c.query(`INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1,$2,'admin')`, [conv.rows[0]!.id, u.id]);
      await audit(c, { actorId: u.id, action: 'community.create', entityType: 'community', entityId: cid });
      return cid;
    });
    track(db, u.id, 'community_created');
    reply.code(201);
    const { rows } = await db.query(`${SELECT} WHERE c.id = $2`, [u.id, id]);
    return { community: toCommunity(rows[0]) };
  });

  app.get('/v1/communities', async (req) => {
    const viewer = req.user?.id ?? null;
    const q = parse(
      z.object({
        scope: z.enum(['discover', 'mine']).default('discover'),
        topic: z.string().max(40).optional(),
        limit: z.coerce.number().min(1).max(50).default(20),
      }),
      req.query,
    );
    if (q.scope === 'mine') {
      if (!viewer) return { items: [] };
      const { rows } = await db.query(
        `${SELECT} JOIN community_members m ON m.community_id = c.id AND m.user_id = $1 AND m.status = 'active' WHERE c.deleted_at IS NULL ORDER BY c.name LIMIT $2`,
        [viewer, q.limit],
      );
      return { items: rows.map(toCommunity) };
    }
    const { rows } = await db.query(
      `${SELECT} WHERE c.deleted_at IS NULL AND c.visibility = 'public' ${q.topic ? 'AND $3 = ANY(c.topics)' : ''}
       ORDER BY (SELECT count(*) FROM user_interests ui JOIN topics t ON t.id = ui.topic_id WHERE ui.user_id = $1 AND t.slug = ANY(c.topics)) DESC,
                c.member_count DESC, c.created_at DESC LIMIT $2`,
      q.topic ? [viewer, q.limit, q.topic.toLowerCase()] : [viewer, q.limit],
    );
    return { items: rows.map(toCommunity) };
  });

  app.get('/v1/communities/:slug', async (req) => {
    const { slug } = parse(slugParam, req.params);
    const row = await bySlug(slug, req.user?.id ?? null);
    const conv = row.my_role ? (await db.query(`SELECT id FROM conversations WHERE community_id = $1 AND kind = 'community'`, [row.id])).rows[0] : null;
    return { community: toCommunity(row), chatConversationId: conv?.id ?? null };
  });

  app.post('/v1/communities/:slug/join', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { slug } = parse(slugParam, req.params);
    const row = await bySlug(slug, u.id);
    if (row.my_status === 'banned') throw forbidden("You can't join this community.");
    if (row.my_role) return { status: 'active', role: row.my_role };
    const status = row.visibility === 'private' ? 'pending' : 'active';
    await tx(db, async (c) => {
      await c.query(`INSERT INTO community_members (community_id, user_id, status) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [row.id, u.id, status]);
      if (status === 'active') {
        await c.query(`UPDATE communities SET member_count = member_count + 1 WHERE id = $1`, [row.id]);
        await joinChat(c, row.id, u.id);
      }
    });
    if (status === 'active') track(db, u.id, 'community_joined', { communityId: row.id });
    else {
      const admins = await db.query<{ user_id: string }>(
        `SELECT user_id FROM community_members WHERE community_id = $1 AND role IN ('owner','admin','moderator') AND status = 'active'`,
        [row.id],
      );
      for (const a of admins.rows)
        await notify(db, ctx.realtime, {
          userId: a.user_id,
          category: 'communities',
          type: 'join_request',
          actorId: u.id,
          entityType: 'community',
          entityId: row.id,
        });
    }
    return { status, role: status === 'active' ? 'member' : null };
  });

  async function joinChat(c: { query: typeof db.query }, communityId: string, userId: string) {
    const conv = await c.query(`SELECT id FROM conversations WHERE community_id = $1 AND kind = 'community'`, [communityId]);
    if (conv.rows[0])
      await c.query(
        `INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1,$2) ON CONFLICT (conversation_id, user_id) DO UPDATE SET left_at = NULL`,
        [conv.rows[0].id, userId],
      );
  }

  app.post('/v1/communities/:slug/leave', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { slug } = parse(slugParam, req.params);
    const row = await bySlug(slug, u.id);
    if (row.my_role === 'owner') throw badRequest('Transfer ownership before leaving your community.');
    await tx(db, async (c) => {
      const r = await c.query(`DELETE FROM community_members WHERE community_id = $1 AND user_id = $2 AND status = 'active'`, [row.id, u.id]);
      if (r.rowCount) await c.query(`UPDATE communities SET member_count = greatest(member_count - 1, 0) WHERE id = $1`, [row.id]);
      await c.query(
        `UPDATE conversation_members SET left_at = now() WHERE user_id = $2 AND conversation_id IN (SELECT id FROM conversations WHERE community_id = $1)`,
        [row.id, u.id],
      );
    });
    return { status: 'left' };
  });

  app.get('/v1/communities/:slug/members', async (req) => {
    const viewer = req.user?.id ?? null;
    const { slug } = parse(slugParam, req.params);
    const row = await bySlug(slug, viewer);
    if (row.visibility === 'private' && !row.my_role) throw forbidden('Join this community to see its members.');
    const status = parse(z.object({ status: z.enum(['active', 'pending']).default('active') }), req.query).status;
    if (status === 'pending' && !atLeast(row.my_role, 'moderator')) throw forbidden();
    const { rows } = await db.query(
      `SELECT cm.role, cm.joined_at, ${PUBLIC_USER_COLS} FROM community_members cm JOIN profiles pr ON pr.user_id = cm.user_id
       WHERE cm.community_id = $1 AND cm.status = $2
       ORDER BY CASE cm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'moderator' THEN 2 WHEN 'organizer' THEN 3 ELSE 4 END, cm.joined_at LIMIT 200`,
      [row.id, status],
    );
    return { items: rows.map((r) => ({ user: toPublicUser(r as PublicUserRow), role: r.role, joinedAt: r.joined_at })) };
  });

  app.post('/v1/communities/:slug/members/:userId/approve', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { slug, userId } = parse(z.object({ slug: z.string(), userId: z.string().uuid() }), req.params);
    const row = await bySlug(slug, u.id);
    if (!atLeast(row.my_role, 'moderator')) throw forbidden();
    await tx(db, async (c) => {
      const r = await c.query(
        `UPDATE community_members SET status = 'active', joined_at = now() WHERE community_id = $1 AND user_id = $2 AND status = 'pending'`,
        [row.id, userId],
      );
      if (!r.rowCount) throw notFound('Join request');
      await c.query(`UPDATE communities SET member_count = member_count + 1 WHERE id = $1`, [row.id]);
      await joinChat(c, row.id, userId);
    });
    await notify(db, ctx.realtime, { userId, category: 'communities', type: 'join_approved', actorId: u.id, entityType: 'community', entityId: row.id });
    return { ok: true };
  });

  app.put('/v1/communities/:slug/members/:userId/role', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { slug, userId } = parse(z.object({ slug: z.string(), userId: z.string().uuid() }), req.params);
    const { role } = parse(setMemberRoleSchema, req.body);
    const row = await bySlug(slug, u.id);
    const myRank = row.my_role ? COMMUNITY_ROLE_RANK[row.my_role as CommunityRole] : -1;
    const target = await roleOf(row.id, userId);
    if (!target) throw notFound('Member');
    // You can only manage people below you, and only grant roles below your own.
    if (myRank < COMMUNITY_ROLE_RANK.admin || COMMUNITY_ROLE_RANK[target] >= myRank || COMMUNITY_ROLE_RANK[role] >= myRank) throw forbidden();
    await db.query(`UPDATE community_members SET role = $3 WHERE community_id = $1 AND user_id = $2`, [row.id, userId, role]);
    await audit(db, {
      actorId: u.id,
      action: 'community.role_change',
      entityType: 'community',
      entityId: row.id,
      metadata: { userId, from: target, to: role },
    });
    return { role };
  });

  app.post('/v1/communities/:slug/members/:userId/ban', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { slug, userId } = parse(z.object({ slug: z.string(), userId: z.string().uuid() }), req.params);
    const row = await bySlug(slug, u.id);
    const target = await roleOf(row.id, userId);
    if (!atLeast(row.my_role, 'moderator') || (target && COMMUNITY_ROLE_RANK[target] >= COMMUNITY_ROLE_RANK[row.my_role as CommunityRole])) throw forbidden();
    await tx(db, async (c) => {
      const r = await c.query(`UPDATE community_members SET status = 'banned' WHERE community_id = $1 AND user_id = $2 AND status = 'active'`, [
        row.id,
        userId,
      ]);
      if (r.rowCount) await c.query(`UPDATE communities SET member_count = greatest(member_count - 1, 0) WHERE id = $1`, [row.id]);
      await c.query(
        `UPDATE conversation_members SET left_at = now() WHERE user_id = $2 AND conversation_id IN (SELECT id FROM conversations WHERE community_id = $1)`,
        [row.id, userId],
      );
    });
    await audit(db, { actorId: u.id, action: 'community.ban', entityType: 'community', entityId: row.id, metadata: { userId } });
    return { ok: true };
  });

  app.get('/v1/communities/:slug/posts', async (req) => {
    const viewer = req.user?.id ?? null;
    const { slug } = parse(slugParam, req.params);
    const q = parse(pageQuerySchema, req.query);
    const row = await bySlug(slug, viewer);
    if (row.visibility === 'private' && !row.my_role) return { items: [], nextCursor: null, locked: true };
    const c = decodeCursor<KeyCursor>(q.cursor);
    const { rows } = await db.query(
      `SELECT p.id, p.created_at FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
       WHERE p.community_id = $2 AND ${postVisibleSql('$1')} ${c ? 'AND (p.created_at, p.id) < ($4::timestamptz, $5::uuid)' : ''}
       ORDER BY p.created_at DESC, p.id DESC LIMIT $3`,
      c ? [viewer, row.id, q.limit + 1, c.t, c.id] : [viewer, row.id, q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    return {
      items: await hydratePosts(
        db,
        page.map((r) => r.id),
        viewer,
      ),
      nextCursor: rows.length > q.limit ? keyCursorOf(page.at(-1)!) : null,
    };
  });

  app.patch('/v1/communities/:slug', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { slug } = parse(slugParam, req.params);
    const input = parse(createCommunitySchema.pick({ name: true, description: true, visibility: true, topics: true, rules: true }).partial(), req.body);
    const row = await bySlug(slug, u.id);
    if (!atLeast(row.my_role, 'admin')) throw forbidden();
    await db.query(
      `UPDATE communities SET name = coalesce($2, name), description = coalesce($3, description), visibility = coalesce($4, visibility),
       topics = coalesce($5, topics), rules = coalesce($6, rules) WHERE id = $1`,
      [row.id, input.name ?? null, input.description ?? null, input.visibility ?? null, input.topics ?? null, input.rules ?? null],
    );
    await audit(db, { actorId: u.id, action: 'community.update', entityType: 'community', entityId: row.id });
    return { community: toCommunity(await bySlug(slug, u.id)) };
  });

  // ── FAQ ───────────────────────────────────────────────────────────────
  const faqDto = (r: Record<string, any>) => ({ id: r.id, question: r.question, answer: r.answer, position: r.position, updatedAt: r.updated_at.toISOString() });
  const faqInput = z.object({ question: z.string().trim().min(5).max(300), answer: z.string().trim().min(1).max(4000), position: z.number().int().min(0).max(999).optional() });

  async function readable(slug: string, viewer: string | null) {
    const row = await bySlug(slug, viewer);
    if (row.visibility === 'private' && !row.my_role) throw forbidden('Join this community to see this.');
    return row;
  }

  app.get('/v1/communities/:slug/faq', async (req) => {
    const { slug } = parse(slugParam, req.params);
    const row = await readable(slug, req.user?.id ?? null);
    const { rows } = await db.query(`SELECT * FROM community_faqs WHERE community_id = $1 ORDER BY position, created_at`, [row.id]);
    return { items: rows.map(faqDto), canEdit: atLeast(row.my_role, 'moderator') };
  });

  app.post('/v1/communities/:slug/faq', { preHandler: requireAuth }, async (req, reply) => {
    const u = me(req);
    const { slug } = parse(slugParam, req.params);
    const input = parse(faqInput, req.body);
    const row = await bySlug(slug, u.id);
    if (!atLeast(row.my_role, 'moderator')) throw forbidden();
    const count = await db.query(`SELECT count(*) AS n FROM community_faqs WHERE community_id = $1`, [row.id]);
    if (Number(count.rows[0].n) >= 100) throw new AppError(409, 'conflict', 'A community can have up to 100 FAQ entries.');
    const { rows } = await db.query(
      `INSERT INTO community_faqs (community_id, question, answer, position, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [row.id, input.question, input.answer, input.position ?? Number(count.rows[0].n), u.id],
    );
    await audit(db, { actorId: u.id, action: 'community.faq.create', entityType: 'community', entityId: row.id });
    reply.code(201);
    return { faq: faqDto(rows[0]) };
  });

  app.patch('/v1/communities/:slug/faq/:id', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { slug, id } = parse(slugParam.extend({ id: z.string().uuid() }), req.params);
    const input = parse(faqInput.partial(), req.body);
    const row = await bySlug(slug, u.id);
    if (!atLeast(row.my_role, 'moderator')) throw forbidden();
    const { rows } = await db.query(
      `UPDATE community_faqs SET question = coalesce($3, question), answer = coalesce($4, answer), position = coalesce($5, position)
       WHERE id = $1 AND community_id = $2 RETURNING *`,
      [id, row.id, input.question ?? null, input.answer ?? null, input.position ?? null],
    );
    if (!rows[0]) throw notFound('FAQ entry');
    return { faq: faqDto(rows[0]) };
  });

  app.delete('/v1/communities/:slug/faq/:id', { preHandler: requireAuth }, async (req, reply) => {
    const u = me(req);
    const { slug, id } = parse(slugParam.extend({ id: z.string().uuid() }), req.params);
    const row = await bySlug(slug, u.id);
    if (!atLeast(row.my_role, 'moderator')) throw forbidden();
    const r = await db.query(`DELETE FROM community_faqs WHERE id = $1 AND community_id = $2`, [id, row.id]);
    if (!r.rowCount) throw notFound('FAQ entry');
    await audit(db, { actorId: u.id, action: 'community.faq.delete', entityType: 'community', entityId: row.id });
    reply.code(204);
  });

  /**
   * "Has this been asked before?" Trigram similarity against the FAQ and
   * earlier posts in the community, filtered by what the viewer may see.
   * Called while someone types a question, before they post it.
   */
  app.get('/v1/communities/:slug/similar', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const viewer = req.user?.id ?? null;
    const { slug } = parse(slugParam, req.params);
    const { q } = parse(z.object({ q: z.string().trim().min(8).max(500) }), req.query);
    const row = await readable(slug, viewer);
    const faqs = await db.query(
      `SELECT *, similarity(question, $2) AS score FROM community_faqs WHERE community_id = $1 AND similarity(question, $2) > 0.25 ORDER BY score DESC LIMIT 3`,
      [row.id, q],
    );
    const posts = await db.query(
      `SELECT p.id, similarity(p.body, $3) AS score FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
       WHERE p.community_id = $2 AND p.body % $3 AND ${postVisibleSql('$1')}
       ORDER BY score DESC, p.created_at DESC LIMIT 3`,
      [viewer, row.id, q],
    );
    const scores = new Map(posts.rows.map((r) => [r.id as string, r.score as number]));
    const hydrated = await hydratePosts(db, [...scores.keys()], viewer);
    return {
      faq: faqs.rows.map((r) => ({ ...faqDto(r), score: Number(Number(r.score).toFixed(2)) })),
      posts: hydrated.map((p) => ({ post: p, score: Number(Number(scores.get(p.id) ?? 0).toFixed(2)) })),
    };
  });

}
