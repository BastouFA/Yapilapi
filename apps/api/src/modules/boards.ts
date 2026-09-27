import type { FastifyInstance } from 'fastify';
import { tx } from '@yapilapi/database';
import {
  BOARD_COLLABORATORS_MAX,
  BOARD_DESCRIPTION_MAX,
  BOARD_ITEMS_MAX,
  BOARD_NAME_MAX,
  BOARD_VISIBILITIES,
  BOARDS_MAX,
  pageQuerySchema,
  SAVE_NOTE_MAX,
  SAVED_FILTERS,
  usernameSchema,
  type Board,
  type BoardCollaborator,
} from '@yapilapi/shared';
import { z } from 'zod';
import { AppError, badRequest, forbidden, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { decodeCursor, encodeCursor } from '../lib/cursor.ts';
import { minorRuleSql } from '../lib/collabs.ts';
import { analyzeText } from '../lib/moderation.ts';
import { hydratePosts } from '../lib/posts.ts';
import { attachSaveNotes, savedFilterSql } from '../lib/saves.ts';
import { notify, track } from '../lib/services.ts';
import { ageOf, plusCol, publicUserFrom } from '../lib/users.ts';
import { notBlockedSql, postUnlockedSql, postVisibleSql } from '../lib/visibility.ts';
import { me, requireAuth } from '../plugins/auth.ts';

/*
 * SQL building blocks. `v` is the viewer placeholder (NULL when signed out).
 * Boards are aliased `bd` (never `b`: the block checks use that alias), the
 * owner's user row `ou` and profile `op`; board items `bi`, their posts `p`
 * with the author's profile `ap` and user row `au`, as postVisibleSql expects.
 */
const minor = (birthCol: string) => `coalesce(${birthCol} > current_date - interval '18 years', false)`;
const follows = (v: string, other: string) => `EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = ${v} AND f.followee_id = ${other})`;
const memberIs = (user: string, status: 'accepted' | 'invited') =>
  `EXISTS (SELECT 1 FROM board_members bm WHERE bm.board_id = bd.id AND bm.user_id = ${user} AND bm.status = '${status}')`;

/** Public as far as anyone else is concerned: a public board of someone under 18 is read as shared. */
const PUBLIC_NOW = `(bd.visibility = 'public' AND NOT ${minor('ou.birth_date')})`;

/**
 * Whether the viewer may see the board at all: its owner; collaborators and people invited
 * while the board is shared or public (a private board is the owner's alone); and, for a
 * public board, anyone who may see the owner's profile. Blocks either way hide it.
 */
export function boardVisibleSql(v: string): string {
  return `(ou.status = 'active' AND ${notBlockedSql('bd.owner_id', v)} AND (
    bd.owner_id = ${v}
    OR (bd.visibility <> 'private' AND (${memberIs(v, 'accepted')} OR ${memberIs(v, 'invited')}))
    OR (${PUBLIC_NOW} AND (NOT op.is_private OR ${follows(v, 'bd.owner_id')}))
  ))`;
}

const ITEM_FROM = `FROM board_items bi JOIN posts p ON p.id = bi.post_id JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id`;
/**
 * Items of a board the viewer gets: posts they can see right now (audience, blocks either way,
 * co-authors, deleted posts, moderation, regional rules) and can open (subscriber-only posts
 * need a current subscription). Evaluated on every read, so counts and covers follow along.
 */
const itemVisibleSql = (v: string) => `(${postVisibleSql(v)} AND ${postUnlockedSql(v)})`;

const OWNER_COLS = `op.user_id AS o_id, op.username AS o_username, op.display_name AS o_display_name, op.avatar_url AS o_avatar_url, op.mode AS o_mode, ${plusCol('o_', 'op')}`;
const USER_COLS = `pr.user_id AS a_id, pr.username AS a_username, pr.display_name AS a_display_name, pr.avatar_url AS a_avatar_url, pr.mode AS a_mode, ${plusCol('a_')}`;

/** Everything a board card needs, for viewer $1. `containsParam` (a post id placeholder) adds whether that post is on it. */
function summarySelect(containsParam?: string): string {
  return `
  SELECT bd.id, bd.owner_id, bd.name, bd.description, bd.visibility, bd.cover_post_id, bd.created_at, bd.updated_at, ${OWNER_COLS},
         (SELECT bm.status FROM board_members bm WHERE bm.board_id = bd.id AND bm.user_id = $1) AS my_status,
         (SELECT count(*)::int FROM board_members bm JOIN users mu ON mu.id = bm.user_id
          WHERE bm.board_id = bd.id AND bm.status = 'accepted' AND mu.status = 'active') AS collaborator_count,
         (SELECT count(*)::int ${ITEM_FROM} WHERE bi.board_id = bd.id AND ${itemVisibleSql('$1')}) AS item_count,
         ${containsParam ? `EXISTS (SELECT 1 FROM board_items cbi WHERE cbi.board_id = bd.id AND cbi.post_id = ${containsParam})` : 'NULL::boolean'} AS contains,
         cov.post_id AS cov_post_id, cov.body AS cov_body, cov.media AS cov_media
  FROM boards bd JOIN users ou ON ou.id = bd.owner_id JOIN profiles op ON op.user_id = bd.owner_id
  LEFT JOIN LATERAL (
    SELECT p.id AS post_id, left(p.body, 140) AS body,
           (SELECT json_build_object('url', CASE WHEN m.kind = 'image' THEN coalesce(m.variants->>'medium', m.url) ELSE m.poster_url END, 'placeholder', m.blurhash)
              FROM post_media pm JOIN media m ON m.id = pm.media_id
              WHERE pm.post_id = p.id AND m.kind IN ('image', 'video') AND m.moderation NOT IN ('blocked', 'sensitive')
              ORDER BY pm.position LIMIT 1) AS media
    ${ITEM_FROM}
    WHERE bi.board_id = bd.id AND ${itemVisibleSql('$1')}
    ORDER BY (bi.post_id = bd.cover_post_id) IS TRUE DESC, bi.position, bi.post_id
    LIMIT 1
  ) cov ON true`;
}

type Row = Record<string, any>;

function roleOf(r: Row, viewer: string | null): Board['role'] {
  if (r.owner_id === viewer) return 'owner';
  if (r.visibility === 'private') return null;
  return r.my_status === 'accepted' ? 'collaborator' : r.my_status === 'invited' ? 'invited' : null;
}

function toBoard(r: Row, viewer: string | null): Board {
  const role = roleOf(r, viewer);
  const media = r.cov_media as { url: string | null; placeholder: string | null } | null;
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    visibility: r.visibility,
    owner: publicUserFrom(r, 'o_'),
    role,
    itemCount: Number(r.item_count ?? 0),
    cover: r.cov_post_id ? { postId: r.cov_post_id, imageUrl: media?.url ?? null, placeholder: media?.placeholder ?? null, text: r.cov_body || null } : null,
    ...(role === 'owner' ? { coverPostId: r.cover_post_id ?? null } : {}),
    collaboratorCount: Number(r.collaborator_count ?? 0),
    canAdd: role === 'owner' || role === 'collaborator',
    ...(r.contains === null || r.contains === undefined ? {} : { contains: !!r.contains }),
    createdAt: (r.created_at as Date).toISOString(),
    updatedAt: (r.updated_at as Date).toISOString(),
  };
}

