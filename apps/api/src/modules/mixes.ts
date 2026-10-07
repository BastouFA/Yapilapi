import type { FastifyInstance, FastifyRequest } from 'fastify';
import { tx } from '@yapilapi/database';
import {
  addMixSongsSchema,
  createMixSchema,
  createPostSchema,
  MIX_SONGS_MAX,
  MIXES_MAX,
  mixListQuerySchema,
  postMixSchema,
  reorderMixSchema,
  shareMixSchema,
  updateMixSchema,
  usernameSchema,
  type MixDetail,
  type MixSongRef,
  type MusicLicence,
} from '@yapilapi/shared';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { AppContext } from '../lib/context.ts';
import { isLite } from '../lib/data-saver.ts';
import { AppError, badRequest, forbidden, notFound, parse } from '../lib/errors.ts';
import { enqueue } from '../lib/jobs.ts';
import { pushNewMessage } from '../lib/message-push.ts';
import {
  MIX_FROM,
  MIX_SUMMARY,
  mixSongs,
  mixVisibleSql,
  noteSongsAdded,
  presentMixes,
  publishMixChanged,
  roleOf,
  songUnavailable,
  toMix,
} from '../lib/mixes.ts';
import { analyzeText } from '../lib/moderation.ts';
import { hydratePosts } from '../lib/posts.ts';
import { announcePost, moderationNotice, recordFlags, screenPost, writePost } from '../lib/publishing.ts';
import { track } from '../lib/services.ts';
import { soundUsableSql, soundVisibleSql } from '../lib/sounds.ts';
import { assertMessagePace } from '../lib/spam.ts';
import { notBlockedSql } from '../lib/visibility.ts';
import { me, requireAuth, type AuthUser } from '../plugins/auth.ts';
import type { ChatHelpers } from './chat-polls-lists.ts';

const idParam = z.object({ id: z.string().uuid() });
const songParams = z.object({ id: z.string().uuid(), songId: z.string().uuid() });
const chatParams = z.object({ id: z.string().uuid(), conversationId: z.string().uuid() });

type Row = Record<string, any>;

const notAllowed = (message: string) => new AppError(403, 'music_not_allowed', message);
const unavailable = (message: string) => new AppError(422, 'music_unavailable', message);

/** Names and descriptions are checked like board names: anything our text check flags is refused. */
function checkText(...texts: (string | undefined)[]) {
  if (texts.some((s) => s && analyzeText(s).risk !== 'normal')) throw new AppError(422, 'content_blocked', "This can't be shared. Try different words.");
}

/**
 * Mixes: song lists people make and share, from anywhere the music picker offers.
 *
 * - The owner names it, describes it, chooses who sees it (only me, friends, followers, everyone)
 *   and adds up to MIX_SONGS_MAX songs in an order they choose.
 * - Shared into a chat (registerMixChats), everyone in the chat can add songs and change the order
 *   and take off the songs they added; a line in the chat says who added songs.
 * - Listening: each song's allowed part, checked for each listener's country and the owner's
 *   account type; songs that can't play say why (lib/mixes.ts).
 * - Mixes can be liked, saved, shared as a post and reported. Blocks hide them both ways.
 */
