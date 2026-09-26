import type { FastifyInstance } from 'fastify';
import { tx } from '@yapilapi/database';
import { circleMembersSchema, circleSchema, pageQuerySchema, setInterestsSchema, updateProfileSchema, usernameSchema, type Profile } from '@yapilapi/shared';
import { z } from 'zod';
import { badRequest, conflict, forbidden, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { decodeCursor, encodeCursor } from '../lib/cursor.ts';
import { notify, track } from '../lib/services.ts';
import { emitWebhook } from '../lib/webhooks.ts';
import { ageOf, areFriends, isBlockedEitherWay, PUBLIC_USER_COLS, toPublicUser, type PublicUserRow } from '../lib/users.ts';
import { notBlockedSql } from '../lib/visibility.ts';
import { me, requireAuth } from '../plugins/auth.ts';

const idParam = z.object({ id: z.string().uuid() });

export default async function profilesModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;

  /**
   * People to add to a conversation, as you type. With no query: friends, people
   * you follow and recent chat partners. With a query: name or username prefix
   * matches, friends first, then people you follow, then everyone else. Blocked
   * people never appear; `canMessage` is false where minor protection or family
   * settings would refuse the conversation, so the app can say so up front.
   */
  app.get('/v1/people/suggest', { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { q, limit } = parse(z.object({ q: z.string().trim().max(60).default(''), limit: z.coerce.number().int().min(1).max(20).default(8) }), req.query);
    // Literal match: %, _ and backslash are escaped rather than dropped (usernames often contain _).
    const term = q.replace(/^@/, '').replace(/[\\%_]/g, (c) => `\\${c}`);
    const { rows } = await ctx.db.query(
      `WITH me AS (SELECT birth_date FROM users WHERE id = $1),
       rel AS (
         SELECT pr.user_id,
                EXISTS (SELECT 1 FROM friendships fr WHERE (fr.user_a = $1 AND fr.user_b = pr.user_id) OR (fr.user_b = $1 AND fr.user_a = pr.user_id)) AS friend,
                EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followee_id = pr.user_id) AS following,
                (SELECT max(m.created_at) FROM messages m JOIN conversation_members a ON a.conversation_id = m.conversation_id AND a.user_id = $1
                   JOIN conversation_members b ON b.conversation_id = m.conversation_id AND b.user_id = pr.user_id) AS last_chat
         FROM profiles pr JOIN users u2 ON u2.id = pr.user_id
         WHERE pr.user_id <> $1 AND u2.status = 'active' AND u2.deleted_at IS NULL AND ${notBlockedSql('pr.user_id', '$1')}
           AND (
             ($2 = '' AND (EXISTS (SELECT 1 FROM friendships fr WHERE (fr.user_a = $1 AND fr.user_b = pr.user_id) OR (fr.user_b = $1 AND fr.user_a = pr.user_id))
                           OR EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followee_id = pr.user_id)
                           OR EXISTS (SELECT 1 FROM conversation_members a JOIN conversation_members b ON b.conversation_id = a.conversation_id
                                      WHERE a.user_id = $1 AND b.user_id = pr.user_id)))
             OR ($2 <> '' AND (pr.username ILIKE $2 || '%' OR pr.display_name ILIKE $2 || '%' OR pr.display_name ILIKE '% ' || $2 || '%'))
           )
       )
       SELECT ${PUBLIC_USER_COLS}, rel.friend, rel.following,
              -- Minor protection: an adult and a minor can only message once they're friends.
              (rel.friend OR NOT (
                 (coalesce(u2.birth_date > current_date - interval '18 years', false)) <>
                 (coalesce((SELECT birth_date FROM me) > current_date - interval '18 years', false)))) AS can_message
       FROM rel JOIN profiles pr ON pr.user_id = rel.user_id JOIN users u2 ON u2.id = rel.user_id
       ORDER BY rel.friend DESC, rel.following DESC, rel.last_chat DESC NULLS LAST,
                (pr.username ILIKE $2 || '%') DESC, pr.display_name
       LIMIT $3`,
      [u.id, term, limit],
    );
    return {
      items: rows.map((r) => ({
        user: toPublicUser(r as PublicUserRow),
        relation: r.friend ? 'friend' : r.following ? 'following' : null,
        canMessage: !!r.can_message,
      })),
    };
  });

  async function userIdByUsername(username: string, viewer: string | null): Promise<string> {
    const { rows } = await db.query<{ user_id: string }>(
      `SELECT pr.user_id FROM profiles pr JOIN users u ON u.id = pr.user_id
       WHERE lower(pr.username) = lower($1) AND u.status = 'active' AND ${notBlockedSql('pr.user_id', '$2')}`,
      [username, viewer],
    );
    if (!rows[0]) throw notFound('That profile');
    return rows[0].user_id;
  }

  async function loadProfile(userId: string, viewer: string | null): Promise<Profile> {
    const { rows } = await db.query(
      `SELECT ${PUBLIC_USER_COLS}, pr.bio, pr.cover_url, pr.links, pr.is_private,
        (SELECT count(*) FROM follows WHERE followee_id = pr.user_id) AS followers,
        (SELECT count(*) FROM follows WHERE follower_id = pr.user_id) AS following,
        (SELECT count(*) FROM friendships WHERE user_a = pr.user_id OR user_b = pr.user_id) AS friends,
        (SELECT count(*) FROM posts WHERE author_id = pr.user_id AND deleted_at IS NULL AND community_id IS NULL) AS posts,
        (SELECT coalesce(array_agg(t.slug ORDER BY t.slug), '{}') FROM user_interests ui JOIN topics t ON t.id = ui.topic_id WHERE ui.user_id = pr.user_id) AS interests,
        EXISTS (SELECT 1 FROM follows WHERE follower_id = $2 AND followee_id = pr.user_id) AS following_them,
        EXISTS (SELECT 1 FROM follows WHERE follower_id = pr.user_id AND followee_id = $2) AS followed_by,
        EXISTS (SELECT 1 FROM friendships WHERE (user_a = $2 AND user_b = pr.user_id) OR (user_b = $2 AND user_a = pr.user_id)) AS is_friend,
        (SELECT CASE WHEN from_user_id = $2 THEN 'sent' ELSE 'received' END FROM friend_requests
          WHERE status = 'pending' AND ((from_user_id = $2 AND to_user_id = pr.user_id) OR (from_user_id = pr.user_id AND to_user_id = $2)) LIMIT 1) AS friend_request,
        EXISTS (SELECT 1 FROM blocks WHERE blocker_id = $2 AND blocked_id = pr.user_id) AS blocked,
        EXISTS (SELECT 1 FROM mutes WHERE muter_id = $2 AND muted_id = pr.user_id) AS muted
       FROM profiles pr WHERE pr.user_id = $1`,
      [userId, viewer],
    );
    const r = rows[0];
    if (!r) throw notFound('That profile');
    return {
      ...toPublicUser(r as PublicUserRow),
      bio: r.bio,
      coverUrl: r.cover_url,
      links: r.links,
      isPrivate: r.is_private,
      interests: r.interests,
      counts: { followers: r.followers, following: r.following, friends: r.friends, posts: r.posts },
      relationship: {
        isSelf: viewer === userId,
        following: r.following_them,
        followedBy: r.followed_by,
        friends: r.is_friend,
        friendRequest: r.friend_request ?? 'none',
        blocked: r.blocked,
        muted: r.muted,
      },
    };
  }

  // ── Profile ───────────────────────────────────────────────────────────
  app.get('/v1/users/:username', async (req) => {
    const { username } = parse(z.object({ username: usernameSchema }), req.params);
    const id = await userIdByUsername(username, req.user?.id ?? null);
    return { profile: await loadProfile(id, req.user?.id ?? null) };
  });

  app.patch('/v1/me/profile', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const input = parse(updateProfileSchema, req.body);
    const map: Record<string, string> = {
      displayName: 'display_name',
      bio: 'bio',
      avatarUrl: 'avatar_url',
      coverUrl: 'cover_url',
      links: 'links',
      mode: 'mode',
      locale: 'locale',
      isPrivate: 'is_private',
      country: 'country',
    };
    const sets: string[] = [];
    const vals: unknown[] = [u.id];
    for (const [k, col] of Object.entries(map)) {
      const v = (input as Record<string, unknown>)[k];
      if (v === undefined) continue;
      vals.push(k === 'links' ? JSON.stringify(v) : v);
      sets.push(`${col} = $${vals.length}`);
    }
    // Minors can't make their account public.
    if (input.isPrivate === false) {
      const age = ageOf(u.birthDate);
      if (age !== null && age < 18) throw forbidden('Accounts for people under 18 stay private.');
    }
    if (input.country !== undefined) sets.push(input.country === null ? `country_source = NULL` : `country_source = 'user'`);
    if (sets.length) await db.query(`UPDATE profiles SET ${sets.join(', ')} WHERE user_id = $1`, vals);
    return { profile: await loadProfile(u.id, u.id) };
  });

  app.get('/v1/topics', async () => {
    const { rows } = await db.query(`SELECT slug, name FROM topics ORDER BY name`);
    return { items: rows };
  });

  app.put('/v1/me/interests', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { topics } = parse(setInterestsSchema, req.body);
    const slugs = [...new Set(topics.map((t) => t.toLowerCase().trim().replace(/\s+/g, '-')))];
    await tx(db, async (c) => {
      for (const s of slugs) await c.query(`INSERT INTO topics (slug, name) VALUES ($1, initcap(replace($1, '-', ' '))) ON CONFLICT (slug) DO NOTHING`, [s]);
      await c.query(`DELETE FROM user_interests WHERE user_id = $1`, [u.id]);
      await c.query(`INSERT INTO user_interests (user_id, topic_id) SELECT $1, id FROM topics WHERE slug = ANY($2)`, [u.id, slugs]);
    });
    return { interests: slugs };
  });

  app.post('/v1/me/onboarding/complete', { preHandler: requireAuth }, async (req) => {
    await db.query(`UPDATE users SET onboarded_at = coalesce(onboarded_at, now()) WHERE id = $1`, [me(req).id]);
    return { ok: true };
  });

  /** People to follow: shared interests, friends-of-follows, then popular. Excludes blocked and already-followed. */
  app.get('/v1/me/suggestions', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { rows } = await db.query(
      `SELECT ${PUBLIC_USER_COLS}, pr.bio,
        (SELECT count(*) FROM user_interests a JOIN user_interests b ON a.topic_id = b.topic_id WHERE a.user_id = $1 AND b.user_id = pr.user_id) AS shared,
        (SELECT count(*) FROM follows f1 JOIN follows f2 ON f2.follower_id = f1.followee_id WHERE f1.follower_id = $1 AND f2.followee_id = pr.user_id) AS mutual,
        (SELECT count(*) FROM follows WHERE followee_id = pr.user_id) AS followers
       FROM profiles pr JOIN users us ON us.id = pr.user_id
       WHERE pr.user_id <> $1 AND us.status = 'active' AND NOT pr.is_private
         AND NOT EXISTS (SELECT 1 FROM follows WHERE follower_id = $1 AND followee_id = pr.user_id)
         AND ${notBlockedSql('pr.user_id', '$1')}
       ORDER BY shared DESC, mutual DESC, followers DESC, pr.created_at DESC LIMIT 12`,
      [u.id],
    );
    return {
      items: rows.map((r) => ({
        user: toPublicUser(r as PublicUserRow),
        bio: r.bio,
        reason:
          r.mutual > 0
            ? `Followed by ${r.mutual} people you follow`
            : r.shared > 0
              ? `${r.shared} shared interest${r.shared > 1 ? 's' : ''}`
              : 'Popular on YAPILAPI',
      })),
    };
  });

  // ── Follow ────────────────────────────────────────────────────────────
  app.post('/v1/users/:id/follow', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    if (id === u.id) throw badRequest("You can't follow yourself.");
    if (await isBlockedEitherWay(db, u.id, id)) throw notFound('That profile');
    const r = await db.query(`INSERT INTO follows (follower_id, followee_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [u.id, id]).catch((e) => {
      if (e.code === '23503') throw notFound('That profile');
      throw e;
    });
    if (r.rowCount) {
      await notify(db, ctx.realtime, { userId: id, category: 'friends', type: 'follow', actorId: u.id, entityType: 'user', entityId: u.id });
      track(db, u.id, 'follow', { followee: id });
      await emitWebhook(db, id, 'follower.new', { followerId: u.id });
    }
    return { following: true };
  });

  app.delete('/v1/users/:id/follow', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    await db.query(`DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2`, [me(req).id, id]);
    return { following: false };
  });

  async function listUsers(sql: string, params: unknown[], cursor?: string, limit = 30) {
    const c = decodeCursor<{ o: number }>(cursor);
    const offset = c?.o ?? 0;
    const { rows } = await db.query<PublicUserRow>(`${sql} LIMIT ${limit + 1} OFFSET ${offset}`, params);
    return { items: rows.slice(0, limit).map(toPublicUser), nextCursor: rows.length > limit ? encodeCursor({ o: offset + limit }) : null };
  }

  app.get('/v1/users/:id/followers', async (req) => {
    const { id } = parse(idParam, req.params);
    const q = parse(pageQuerySchema, req.query);
    return listUsers(
      `SELECT ${PUBLIC_USER_COLS} FROM follows f JOIN profiles pr ON pr.user_id = f.follower_id WHERE f.followee_id = $1 AND ${notBlockedSql('pr.user_id', '$2')} ORDER BY f.created_at DESC`,
      [id, req.user?.id ?? null],
      q.cursor,
      q.limit,
    );
  });

  app.get('/v1/users/:id/following', async (req) => {
    const { id } = parse(idParam, req.params);
    const q = parse(pageQuerySchema, req.query);
    return listUsers(
      `SELECT ${PUBLIC_USER_COLS} FROM follows f JOIN profiles pr ON pr.user_id = f.followee_id WHERE f.follower_id = $1 AND ${notBlockedSql('pr.user_id', '$2')} ORDER BY f.created_at DESC`,
      [id, req.user?.id ?? null],
      q.cursor,
      q.limit,
    );
  });

  app.get('/v1/users/:id/friends', async (req) => {
    const { id } = parse(idParam, req.params);
    const q = parse(pageQuerySchema, req.query);
    return listUsers(
      `SELECT ${PUBLIC_USER_COLS} FROM friendships fr JOIN profiles pr ON pr.user_id = CASE WHEN fr.user_a = $1 THEN fr.user_b ELSE fr.user_a END
       WHERE (fr.user_a = $1 OR fr.user_b = $1) AND ${notBlockedSql('pr.user_id', '$2')} ORDER BY fr.created_at DESC`,
      [id, req.user?.id ?? null],
      q.cursor,
      q.limit,
    );
  });

  // ── Friends ───────────────────────────────────────────────────────────
  app.post('/v1/users/:id/friend-request', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    if (id === u.id) throw badRequest("You can't add yourself.");
    if (await isBlockedEitherWay(db, u.id, id)) throw notFound('That profile');
    if (await areFriends(db, u.id, id)) return { status: 'friends' };
    // If they already asked us, accept instead.
    const reverse = await db.query<{ id: string }>(`SELECT id FROM friend_requests WHERE from_user_id = $1 AND to_user_id = $2 AND status = 'pending'`, [
      id,
      u.id,
    ]);
    if (reverse.rows[0]) return acceptRequest(reverse.rows[0].id, u.id);
    const r = await db.query<{ id: string }>(`INSERT INTO friend_requests (from_user_id, to_user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING id`, [
      u.id,
      id,
    ]);
    if (r.rows[0])
      await notify(db, ctx.realtime, {
        userId: id,
        category: 'friends',
        type: 'friend_request',
        actorId: u.id,
        entityType: 'friend_request',
        entityId: r.rows[0].id,
      });
    return { status: 'sent' };
  });

  async function acceptRequest(requestId: string, userId: string) {
    return tx(db, async (c) => {
      const { rows } = await c.query<{ from_user_id: string }>(
        `UPDATE friend_requests SET status = 'accepted', responded_at = now() WHERE id = $1 AND to_user_id = $2 AND status = 'pending' RETURNING from_user_id`,
        [requestId, userId],
      );
      if (!rows[0]) throw notFound('Friend request');
      const [a, b] = [rows[0].from_user_id, userId].sort();
      await c.query(`INSERT INTO friendships (user_a, user_b) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [a, b]);
      await notify(c, ctx.realtime, {
        userId: rows[0].from_user_id,
        category: 'friends',
        type: 'friend_accepted',
        actorId: userId,
        entityType: 'user',
        entityId: userId,
      });
      track(db, userId, 'friend_accepted');
      return { status: 'friends' };
    });
  }

  app.get('/v1/me/friend-requests', { preHandler: requireAuth }, async (req) => {
    const { rows } = await db.query(
      `SELECT fr.id AS request_id, fr.created_at AS requested_at, ${PUBLIC_USER_COLS} FROM friend_requests fr JOIN profiles pr ON pr.user_id = fr.from_user_id
       WHERE fr.to_user_id = $1 AND fr.status = 'pending' ORDER BY fr.created_at DESC`,
      [me(req).id],
    );
    return { items: rows.map((r) => ({ id: r.request_id, createdAt: r.requested_at, from: toPublicUser(r as PublicUserRow) })) };
  });

  app.post('/v1/friend-requests/:id/accept', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    return acceptRequest(id, me(req).id);
  });

  app.post('/v1/friend-requests/:id/decline', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    const r = await db.query(`UPDATE friend_requests SET status = 'declined', responded_at = now() WHERE id = $1 AND to_user_id = $2 AND status = 'pending'`, [
      id,
      me(req).id,
    ]);
    if (!r.rowCount) throw notFound('Friend request');
    return { status: 'declined' };
  });

  app.delete('/v1/users/:id/friend', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const [a, b] = [u.id, id].sort();
    await db.query(`DELETE FROM friendships WHERE user_a = $1 AND user_b = $2`, [a, b]);
    await db.query(
      `UPDATE friend_requests SET status = 'cancelled' WHERE status = 'pending' AND ((from_user_id = $1 AND to_user_id = $2) OR (from_user_id = $2 AND to_user_id = $1))`,
      [u.id, id],
    );
    return { status: 'none' };
  });

  // ── Block, mute, restrict ─────────────────────────────────────────────
  app.post('/v1/users/:id/block', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    if (id === u.id) throw badRequest("You can't block yourself.");
    await tx(db, async (c) => {
      await c.query(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [u.id, id]);
      // Blocking cuts every connection both ways.
      await c.query(`DELETE FROM follows WHERE (follower_id = $1 AND followee_id = $2) OR (follower_id = $2 AND followee_id = $1)`, [u.id, id]);
      const [a, b] = [u.id, id].sort();
      await c.query(`DELETE FROM friendships WHERE user_a = $1 AND user_b = $2`, [a, b]);
      await c.query(
        `UPDATE friend_requests SET status = 'cancelled' WHERE status = 'pending' AND ((from_user_id = $1 AND to_user_id = $2) OR (from_user_id = $2 AND to_user_id = $1))`,
        [u.id, id],
      );
    });
    return { blocked: true };
  });

  app.delete('/v1/users/:id/block', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    await db.query(`DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2`, [me(req).id, id]);
    return { blocked: false };
  });

  app.get('/v1/me/blocked', { preHandler: requireAuth }, async (req) => {
    const { rows } = await db.query<PublicUserRow>(
      `SELECT ${PUBLIC_USER_COLS} FROM blocks b JOIN profiles pr ON pr.user_id = b.blocked_id WHERE b.blocker_id = $1`,
      [me(req).id],
    );
    return { items: rows.map(toPublicUser) };
  });

  for (const [path, table, a, b] of [
    ['mute', 'mutes', 'muter_id', 'muted_id'],
    ['restrict', 'restrictions', 'restrictor_id', 'restricted_id'],
  ] as const) {
    app.post(`/v1/users/:id/${path}`, { preHandler: requireAuth }, async (req) => {
      const { id } = parse(idParam, req.params);
      if (id === me(req).id) throw badRequest(`You can't ${path} yourself.`);
      await db.query(`INSERT INTO ${table} (${a}, ${b}) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [me(req).id, id]);
      return { [path === 'mute' ? 'muted' : 'restricted']: true };
    });
    app.delete(`/v1/users/:id/${path}`, { preHandler: requireAuth }, async (req) => {
      const { id } = parse(idParam, req.params);
      await db.query(`DELETE FROM ${table} WHERE ${a} = $1 AND ${b} = $2`, [me(req).id, id]);
      return { [path === 'mute' ? 'muted' : 'restricted']: false };
    });
  }

  // ── Circles ───────────────────────────────────────────────────────────
  app.get('/v1/me/circles', { preHandler: requireAuth }, async (req) => {
    const { rows } = await db.query(
      `SELECT c.id, c.name, c.kind, c.created_at, (SELECT count(*) FROM circle_members WHERE circle_id = c.id) AS member_count
       FROM circles c WHERE c.owner_id = $1 ORDER BY c.created_at`,
      [me(req).id],
    );
    return { items: rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind, memberCount: r.member_count, createdAt: r.created_at })) };
  });

  app.post('/v1/me/circles', { preHandler: requireAuth }, async (req, reply) => {
    const input = parse(circleSchema, req.body);
    const count = await db.query(`SELECT count(*) AS n FROM circles WHERE owner_id = $1`, [me(req).id]);
    if (count.rows[0].n >= 50) throw conflict('You can have up to 50 circles.');
    const { rows } = await db.query(`INSERT INTO circles (owner_id, name, kind) VALUES ($1,$2,$3) RETURNING id, name, kind`, [
      me(req).id,
      input.name,
      input.kind,
    ]);
    reply.code(201);
    return { circle: { ...rows[0], memberCount: 0 } };
  });

  async function ownCircle(circleId: string, userId: string) {
    const r = await db.query(`SELECT 1 FROM circles WHERE id = $1 AND owner_id = $2`, [circleId, userId]);
    if (!r.rowCount) throw notFound('Circle');
  }

  app.get('/v1/me/circles/:id/members', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    await ownCircle(id, me(req).id);
    const { rows } = await db.query<PublicUserRow>(
      `SELECT ${PUBLIC_USER_COLS} FROM circle_members cm JOIN profiles pr ON pr.user_id = cm.user_id WHERE cm.circle_id = $1`,
      [id],
    );
    return { items: rows.map(toPublicUser) };
  });

  app.post('/v1/me/circles/:id/members', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { userIds } = parse(circleMembersSchema, req.body);
    await ownCircle(id, me(req).id);
    await db.query(`INSERT INTO circle_members (circle_id, user_id) SELECT $1, u.id FROM users u WHERE u.id = ANY($2) AND u.id <> $3 ON CONFLICT DO NOTHING`, [
      id,
      userIds,
      me(req).id,
    ]);
    return { ok: true };
  });

  app.delete('/v1/me/circles/:id/members/:userId', { preHandler: requireAuth }, async (req) => {
    const { id, userId } = parse(z.object({ id: z.string().uuid(), userId: z.string().uuid() }), req.params);
    await ownCircle(id, me(req).id);
    await db.query(`DELETE FROM circle_members WHERE circle_id = $1 AND user_id = $2`, [id, userId]);
    return { ok: true };
  });

  app.delete('/v1/me/circles/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    await ownCircle(id, me(req).id);
    await db.query(`DELETE FROM circles WHERE id = $1`, [id]);
    return { ok: true };
  });
}