const idParam = z.object({ id: z.string().uuid() });
const itemParams = z.object({ id: z.string().uuid(), postId: z.string().uuid() });
const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}]/u;
const name = z.string().trim().min(1, 'Add a name.').max(BOARD_NAME_MAX, `Up to ${BOARD_NAME_MAX} characters.`);
const description = z
  .string()
  .trim()
  .max(BOARD_DESCRIPTION_MAX, `Up to ${BOARD_DESCRIPTION_MAX} characters.`)
  .refine((s) => !EMOJI.test(s), 'Use words here, without emoji.');
const visibility = z.enum(BOARD_VISIBILITIES);
const createSchema = z.object({
  name,
  description: description.default(''),
  visibility: visibility.default('private'),
  postIds: z.array(z.string().uuid()).max(50).default([]),
});
const patchSchema = z.object({
  name: name.optional(),
  description: description.optional(),
  visibility: visibility.optional(),
  coverPostId: z.string().uuid().nullable().optional(),
});

function checkText(...texts: string[]) {
  if (texts.some((s) => s && analyzeText(s).risk !== 'normal')) throw new AppError(422, 'content_blocked', "This can't be shared. Try different words.");
}

/** Boards of people under 18 can be private or shared, not public. */
function checkVisibility(birthDate: Date | null, v: string | undefined) {
  if (v !== 'public') return;
  const age = ageOf(birthDate);
  if (age !== null && age < 18) throw forbidden('Boards of people under 18 can be private or shared with collaborators, not public.');
}