export default async function mixesModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;
  const deps = { db, realtime: ctx.realtime };
  const providerOn = (p: string) => !!ctx.music.provider(p)?.enabled;

  /** A mix the viewer may see, as a summary row, or 404. */
  async function visibleMix(id: string, viewer: string | null): Promise<Row> {
    const { rows } = await db.query(`${MIX_SUMMARY} WHERE mx.id = $2 AND ${mixVisibleSql('$1')}`, [viewer, id]);
    if (!rows[0]) throw notFound('That mix');
    return rows[0];
  }

  async function ownMix(id: string, userId: string, action: string): Promise<Row> {
    const row = await visibleMix(id, userId);
    if (row.owner_id !== userId) throw forbidden(`Only the person who made this mix can ${action}.`);
    return row;
  }

  /** The owner, or someone in a chat it's shared into. */
  async function editableMix(id: string, userId: string): Promise<{ row: Row; role: 'owner' | 'collaborator' }> {
    const row = await visibleMix(id, userId);
    const role = roleOf(row, userId);
    if (!role) throw forbidden('Only the owner and the people in a chat it’s shared into can change the songs on this mix.');
    return { row, role };
  }

  /** A mix with its songs, as the viewer gets it. */
  async function detail(id: string, viewer: string | null, req?: FastifyRequest): Promise<MixDetail> {
    const row = await visibleMix(id, viewer);
    const [mix] = await presentMixes(db, [row], viewer, req ? isLite(req) : false);
    const songs = await mixSongs(db, {
      mixId: id,
      ownerBusiness: row.o_mode === 'business',
      viewer,
      role: mix!.role,
      providerOn,
    });
    return { ...mix!, songs };
  }

  /**
   * Check songs before they go on a mix: catalogue songs must still be offered, and their licence
   * must let this person play them where they are (and business use, when the mix's owner has a
   * business account); sounds must be ones they may see or use. Nothing is fetched from providers.
   */
  async function checkSongs(c: PoolClient, userId: string, ownerBusiness: boolean, refs: MixSongRef[]) {
    const trackIds = [...new Set(refs.flatMap((r) => (r.trackId ? [r.trackId] : [])))];
    const soundIds = [...new Set(refs.flatMap((r) => (r.soundId ? [r.soundId] : [])))];
    if (trackIds.length) {
      const { rows } = await c.query<{ id: string; provider: string; licence: MusicLicence; status: 'active' | 'withdrawn' | 'paused' }>(
        `SELECT id, provider, licence, status FROM music_tracks WHERE id = ANY($1::uuid[])`,
        [trackIds],
      );
      if (rows.length !== trackIds.length) throw notFound('That song');
      const who = await ctx.music.who(userId, c);
      for (const t of rows) {
        const why = songUnavailable(
          { licence: t.licence, status: t.status, providerOn: providerOn(t.provider) },
          { countries: who.countries, commercial: ownerBusiness },
        );
        if (why === 'withdrawn') throw unavailable('This song is no longer available. Choose another one.');
        if (why === 'unavailable') throw unavailable('This song isn’t available right now. Choose another one.');
        if (why === 'region') throw notAllowed('This song isn’t available in your country. Choose another one.');
        if (why === 'commercial')
          throw notAllowed('This mix belongs to a business account, so its songs need to be cleared for business use. Choose another one.');
      }
    }
    if (soundIds.length) {
      const { rows } = await c.query(`SELECT s.id FROM sounds s WHERE s.id = ANY($2::uuid[]) AND (${soundVisibleSql('$1')} OR ${soundUsableSql('$1')})`, [
        userId,
        soundIds,
      ]);
      if (rows.length !== soundIds.length) throw notFound('That sound');
    }
  }

  /** Put songs at the end of a mix, each once. Returns how many were new. */
  async function addSongs(mixId: string, userId: string, ownerBusiness: boolean, refs: MixSongRef[]): Promise<number> {
    if (!refs.length) return 0;
    return tx(db, async (c) => {
      // One change at a time per mix, so two adds can't pass the limit or take the same place.
      await c.query(`SELECT 1 FROM mixes WHERE id = $1 FOR UPDATE`, [mixId]);
      await checkSongs(c, userId, ownerBusiness, refs);
      const { rows: have } = await c.query<{ track_id: string | null; sound_id: string | null }>(`SELECT track_id, sound_id FROM mix_songs WHERE mix_id = $1`, [
        mixId,
      ]);
      const on = new Set(have.map((h) => h.track_id ?? h.sound_id));
      const seen = new Set<string>();
      const fresh = refs.filter((r) => {
        const key = (r.trackId ?? r.soundId)!;
        if (on.has(key) || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (have.length + fresh.length > MIX_SONGS_MAX) throw badRequest(`A mix holds up to ${MIX_SONGS_MAX} songs.`);
      if (!fresh.length) return 0;
      await c.query(
        `INSERT INTO mix_songs (mix_id, track_id, sound_id, added_by, position)
         SELECT $1, x.track_id, x.sound_id, $2, (SELECT coalesce(max(position), -1) FROM mix_songs WHERE mix_id = $1) + x.n
         FROM ROWS FROM (jsonb_to_recordset($3::jsonb) AS (track_id uuid, sound_id uuid)) WITH ORDINALITY AS x(track_id, sound_id, n)`,
        [mixId, userId, JSON.stringify(fresh.map((r) => ({ track_id: r.trackId ?? null, sound_id: r.soundId ?? null })))],
      );
      await c.query(`UPDATE mixes SET updated_at = now() WHERE id = $1`, [mixId]);
      return fresh.length;
    });
  }

  // ── Mixes ─────────────────────────────────────────────────────────────
  /** Your mixes: the ones you made, the ones shared with you in chats, or the ones you saved. */
  app.get('/v1/me/mixes', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { filter } = parse(mixListQuerySchema, req.query);
    const where =
      filter === 'own'
        ? `mx.owner_id = $1`
        : filter === 'shared'
          ? `mx.owner_id <> $1 AND EXISTS (SELECT 1 FROM mix_chats mc2 JOIN conversation_members cm2 ON cm2.conversation_id = mc2.conversation_id
                                           WHERE mc2.mix_id = mx.id AND cm2.user_id = $1 AND cm2.left_at IS NULL)`
          : `EXISTS (SELECT 1 FROM mix_saves sv2 WHERE sv2.mix_id = mx.id AND sv2.user_id = $1)`;
    const order = filter === 'saved' ? `(SELECT sv3.created_at FROM mix_saves sv3 WHERE sv3.mix_id = mx.id AND sv3.user_id = $1) DESC` : `mx.updated_at DESC`;
    const { rows } = await db.query(`${MIX_SUMMARY} WHERE ${where} AND ${mixVisibleSql('$1')} ORDER BY ${order}, mx.id LIMIT ${MIXES_MAX}`, [u.id]);
    // "Shared with you" lists only mixes you can add to right now.
    const list = filter === 'shared' ? rows.filter((r) => r.collaborator) : rows;
    return { items: await presentMixes(db, list, u.id, isLite(req)) };
  });

  /** The Mixes tab on a profile: the mixes the viewer may see. */
  app.get('/v1/users/:username/mixes', async (req) => {
    const { username } = parse(z.object({ username: usernameSchema }), req.params);
    const viewer = req.user?.id ?? null;
    const owner = (
      await db.query(
        `SELECT pr.user_id FROM profiles pr JOIN users u ON u.id = pr.user_id
         WHERE lower(pr.username) = lower($1) AND u.status = 'active' AND ${notBlockedSql('pr.user_id', '$2::uuid')}
           AND ($2::uuid IS NOT NULL OR NOT coalesce(u.birth_date > current_date - interval '18 years', false))`,
        [username, viewer],
      )
    ).rows[0];
    if (!owner) throw notFound('That profile');
    const { rows } = await db.query(`${MIX_SUMMARY} WHERE mx.owner_id = $2 AND ${mixVisibleSql('$1')} ORDER BY mx.updated_at DESC, mx.id LIMIT ${MIXES_MAX}`, [
      viewer,
      owner.user_id,
    ]);
    return { items: await presentMixes(db, rows, viewer, isLite(req)) };
  });

  /** Make a mix, with songs from the picker if you like. Making your first one puts Mixes on a profile that chose its tabs. */
  app.post('/v1/mixes', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    const input = parse(createMixSchema, req.body);
    checkText(input.title, input.description);
    const n = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM mixes WHERE owner_id = $1 AND deleted_at IS NULL`, [u.id])).rows[0]!.n;
    if (n >= MIXES_MAX) throw badRequest(`You have ${MIXES_MAX} mixes, the most you can have. Delete one to start another.`);
    const business = (await db.query(`SELECT mode FROM profiles WHERE user_id = $1`, [u.id])).rows[0]?.mode === 'business';
    const id = await tx(db, async (c) => {
      const { rows } = await c.query<{ id: string }>(`INSERT INTO mixes (owner_id, title, description, visibility) VALUES ($1,$2,$3,$4) RETURNING id`, [
        u.id,
        input.title,
        input.description,
        input.visibility,
      ]);
      if (n === 0)
        await c.query(`UPDATE profiles SET tabs = array_append(tabs, 'mixes') WHERE user_id = $1 AND tabs IS NOT NULL AND NOT ('mixes' = ANY(tabs))`, [u.id]);
      return rows[0]!.id;
    });
    try {
      await addSongs(id, u.id, business, input.songs);
    } catch (e) {
      await db.query(`DELETE FROM mixes WHERE id = $1`, [id]);
      throw e;
    }
    track(db, u.id, 'mix_created', { visibility: input.visibility, songs: input.songs.length });
    reply.code(201);
    return { mix: await detail(id, u.id, req) };
  });

  /** A mix and its songs in order, each with the part that plays for you (or why it doesn't). */
  app.get('/v1/mixes/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    return { mix: await detail(id, req.user?.id ?? null, req) };
  });

  /** Rename, describe or choose who sees it. Owner only. */
  app.patch('/v1/mixes/:id', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(updateMixSchema, req.body);
    const row = await ownMix(id, u.id, 'change it');
    checkText(input.title, input.description);
    await db.query(
      `UPDATE mixes SET title = coalesce($2, title), description = coalesce($3, description), visibility = coalesce($4, visibility), updated_at = now() WHERE id = $1`,
      [id, input.title ?? null, input.description ?? null, input.visibility ?? null],
    );
    await publishMixChanged(deps, id, row.owner_id);
    return { mix: await detail(id, u.id, req) };
  });

  /** Delete a mix, with its songs, likes and saves. Its cards in chats and posts say it's gone. Owner only. */
  app.delete('/v1/mixes/:id', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const row = await ownMix(id, u.id, 'delete it');
    await publishMixChanged(deps, id, row.owner_id);
    await db.query(`DELETE FROM mixes WHERE id = $1 AND owner_id = $2`, [id, u.id]);
    return { ok: true };
  });

  // ── Songs ─────────────────────────────────────────────────────────────
  /**
   * Add songs from the picker (up to MIX_ADD_MAX at a time) to the end of a mix you own or that's
   * shared into a chat you're in. Songs already on it are skipped. The chats it's shared into get a
   * line saying you added songs.
   */
  app.post('/v1/mixes/:id/songs', { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(addMixSongsSchema, req.body);
    const { row } = await editableMix(id, u.id);
    const added = await addSongs(id, u.id, row.o_mode === 'business', input.songs);
    if (added) {
      await noteSongsAdded(deps, { id, title: row.title }, u.id, added);
      await publishMixChanged(deps, id, row.owner_id);
    }
    reply.code(added ? 201 : 200);
    return { added, mix: await detail(id, u.id, req) };
  });

  /** Take a song off: the owner any song, others the songs they added. */
  app.delete('/v1/mixes/:id/songs/:songId', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id, songId } = parse(songParams, req.params);
    const { row, role } = await editableMix(id, u.id);
    const r = await db.query(`DELETE FROM mix_songs WHERE id = $2 AND mix_id = $1 AND ($3 OR added_by = $4)`, [id, songId, role === 'owner', u.id]);
    if (!r.rowCount) {
      const there = await db.query(`SELECT 1 FROM mix_songs WHERE id = $2 AND mix_id = $1`, [id, songId]);
      if (there.rowCount) throw forbidden('Only the owner can take off songs someone else added.');
      throw notFound('That song');
    }
    await db.query(`UPDATE mixes SET updated_at = now() WHERE id = $1`, [id]);
    await publishMixChanged(deps, id, row.owner_id);
    return { mix: await detail(id, u.id, req) };
  });

  /**
   * Put the songs in a new order: `songIds` lists every song on the mix, each once. If the mix
   * changed since you loaded it (someone added or took off a song), nothing moves: 409 `mix_changed`.
   */
  app.put('/v1/mixes/:id/order', { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { songIds } = parse(reorderMixSchema, req.body);
    const { row } = await editableMix(id, u.id);
    await tx(db, async (c) => {
      await c.query(`SELECT 1 FROM mixes WHERE id = $1 FOR UPDATE`, [id]);
      const { rows } = await c.query<{ id: string }>(`SELECT id FROM mix_songs WHERE mix_id = $1`, [id]);
      const given = new Set(songIds);
      if (rows.length !== given.size || rows.some((r) => !given.has(r.id)))
        throw new AppError(409, 'mix_changed', 'This mix changed while you were arranging it. Here it is now.');
      await c.query(`UPDATE mix_songs ms SET position = x.n - 1 FROM unnest($2::uuid[]) WITH ORDINALITY AS x(id, n) WHERE ms.mix_id = $1 AND ms.id = x.id`, [
        id,
        songIds,
      ]);
      await c.query(`UPDATE mixes SET updated_at = now() WHERE id = $1`, [id]);
    });
    await publishMixChanged(deps, id, row.owner_id);
    return { mix: await detail(id, u.id, req) };
  });

  // ── Likes and saves ───────────────────────────────────────────────────
  async function setLike(req: FastifyRequest, on: boolean) {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    await visibleMix(id, u.id);
    const changed = on
      ? await db.query(`INSERT INTO mix_likes (mix_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, u.id])
      : await db.query(`DELETE FROM mix_likes WHERE mix_id = $1 AND user_id = $2`, [id, u.id]);
    const { rows } = changed.rowCount
      ? await db.query<{ like_count: number }>(`UPDATE mixes SET like_count = greatest(like_count + $2, 0) WHERE id = $1 RETURNING like_count`, [
          id,
          on ? 1 : -1,
        ])
      : await db.query<{ like_count: number }>(`SELECT like_count FROM mixes WHERE id = $1`, [id]);
    return { liked: on, likeCount: rows[0]?.like_count ?? 0 };
  }
  app.put('/v1/mixes/:id/like', { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, (req) => setLike(req, true));
  app.delete('/v1/mixes/:id/like', { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, (req) => setLike(req, false));

  /** Save a mix you may see (your mixes page, Saved), or take it off. */
  app.put('/v1/mixes/:id/save', { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    await visibleMix(id, u.id);
    await db.query(`INSERT INTO mix_saves (user_id, mix_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [u.id, id]);
    return { saved: true };
  });
  app.delete('/v1/mixes/:id/save', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    await db.query(`DELETE FROM mix_saves WHERE user_id = $1 AND mix_id = $2`, [u.id, id]);
    return { saved: false };
  });

  // ── Sharing ───────────────────────────────────────────────────────────
  /**
   * Share a mix as a post: its card, with your words (or its name). The post is checked like any
   * post. The owner can share their mix (not one only they see); others can share public mixes.
   * Each person who sees the post sees the card only while they may see the mix.
   */
  app.post('/v1/mixes/:id/post', { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(postMixSchema, req.body);
    const row = await visibleMix(id, u.id);
    if (row.visibility === 'private') throw new AppError(400, 'mix_private', 'This mix is only for you. Choose who can see it before you share it.');
    if (row.owner_id !== u.id && row.visibility !== 'public') throw forbidden('Only public mixes can be shared as a post by others.');
    const post = createPostSchema.parse({ body: input.body || row.title, visibility: input.visibility });
    const screening = await screenPost(db, ctx.config, u.id, { body: post.body, pollText: '', visibility: post.visibility, communityId: null });
    let limitedNow = false;
    const written = await tx(db, async (c) => {
      const w = await writePost(c, u.id, post, { state: 'published', moderationStatus: screening.status, music: null });
      await c.query(`UPDATE posts SET mix_id = $2 WHERE id = $1`, [w.id, id]);
      limitedNow = await recordFlags(c, ctx.realtime, u.id, w.id, screening);
      return w;
    });
    await announcePost(ctx, {
      postId: written.id,
      authorId: u.id,
      kind: written.kind,
      visibility: post.visibility,
      communityId: null,
      body: post.body,
      status: screening.status,
      taggedIds: written.taggedIds,
      collaborators: [],
      remixAuthor: null,
      remixOf: null,
      remixMode: null,
    });
    track(db, u.id, 'mix_shared', { to: 'post' });
    const [shared] = await hydratePosts(db, [written.id], u.id);
    const notice = moderationNotice(screening, limitedNow);
    reply.code(201);
    return { post: shared, ...(notice ? { moderation: notice } : {}) };
  });

  /** Stop sharing a mix with a chat: its card stays, but people there can't change the songs any more. Owner only. */
  app.delete('/v1/mixes/:id/chats/:conversationId', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id, conversationId } = parse(chatParams, req.params);
    const row = await ownMix(id, u.id, 'stop sharing it');
    await publishMixChanged(deps, id, row.owner_id);
    const r = await db.query(`DELETE FROM mix_chats WHERE mix_id = $1 AND conversation_id = $2`, [id, conversationId]);
    if (!r.rowCount) throw notFound('That chat');
    return { mix: await detail(id, u.id, req) };
  });
}

/**
 * Share a mix into a chat (one-to-one or group): its card goes in the chat as a message from the
 * owner, and from then on everyone in the chat can add and reorder songs. Sharing follows the
 * messaging rules (blocks, minor safety, who can message whom, group safety, pace). Registered by
 * the messaging module, which has the chat helpers.
 */
export function registerMixChats(app: FastifyInstance, ctx: AppContext, h: ChatHelpers) {
  const db = ctx.db;

  async function assertCanShare(u: AuthUser, conversationId: string) {
    const conv = (await db.query<{ kind: string }>(`SELECT kind FROM conversations WHERE id = $1`, [conversationId])).rows[0];
    if (!conv) throw notFound('Conversation');
    if (conv.kind !== 'direct' && conv.kind !== 'group') throw new AppError(400, 'mixes_unavailable', 'Mixes can be shared into one-to-one chats and groups.');
    const members = await h.memberIds(conversationId);
    if (conv.kind === 'direct') {
      const other = members.find((m) => m !== u.id);
      if (!other) throw new AppError(400, 'nobody_to_share', 'There’s nobody else in this chat.');
      await h.assertCanMessage(u.id, u.birthDate, other);
    } else await h.assertGroupSafe([u.id], members);
    await assertMessagePace(db, ctx.config, u.id);
  }

  app.post('/v1/mixes/:id/share', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(shareMixSchema, req.body);
    const { rows } = await db.query(`SELECT mx.id, mx.owner_id, mx.title, mx.visibility ${MIX_FROM} WHERE mx.id = $2 AND ${mixVisibleSql('$1')}`, [u.id, id]);
    const mix = rows[0];
    if (!mix) throw notFound('That mix');
    if (mix.owner_id !== u.id) throw forbidden('Only the person who made this mix can share it into a chat.');
    if (mix.visibility === 'private') throw new AppError(400, 'mix_private', 'This mix is only for you. Choose who can see it before you share it.');
    await h.assertMember(input.conversationId, u.id);
    await assertCanShare(u, input.conversationId);
    // Already shared here, with its card still in the chat: that card.
    const existing = (
      await db.query<{ message_id: string }>(
        `SELECT mc.message_id FROM mix_chats mc JOIN messages card ON card.id = mc.message_id
         WHERE mc.mix_id = $1 AND mc.conversation_id = $2 AND card.deleted_at IS NULL AND (card.expires_at IS NULL OR card.expires_at > now())`,
        [id, input.conversationId],
      )
    ).rows[0];
    if (existing) {
      const message = await h.loadMessage(existing.message_id, u.id);
      if (message) return { message, alreadyShared: true };
    }
    const seconds: number | null =
      (await db.query(`SELECT disappearing_seconds FROM conversations WHERE id = $1`, [input.conversationId])).rows[0]?.disappearing_seconds ?? null;
    const sent = await tx(db, async (c) => {
      const { rows: msg } = await c.query(
        `INSERT INTO messages (conversation_id, sender_id, body, client_id, kind, meta, expires_at)
         VALUES ($1,$2,$3,$4,'message',$5, now() + make_interval(secs => $6::int))
         ON CONFLICT (sender_id, client_id) WHERE client_id IS NOT NULL DO UPDATE SET client_id = EXCLUDED.client_id
         RETURNING id, conversation_id, (xmax = 0) AS inserted`,
        [input.conversationId, u.id, mix.title, input.clientId ?? null, { mixId: id }, seconds],
      );
      const r = msg[0] as { id: string; conversation_id: string; inserted: boolean };
      if (r.conversation_id !== input.conversationId) throw badRequest('That clientId was used in another chat.');
      if (!r.inserted) return { id: r.id, inserted: false };
      // A card that was unsent or disappeared leaves its row behind: this one takes its place.
      await c.query(`DELETE FROM mix_chats WHERE mix_id = $1 AND conversation_id = $2`, [id, input.conversationId]);
      await c.query(`INSERT INTO mix_chats (mix_id, conversation_id, message_id, shared_by) VALUES ($1,$2,$3,$4)`, [id, input.conversationId, r.id, u.id]);
      if (seconds) await enqueue(c, 'messages.expire', { messageId: r.id }, seconds + 1);
      await c.query(`UPDATE conversations SET last_message_at = now() WHERE id = $1`, [input.conversationId]);
      await c.query(`UPDATE conversation_members SET last_read_at = now() WHERE conversation_id = $1 AND user_id = $2`, [input.conversationId, u.id]);
      return { id: r.id, inserted: true };
    });
    const message = await h.loadMessage(sent.id, u.id);
    if (!message) throw notFound('Message');
    if (sent.inserted) {
      // Everyone else in the chat gets the card as someone who can add to it (their likes and saves load when they open it).
      const forOthers =
        message.mix?.available === true
          ? { ...message, mix: { ...message.mix, role: 'collaborator' as const, canAdd: true, liked: false, saved: false, chats: [] } }
          : message;
      const others = (await h.notBlocking(u.id, await h.memberIds(input.conversationId))).filter((m) => m !== u.id);
      await ctx.realtime.publish([u.id], { type: 'message.created', data: message });
      await ctx.realtime.publish(others, { type: 'message.created', data: forOthers });
      await pushNewMessage({ db, realtime: ctx.realtime }, sent.id);
      track(db, u.id, 'mix_shared', { to: 'chat' });
    }
    reply.code(sent.inserted ? 201 : 200);
    return { message };
  });
}