/**
 * Saved posts and boards, YAPILAPI's way.
 *
 * - Saved: everything you saved, newest first, with a private note on any save.
 * - Boards: named collections of your saves with a cover and a short description.
 *   Deleting a board keeps the saves.
 * - Shared boards: invite friends to add to a board together (a trip plan, a
 *   wishlist). Collaborators see it and add to it and can remove what they added;
 *   only the owner renames it, changes who sees it, removes other items or people,
 *   or deletes it. Anyone can leave.
 * - Public boards show on the owner's profile, in a Boards tab.
 * - A board only ever shows each viewer the posts that viewer can see right now.
 */
export default async function boardsModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;

  async function loadVisible(id: string, viewer: string | null) {
    const { rows } = await db.query(`${summarySelect()} WHERE bd.id = $2 AND ${boardVisibleSql('$1')}`, [viewer, id]);
    if (!rows[0]) throw notFound('That board');
    return rows[0] as Row;
  }

  async function ownBoard(id: string, userId: string, action: string) {
    const row = await loadVisible(id, userId);
    if (row.owner_id !== userId) throw forbidden(`Only the person who made this board can ${action}.`);
    return row;
  }

  /** The owner, or a collaborator while the board is shared or public. */
  async function memberBoard(id: string, userId: string) {
    const row = await loadVisible(id, userId);
    const role = roleOf(row, userId);
    if (role !== 'owner' && role !== 'collaborator') throw forbidden('Only the owner and collaborators can add to this board.');
    return { row, role };
  }

  /**
   * Put posts on a board, newest on top, and save them for the person adding them. Each must be
   * a post they can see and open. Returns the posts that weren't on the board before.
   */
  async function addItems(boardId: string, userId: string, postIds: string[]): Promise<string[]> {
    const ids = [...new Set(postIds)];
    if (!ids.length) return [];
    return tx(db, async (c) => {
      // One add at a time per board, so two can't pass the limit or take the same position together.
      await c.query(`SELECT 1 FROM boards WHERE id = $1 FOR UPDATE`, [boardId]);
      const seen = await c.query<{ id: string; unlocked: boolean }>(
        `SELECT p.id, coalesce(${postUnlockedSql('$1')}, false) AS unlocked
         FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
         WHERE p.id = ANY($2::uuid[]) AND ${postVisibleSql('$1')}`,
        [userId, ids],
      );
      if (seen.rows.length !== ids.length) throw notFound('That post');
      if (seen.rows.some((r) => !r.unlocked)) throw new AppError(403, 'subscribers_only', 'This post is for subscribers. Subscribe to add it to a board.');
      const fresh = (
        await c.query<{ id: string }>(
          `SELECT x.id FROM unnest($1::uuid[]) WITH ORDINALITY AS x(id, n)
           WHERE NOT EXISTS (SELECT 1 FROM board_items bi WHERE bi.board_id = $2 AND bi.post_id = x.id) ORDER BY x.n`,
          [ids, boardId],
        )
      ).rows.map((r) => r.id);
      const count = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM board_items WHERE board_id = $1`, [boardId])).rows[0]!.n;
      if (count + fresh.length > BOARD_ITEMS_MAX) throw badRequest(`A board holds up to ${BOARD_ITEMS_MAX} posts.`);
      if (fresh.length) {
        // The first post given ends up on top.
        await c.query(
          `INSERT INTO board_items (board_id, post_id, added_by, position)
           SELECT $1, x.id, $3, (SELECT coalesce(min(position), 0) FROM board_items WHERE board_id = $1) - (cardinality($2::uuid[]) - x.n + 1)
           FROM unnest($2::uuid[]) WITH ORDINALITY AS x(id, n)`,
          [boardId, fresh, userId],
        );
        await c.query(`UPDATE boards SET updated_at = now() WHERE id = $1`, [boardId]);
      }
      await c.query(`INSERT INTO saves (post_id, user_id) SELECT unnest($1::uuid[]), $2 ON CONFLICT DO NOTHING`, [ids, userId]);
      return fresh;
    });
  }

  /**
   * Tell the owner and collaborators that someone added to a shared board, quietly: one
   * unread notification per person, per board and per adder, whose count goes up as more is
   * added (no new row, no push). Mutes, blocks and notification settings apply as usual.
   */
  async function noteAdded(board: Row, actorId: string, added: number) {
    if (!added || board.visibility === 'private') return;
    const { rows } = await db.query<{ id: string }>(
      `SELECT owner_id AS id FROM boards WHERE id = $1
       UNION SELECT bm.user_id FROM board_members bm WHERE bm.board_id = $1 AND bm.status = 'accepted'`,
      [board.id],
    );
    for (const r of rows) {
      if (r.id === actorId) continue;
      const bumped = await db.query(
        `UPDATE notifications SET data = data || jsonb_build_object('count', coalesce((data->>'count')::int, 0) + $4, 'name', $5::text)
         WHERE user_id = $1 AND type = 'board_item_added' AND entity_id = $2 AND actor_id = $3 AND read_at IS NULL
           AND created_at > now() - interval '1 day'
           AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = $3) OR (b.blocker_id = $3 AND b.blocked_id = $1))
           AND NOT EXISTS (SELECT 1 FROM mutes mt WHERE mt.muter_id = $1 AND mt.muted_id = $3)`,
        [r.id, board.id, actorId, added, board.name],
      );
      if (bumped.rowCount) continue;
      await notify(db, ctx.realtime, {
        userId: r.id,
        category: 'friends',
        type: 'board_item_added',
        actorId,
        entityType: 'board',
        entityId: board.id,
        data: { name: board.name, count: added },
      });
    }
  }

  async function collaborators(boardId: string, viewer: string | null, isOwner: boolean): Promise<BoardCollaborator[]> {
    const { rows } = await db.query(
      `SELECT bm.status, ${USER_COLS}
       FROM board_members bm JOIN profiles pr ON pr.user_id = bm.user_id JOIN users au ON au.id = bm.user_id
       WHERE bm.board_id = $2 AND au.status = 'active' AND ($3 OR bm.status = 'accepted') AND ${notBlockedSql('bm.user_id', '$1::uuid')}
       ORDER BY bm.joined_at NULLS LAST, bm.invited_at, bm.user_id`,
      [viewer, boardId, isOwner],
    );
    return rows.map((r) => ({ user: publicUserFrom(r, 'a_'), status: r.status }));
  }

  // ── Boards ──────────────────────────────────────────────────────────
  /**
   * Your boards: the ones you own, then the ones you collaborate on or are invited to. With
   * `postId`, each says whether that post is on it (for the "Save to" sheet).
   */
  app.get('/v1/boards', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { postId } = parse(z.object({ postId: z.string().uuid().optional() }), req.query);
    const { rows } = await db.query(
      `${summarySelect(postId ? '$2::uuid' : undefined)}
       WHERE (bd.owner_id = $1 OR EXISTS (SELECT 1 FROM board_members bm WHERE bm.board_id = bd.id AND bm.user_id = $1)) AND ${boardVisibleSql('$1')}
       ORDER BY (bd.owner_id = $1) DESC, bd.updated_at DESC, bd.id LIMIT ${BOARDS_MAX + 100}`,
      postId ? [u.id, postId] : [u.id],
    );
    return { items: rows.map((r) => toBoard(r, u.id)) };
  });

  app.post('/v1/boards', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    const input = parse(createSchema, req.body);
    checkVisibility(u.birthDate, input.visibility);
    checkText(input.name, input.description);
    const n = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM boards WHERE owner_id = $1`, [u.id]);
    if (n.rows[0]!.n >= BOARDS_MAX) throw badRequest(`You have ${BOARDS_MAX} boards, the most you can have. Delete one to start another.`);
    const { rows } = await db.query<{ id: string }>(`INSERT INTO boards (owner_id, name, description, visibility) VALUES ($1,$2,$3,$4) RETURNING id`, [
      u.id,
      input.name,
      input.description,
      input.visibility,
    ]);
    const id = rows[0]!.id;
    try {
      await addItems(id, u.id, input.postIds);
    } catch (e) {
      await db.query(`DELETE FROM boards WHERE id = $1`, [id]);
      throw e;
    }
    track(db, u.id, 'board_created', { visibility: input.visibility, posts: input.postIds.length });
    reply.code(201);
    return { board: toBoard(await loadVisible(id, u.id), u.id) };
  });

  /** A board and its collaborators. Its posts come from /items. */
  app.get('/v1/boards/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const viewer = req.user?.id ?? null;
    const board = toBoard(await loadVisible(id, viewer), viewer);
    return { board, collaborators: await collaborators(id, viewer, board.role === 'owner') };
  });

  /** Rename, describe, choose who sees it, or pick a cover (null goes back to the first item). Owner only. */
  app.patch('/v1/boards/:id', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(patchSchema, req.body);
    await ownBoard(id, u.id, 'change it');
    checkVisibility(u.birthDate, input.visibility);
    checkText(input.name ?? '', input.description ?? '');
    if (input.coverPostId) {
      const has = await db.query(`SELECT 1 FROM board_items WHERE board_id = $1 AND post_id = $2`, [id, input.coverPostId]);
      if (!has.rowCount) throw badRequest('Choose a cover from the posts on this board.');
    }
    const map: Record<string, string> = { name: 'name', description: 'description', visibility: 'visibility', coverPostId: 'cover_post_id' };
    const sets = ['updated_at = now()'];
    const vals: unknown[] = [id];
    for (const [k, col] of Object.entries(map)) {
      const v = (input as Record<string, unknown>)[k];
      if (v === undefined) continue;
      vals.push(v);
      sets.push(`${col} = $${vals.length}`);
    }
    await db.query(`UPDATE boards SET ${sets.join(', ')} WHERE id = $1`, vals);
    return { board: toBoard(await loadVisible(id, u.id), u.id) };
  });

  /** Delete a board. Its posts stay in your saves. Owner only. */
  app.delete('/v1/boards/:id', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    await ownBoard(id, u.id, 'delete it');
    await tx(db, async (c) => {
      await c.query(`DELETE FROM boards WHERE id = $1 AND owner_id = $2`, [id, u.id]);
      // Open invites and activity about it would lead nowhere now.
      await c.query(`DELETE FROM notifications WHERE entity_type = 'board' AND entity_id = $1`, [id]);
    });
    return { ok: true };
  });

  // ── Items ───────────────────────────────────────────────────────────
  /**
   * A board's posts in the board's order, only the ones the viewer can see and open right now,
   * with the viewer's own notes. `filter` as on the Saved page.
   */
  app.get('/v1/boards/:id/items', async (req) => {
    const { id } = parse(idParam, req.params);
    const viewer = req.user?.id ?? null;
    const q = parse(pageQuerySchema.extend({ filter: z.enum(SAVED_FILTERS).default('all') }), req.query);
    const c = decodeCursor<{ p: number; id: string }>(q.cursor);
    if (c && (typeof c.p !== 'number' || typeof c.id !== 'string')) throw badRequest('Invalid cursor.');
    const role = roleOf(await loadVisible(id, viewer), viewer);
    const params: unknown[] = [viewer, id, q.limit + 1];
    if (c) params.push(c.p, c.id);
    const { rows } = await db.query<{ id: string; position: number; added_by: string }>(
      `SELECT p.id, bi.position, bi.added_by ${ITEM_FROM}
       WHERE bi.board_id = $2 AND ${itemVisibleSql('$1')} AND ${savedFilterSql(q.filter)}
         ${c ? 'AND (bi.position, bi.post_id) > ($4::int, $5::uuid)' : ''}
       ORDER BY bi.position, bi.post_id LIMIT $3`,
      params,
    );
    const page = rows.slice(0, q.limit);
    const items = await hydratePosts(
      db,
      page.map((r) => r.id),
      viewer,
    );
    await attachSaveNotes(db, items, viewer);
    const last = page.at(-1);
    return {
      items,
      nextCursor: rows.length > q.limit && last ? encodeCursor({ p: last.position, id: last.id }) : null,
      // Posts on this page the viewer may take off: the owner any, a collaborator the ones they added.
      removable: role === 'owner' ? page.map((r) => r.id) : role === 'collaborator' ? page.filter((r) => r.added_by === viewer).map((r) => r.id) : [],
    };
  });

  /** Add a post you can see to a board you own or collaborate on. It's saved for you too. */
  app.post('/v1/boards/:id/items', { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { postId } = parse(z.object({ postId: z.string().uuid() }), req.body);
    const { row } = await memberBoard(id, u.id);
    const added = await addItems(id, u.id, [postId]);
    await noteAdded(row, u.id, added.length);
    reply.code(added.length ? 201 : 200);
    return { added: added.length > 0 };
  });

  /** The owner can take any post off; a collaborator the ones they added. The saves stay. */
  app.delete('/v1/boards/:id/items/:postId', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id, postId } = parse(itemParams, req.params);
    const { role } = await memberBoard(id, u.id);
    const r = await db.query(`DELETE FROM board_items WHERE board_id = $1 AND post_id = $2 AND ($3 OR added_by = $4)`, [id, postId, role === 'owner', u.id]);
    if (!r.rowCount) {
      const there = await db.query(`SELECT 1 FROM board_items WHERE board_id = $1 AND post_id = $2`, [id, postId]);
      if (there.rowCount) throw forbidden('Only the owner can remove posts that someone else added.');
      throw notFound('That post');
    }
    await db.query(`UPDATE boards SET updated_at = now(), cover_post_id = NULLIF(cover_post_id, $2) WHERE id = $1`, [id, postId]);
    return { ok: true };
  });

  /**
   * Reorder a board: `postIds` is the new order of the posts you can see on it. Posts you can't
   * see keep their places, so reordering never moves or reveals them.
   */
  app.put('/v1/boards/:id/order', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { postIds } = parse(z.object({ postIds: z.array(z.string().uuid()).max(BOARD_ITEMS_MAX) }), req.body);
    await memberBoard(id, u.id);
    await tx(db, async (c) => {
      await c.query(`SELECT 1 FROM boards WHERE id = $1 FOR UPDATE`, [id]);
      const { rows } = await c.query<{ post_id: string; visible: boolean }>(
        `SELECT bi.post_id, coalesce(${itemVisibleSql('$1')}, false) AS visible ${ITEM_FROM}
         WHERE bi.board_id = $2 ORDER BY bi.position, bi.post_id`,
        [u.id, id],
      );
      const visible = rows.filter((r) => r.visible).map((r) => r.post_id);
      const given = new Set(postIds);
      if (given.size !== postIds.length || given.size !== visible.length || visible.some((p) => !given.has(p)))
        throw new AppError(409, 'conflict', 'This board changed while you were arranging it. Refresh and try again.');
      // Fill the slots of the visible posts, in their order, with the new order.
      const next = [...postIds];
      const order = rows.map((r) => (r.visible ? next.shift()! : r.post_id));
      await c.query(
        `UPDATE board_items bi SET position = x.n - 1 FROM unnest($2::uuid[]) WITH ORDINALITY AS x(id, n) WHERE bi.board_id = $1 AND bi.post_id = x.id`,
        [id, order],
      );
      await c.query(`UPDATE boards SET updated_at = now() WHERE id = $1`, [id]);
    });
    return { ok: true };
  });

  // ── Collaborators ───────────────────────────────────────────────────
  /**
   * Invite a friend (or someone you follow who follows you back) to add to a board. They're
   * told and can accept or decline. A private board becomes shared. Owner only.
   */
  app.post('/v1/boards/:id/collaborators', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { userId } = parse(z.object({ userId: z.string().uuid() }), req.body);
    const row = await ownBoard(id, u.id, 'invite people');
    if (userId === u.id) throw badRequest("You can't invite yourself.");
    const who = (
      await db.query(
        `SELECT x.id,
                (EXISTS (SELECT 1 FROM friendships fr WHERE (fr.user_a = $1 AND fr.user_b = x.id) OR (fr.user_a = x.id AND fr.user_b = $1))
                 OR (${follows('$1', 'x.id')} AND ${follows('x.id', '$1')})) AS connected,
                ${minorRuleSql('$1', 'x.id')} AS minor_ok
         FROM users x WHERE x.id = $2 AND x.status = 'active' AND ${notBlockedSql('x.id', '$1')}`,
        [u.id, userId],
      )
    ).rows[0];
    if (!who) throw notFound('That person');
    if (!who.minor_ok) throw new AppError(403, 'minor_protection', 'To keep younger people safe, you can only invite them once you are friends.');
    if (!who.connected) throw badRequest('You can invite friends, and people you follow who follow you back.');
    const inserted = await tx(db, async (c) => {
      await c.query(`SELECT 1 FROM boards WHERE id = $1 FOR UPDATE`, [id]);
      const n = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM board_members WHERE board_id = $1`, [id])).rows[0]!.n;
      const already = await c.query(`SELECT 1 FROM board_members WHERE board_id = $1 AND user_id = $2`, [id, userId]);
      if (already.rowCount) return false;
      if (n >= BOARD_COLLABORATORS_MAX) throw badRequest(`A board can have up to ${BOARD_COLLABORATORS_MAX} collaborators.`);
      await c.query(`INSERT INTO board_members (board_id, user_id, invited_by) VALUES ($1,$2,$3)`, [id, userId, u.id]);
      await c.query(`UPDATE boards SET visibility = CASE WHEN visibility = 'private' THEN 'shared' ELSE visibility END, updated_at = now() WHERE id = $1`, [
        id,
      ]);
      return true;
    });
    if (inserted)
      await notify(db, ctx.realtime, {
        userId,
        category: 'friends',
        type: 'board_invite',
        actorId: u.id,
        entityType: 'board',
        entityId: id,
        data: { name: row.name },
      });
    reply.code(inserted ? 201 : 200);
    return { board: toBoard(await loadVisible(id, u.id), u.id), collaborators: await collaborators(id, u.id, true) };
  });

  /** Accept an invitation: the board shows in your boards and you can add to it. */
  app.post('/v1/boards/:id/join', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    await loadVisible(id, u.id);
    const r = await db.query(`UPDATE board_members SET status = 'accepted', joined_at = now() WHERE board_id = $1 AND user_id = $2 AND status = 'invited'`, [
      id,
      u.id,
    ]);
    if (!r.rowCount) throw notFound('That invitation');
    return { board: toBoard(await loadVisible(id, u.id), u.id) };
  });

  /** Decline an invitation or leave a board. What you added stays on it; the owner can remove it. */
  app.delete('/v1/boards/:id/membership', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const r = await db.query(`DELETE FROM board_members WHERE board_id = $1 AND user_id = $2`, [id, u.id]);
    if (!r.rowCount) throw notFound('That board');
    await db.query(`DELETE FROM notifications WHERE user_id = $2 AND entity_type = 'board' AND entity_id = $1 AND type = 'board_invite'`, [id, u.id]);
    return { ok: true };
  });

  /** The owner takes someone off a board or cancels an invite. (To leave yourself, use /membership.) */
  app.delete('/v1/boards/:id/collaborators/:userId', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id, userId } = parse(z.object({ id: z.string().uuid(), userId: z.string().uuid() }), req.params);
    if (userId !== u.id) await ownBoard(id, u.id, 'remove collaborators');
    const r = await db.query(`DELETE FROM board_members WHERE board_id = $1 AND user_id = $2`, [id, userId]);
    if (!r.rowCount) throw notFound('That collaborator');
    await db.query(`DELETE FROM notifications WHERE user_id = $2 AND entity_type = 'board' AND entity_id = $1 AND type = 'board_invite'`, [id, userId]);
    return { ok: true };
  });

  // ── Profiles ────────────────────────────────────────────────────────
  /** The Boards tab on a profile: only public boards, and only for people who may see that profile. */
  app.get('/v1/users/:username/boards', async (req) => {
    const { username } = parse(z.object({ username: usernameSchema }), req.params);
    const viewer = req.user?.id ?? null;
    const owner = (
      await db.query(
        `SELECT pr.user_id FROM profiles pr JOIN users u ON u.id = pr.user_id
         WHERE lower(pr.username) = lower($1) AND u.status = 'active' AND ${notBlockedSql('pr.user_id', '$2::uuid')}
           AND ($2::uuid IS NOT NULL OR NOT ${minor('u.birth_date')})`,
        [username, viewer],
      )
    ).rows[0];
    if (!owner) throw notFound('That profile');
    const { rows } = await db.query(
      `${summarySelect()} WHERE bd.owner_id = $2 AND ${PUBLIC_NOW} AND ${boardVisibleSql('$1')}
       ORDER BY bd.created_at DESC, bd.id LIMIT ${BOARDS_MAX}`,
      [viewer, owner.user_id],
    );
    return { items: rows.map((r) => toBoard(r, viewer)) };
  });

  // ── Saves and notes ─────────────────────────────────────────────────
  /** Whether you saved a post, your note on it, and which of your boards it's on. */
  app.get('/v1/posts/:id/save', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const s = await db.query<{ note: string }>(`SELECT note FROM saves WHERE post_id = $1 AND user_id = $2`, [id, u.id]);
    const boards = await db.query<{ id: string }>(
      `SELECT bd.id FROM board_items bi JOIN boards bd ON bd.id = bi.board_id JOIN users ou ON ou.id = bd.owner_id JOIN profiles op ON op.user_id = bd.owner_id
       WHERE bi.post_id = $2 AND (bd.owner_id = $1 OR (bd.visibility <> 'private' AND ${memberIs('$1', 'accepted')})) AND ${boardVisibleSql('$1')}`,
      [u.id, id],
    );
    return { saved: !!s.rows[0], note: s.rows[0]?.note ?? '', boardIds: boards.rows.map((r) => r.id) };
  });

  /** Your private note on a saved post (saving it if it isn't yet). Only you ever see it; an empty note clears it. */
  app.put('/v1/posts/:id/save/note', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { note } = parse(z.object({ note: z.string().trim().max(SAVE_NOTE_MAX, `Up to ${SAVE_NOTE_MAX} characters.`) }), req.body);
    const visible = await db.query(
      `SELECT 1 FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id WHERE p.id = $2 AND ${postVisibleSql('$1')}`,
      [u.id, id],
    );
    if (!visible.rowCount) throw notFound('That post');
    await db.query(
      `INSERT INTO saves (post_id, user_id, note, note_updated_at) VALUES ($1,$2,$3,now())
       ON CONFLICT (post_id, user_id) DO UPDATE SET note = EXCLUDED.note, note_updated_at = now()`,
      [id, u.id, note],
    );
    return { saved: true, note };
  });
}
