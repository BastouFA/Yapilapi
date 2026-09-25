import { z } from 'zod';
import {
  AppError,
  clampLimit,
  conflict,
  decodeCursor,
  encodeCursor,
  forbidden,
  invalid,
  notFound,
} from '@yapilapi/shared';
import { withTransaction } from '@yapilapi/database';
import { route } from '../../lib/route.js';
import { audit } from '../../lib/audit.js';
import { notify } from '../../lib/notify.js';
import { safeRecordBehavior } from '../../lib/safety-signals.js';
import { isBlockedEitherWay, resolveUser } from '../../lib/users.js';
import type { ApiModule } from '../types.js';
import { CARD_COLUMNS, removeFollow, removeFriendship, sortPair, toCard } from './service.js';

const usernameParams = z.object({ username: z.string().min(1).max(40) });
const userIdParams = z.object({ userId: z.uuid() });
const idParams = z.object({ id: z.uuid() });
const pageQuery = z.object({
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
const circleBody = z.object({
  kind: z.enum(['family', 'close_friends', 'work', 'business', 'travel', 'custom']),
  name: z.string().trim().min(1).max(40),
});
const circleMemberParams = z.object({ id: z.uuid(), userId: z.uuid() });

export const graphModule: ApiModule = {
  name: 'graph',
  register(app, ctx) {
    // ------------------------------------------------------------------ follow
    route(app, ctx, {
      method: 'PUT',
      url: '/v1/users/:username/follow',
      summary: 'Follow a user (or request to, for private accounts)',
      tags: ['graph'],
      auth: 'user',
      params: usernameParams,
      rateLimit: { limit: 60, windowSec: 600, by: 'user' },
      handler: async ({ auth, params }) => {
        const target = await resolveUser(ctx, auth.userId, params.username);
        if (target.id === auth.userId)
          throw new AppError('unprocessable', 'You cannot follow yourself');
        const status = target.isPrivate ? 'pending' : 'active';
        const result = await withTransaction(ctx.db, async (tx) => {
          const ins = await tx.query(
            `INSERT INTO follows (follower_id, followee_id, status) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING status`,
            [auth.userId, target.id, status],
          );
          if (!ins.rowCount) {
            const cur = await tx.query<{ status: string }>(
              'SELECT status FROM follows WHERE follower_id = $1 AND followee_id = $2',
              [auth.userId, target.id],
            );
            return { status: cur.rows[0]!.status, created: false };
          }
          if (status === 'active') {
            await tx.query(
              'UPDATE profiles SET following_count = following_count + 1 WHERE user_id = $1',
              [auth.userId],
            );
            await tx.query(
              'UPDATE profiles SET follower_count = follower_count + 1 WHERE user_id = $1',
              [target.id],
            );
          }
          return { status, created: true };
        });
        if (result.created) {
          await notify(ctx, {
            userId: target.id,
            kind: status === 'active' ? 'follow' : 'follow_request',
            actorId: auth.userId,
            targetType: 'user',
            targetId: auth.userId,
          });
          ctx.metrics.events.inc({ name: 'follow' });
          void safeRecordBehavior(ctx, { surface: 'follow', userId: auth.userId });
        }
        return { status: result.status };
      },
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/users/:username/follow',
      summary: 'Unfollow / cancel a follow request',
      tags: ['graph'],
      auth: 'user',
      params: usernameParams,
      handler: async ({ auth, params }) => {
        const target = await resolveUser(ctx, auth.userId, params.username);
        await withTransaction(ctx.db, (tx) => removeFollow(tx, auth.userId, target.id));
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/follow-requests',
      summary: 'Pending follow requests for you',
      tags: ['graph'],
      auth: 'user',
      handler: async ({ auth }) => {
        const { rows } = await ctx.db.query(
          `SELECT ${CARD_COLUMNS}, f.created_at FROM follows f JOIN profiles p ON p.user_id = f.follower_id
            WHERE f.followee_id = $1 AND f.status = 'pending'
              AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = f.follower_id) OR (b.blocker_id = f.follower_id AND b.blocked_id = $1))
            ORDER BY f.created_at DESC LIMIT 100`,
          [auth.userId],
        );
        return {
          items: rows.map((r) => ({
            ...toCard(r),
            requestedAt: (r.created_at as Date).toISOString(),
          })),
        };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/follow-requests/:userId/approve',
      summary: 'Approve a follow request',
      tags: ['graph'],
      auth: 'user',
      params: userIdParams,
      handler: async ({ auth, params }) => {
        const ok = await withTransaction(ctx.db, async (tx) => {
          const r = await tx.query(
            `UPDATE follows SET status = 'active' WHERE follower_id = $1 AND followee_id = $2 AND status = 'pending'`,
            [params.userId, auth.userId],
          );
          if (!r.rowCount) return false;
          await tx.query(
            'UPDATE profiles SET following_count = following_count + 1 WHERE user_id = $1',
            [params.userId],
          );
          await tx.query(
            'UPDATE profiles SET follower_count = follower_count + 1 WHERE user_id = $1',
            [auth.userId],
          );
          return true;
        });
        if (!ok) throw notFound('Follow request');
        await notify(ctx, {
          userId: params.userId,
          kind: 'follow_accepted',
          actorId: auth.userId,
          targetType: 'user',
          targetId: auth.userId,
        });
        return { approved: true };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/follow-requests/:userId/deny',
      summary: 'Deny a follow request',
      tags: ['graph'],
      auth: 'user',
      params: userIdParams,
      handler: async ({ auth, params }) => {
        const r = await ctx.db.query(
          `DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2 AND status = 'pending'`,
          [params.userId, auth.userId],
        );
        if (!r.rowCount) throw notFound('Follow request');
      },
    });

    const listConnections =
      (kind: 'followers' | 'following') =>
      async ({
        auth,
        params,
        query,
      }: {
        auth: { userId: string } | null;
        params: { username: string };
        query: z.infer<typeof pageQuery>;
      }) => {
        const viewerId = auth?.userId ?? null;
        const target = await resolveUser(ctx, viewerId, params.username);
        if (target.isPrivate && viewerId !== target.id) {
          const ok = viewerId
            ? await ctx.db.query(
                `SELECT 1 FROM follows WHERE follower_id = $1 AND followee_id = $2 AND status = 'active'`,
                [viewerId, target.id],
              )
            : null;
          if (!ok?.rowCount) throw forbidden('This account is private');
        }
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<{ t: string; id: string }>(query.cursor);
        const [selfCol, otherCol] =
          kind === 'followers' ? ['followee_id', 'follower_id'] : ['follower_id', 'followee_id'];
        const { rows } = await ctx.db.query(
          `SELECT ${CARD_COLUMNS}, f.created_at FROM follows f JOIN profiles p ON p.user_id = f.${otherCol}
            WHERE f.${selfCol} = $1 AND f.status = 'active'
              AND ($2::timestamptz IS NULL OR (f.created_at, f.${otherCol}) < ($2::timestamptz, $3::uuid))
              AND ($4::uuid IS NULL OR NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = $4 AND b.blocked_id = f.${otherCol}) OR (b.blocker_id = f.${otherCol} AND b.blocked_id = $4)))
            ORDER BY f.created_at DESC, f.${otherCol} DESC LIMIT $5`,
          [target.id, cur?.t ?? null, cur?.id ?? null, viewerId, limit + 1],
        );
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          items: page.map(toCard),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ t: (last.created_at as Date).toISOString(), id: last.id as string })
              : null,
        };
      };

    route(app, ctx, {
      method: 'GET',
      url: '/v1/users/:username/followers',
      summary: 'List followers',
      tags: ['graph'],
      auth: 'optional',
      params: usernameParams,
      query: pageQuery,
      handler: (a) => listConnections('followers')(a),
    });
    route(app, ctx, {
      method: 'GET',
      url: '/v1/users/:username/following',
      summary: 'List accounts a user follows',
      tags: ['graph'],
      auth: 'optional',
      params: usernameParams,
      query: pageQuery,
      handler: (a) => listConnections('following')(a),
    });

    // ------------------------------------------------------------------ friends
    route(app, ctx, {
      method: 'POST',
      url: '/v1/friends/requests',
      summary: 'Send a friend request (auto-accepts a matching incoming request)',
      tags: ['graph'],
      auth: 'user',
      body: z.object({ username: z.string().min(1).max(40) }),
      rateLimit: { limit: 30, windowSec: 600, by: 'user' },
      handler: async ({ auth, body, reply }) => {
        const target = await resolveUser(ctx, auth.userId, body.username);
        if (target.id === auth.userId)
          throw new AppError('unprocessable', 'You cannot befriend yourself');
        const t = await ctx.db.query<{ age_band: string }>(
          'SELECT age_band FROM users WHERE id = $1',
          [target.id],
        );
        // Minor safety: adults cannot initiate friendships with under-18 accounts; the teen must initiate.
        if (auth.ageBand === 'adult' && t.rows[0]?.age_band === 'teen')
          throw forbidden('You cannot send this request');
        const [low, high] = sortPair(auth.userId, target.id);
        const outcome = await withTransaction(ctx.db, async (tx) => {
          const ex = await tx.query<{ status: string; requester_id: string }>(
            `SELECT status, requester_id FROM friendships WHERE user_low = $1 AND user_high = $2 FOR UPDATE`,
            [low, high],
          );
          const cur = ex.rows[0];
          if (cur?.status === 'accepted') throw conflict('You are already friends');
          if (cur && cur.requester_id === auth.userId)
            throw conflict('Friend request already sent');
          if (cur) {
            await tx.query(
              `UPDATE friendships SET status = 'accepted', accepted_at = now() WHERE user_low = $1 AND user_high = $2`,
              [low, high],
            );
            await tx.query(
              `UPDATE profiles SET friend_count = friend_count + 1 WHERE user_id = ANY($1::uuid[])`,
              [[low, high]],
            );
            return 'accepted' as const;
          }
          await tx.query(
            `INSERT INTO friendships (user_low, user_high, requester_id) VALUES ($1,$2,$3)`,
            [low, high, auth.userId],
          );
          return 'pending' as const;
        });
        await notify(ctx, {
          userId: target.id,
          kind: outcome === 'accepted' ? 'friend_accepted' : 'friend_request',
          actorId: auth.userId,
          targetType: 'user',
          targetId: auth.userId,
        });
        void reply.code(outcome === 'accepted' ? 200 : 201);
        return { status: outcome };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/friends/requests',
      summary: 'Pending friend requests',
      tags: ['graph'],
      auth: 'user',
      query: z.object({ direction: z.enum(['incoming', 'outgoing']).default('incoming') }),
      handler: async ({ auth, query }) => {
        const incoming = query.direction === 'incoming';
        const { rows } = await ctx.db.query(
          `SELECT ${CARD_COLUMNS}, f.created_at FROM friendships f
             JOIN profiles p ON p.user_id = CASE WHEN f.user_low = $1 THEN f.user_high ELSE f.user_low END
            WHERE (f.user_low = $1 OR f.user_high = $1) AND f.status = 'pending'
              AND (f.requester_id = $1) = $2
              AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = p.user_id) OR (b.blocker_id = p.user_id AND b.blocked_id = $1))
            ORDER BY f.created_at DESC LIMIT 100`,
          [auth.userId, !incoming],
        );
        return {
          items: rows.map((r) => ({
            ...toCard(r),
            requestedAt: (r.created_at as Date).toISOString(),
          })),
        };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/friends/requests/:userId/accept',
      summary: 'Accept a friend request',
      tags: ['graph'],
      auth: 'user',
      params: userIdParams,
      handler: async ({ auth, params }) => {
        const [low, high] = sortPair(auth.userId, params.userId);
        const ok = await withTransaction(ctx.db, async (tx) => {
          const r = await tx.query(
            `UPDATE friendships SET status = 'accepted', accepted_at = now() WHERE user_low = $1 AND user_high = $2 AND status = 'pending' AND requester_id <> $3`,
            [low, high, auth.userId],
          );
          if (!r.rowCount) return false;
          await tx.query(
            `UPDATE profiles SET friend_count = friend_count + 1 WHERE user_id = ANY($1::uuid[])`,
            [[low, high]],
          );
          return true;
        });
        if (!ok) throw notFound('Friend request');
        await notify(ctx, {
          userId: params.userId,
          kind: 'friend_accepted',
          actorId: auth.userId,
          targetType: 'user',
          targetId: auth.userId,
        });
        return { status: 'accepted' };
      },
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/friends/:userId',
      summary: 'Remove a friend / decline or cancel a request',
      tags: ['graph'],
      auth: 'user',
      params: userIdParams,
      handler: async ({ auth, params }) => {
        const removed = await withTransaction(ctx.db, (tx) =>
          removeFriendship(tx, auth.userId, params.userId),
        );
        if (!removed) throw notFound('Friendship');
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/friends',
      summary: 'Your friends',
      tags: ['graph'],
      auth: 'user',
      query: pageQuery,
      handler: async ({ auth, query }) => {
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<{ n: string; id: string }>(query.cursor);
        const { rows } = await ctx.db.query(
          `SELECT ${CARD_COLUMNS} FROM friendships f JOIN profiles p ON p.user_id = CASE WHEN f.user_low = $1 THEN f.user_high ELSE f.user_low END
            WHERE (f.user_low = $1 OR f.user_high = $1) AND f.status = 'accepted'
              AND ($2::text IS NULL OR (p.username::text, p.user_id) > ($2::text, $3::uuid))
            ORDER BY p.username::text, p.user_id LIMIT $4`,
          [auth.userId, cur?.n ?? null, cur?.id ?? null, limit + 1],
        );
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          items: page.map(toCard),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ n: last.username as string, id: last.id as string })
              : null,
        };
      },
    });

    // ------------------------------------------------------------------ circles
    route(app, ctx, {
      method: 'GET',
      url: '/v1/circles',
      summary: 'Your circles',
      tags: ['circles'],
      auth: 'user',
      handler: async ({ auth }) => {
        const { rows } = await ctx.db.query(
          `SELECT c.id, c.kind, c.name, (SELECT count(*)::int FROM circle_members m WHERE m.circle_id = c.id) AS member_count
             FROM circles c WHERE c.owner_id = $1 ORDER BY c.created_at`,
          [auth.userId],
        );
        return {
          items: rows.map((r) => ({
            id: r.id,
            kind: r.kind,
            name: r.name,
            memberCount: r.member_count,
          })),
        };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/circles',
      summary: 'Create a circle',
      tags: ['circles'],
      auth: 'user',
      body: circleBody,
      handler: async ({ auth, body, reply }) => {
        const { rows } = await ctx.db.query<{ id: string }>(
          `INSERT INTO circles (owner_id, kind, name) VALUES ($1,$2,$3) RETURNING id`,
          [auth.userId, body.kind, body.name],
        );
        void reply.code(201);
        return { id: rows[0]!.id, kind: body.kind, name: body.name, memberCount: 0 };
      },
    });

    route(app, ctx, {
      method: 'PATCH',
      url: '/v1/circles/:id',
      summary: 'Rename a circle',
      tags: ['circles'],
      auth: 'user',
      params: idParams,
      body: z.object({ name: z.string().trim().min(1).max(40) }),
      handler: async ({ auth, params, body }) => {
        const r = await ctx.db.query(
          'UPDATE circles SET name = $3 WHERE id = $1 AND owner_id = $2',
          [params.id, auth.userId, body.name],
        );
        if (!r.rowCount) throw notFound('Circle');
        return { updated: true };
      },
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/circles/:id',
      summary: 'Delete a circle',
      tags: ['circles'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, params }) => {
        const r = await ctx.db.query('DELETE FROM circles WHERE id = $1 AND owner_id = $2', [
          params.id,
          auth.userId,
        ]);
        if (!r.rowCount) throw notFound('Circle');
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/circles/:id/members',
      summary: 'Members of a circle',
      tags: ['circles'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, params }) => {
        const own = await ctx.db.query('SELECT 1 FROM circles WHERE id = $1 AND owner_id = $2', [
          params.id,
          auth.userId,
        ]);
        if (!own.rowCount) throw notFound('Circle');
        const { rows } = await ctx.db.query(
          `SELECT ${CARD_COLUMNS} FROM circle_members m JOIN profiles p ON p.user_id = m.user_id WHERE m.circle_id = $1 ORDER BY p.username::text`,
          [params.id],
        );
        return { items: rows.map(toCard) };
      },
    });

    route(app, ctx, {
      method: 'PUT',
      url: '/v1/circles/:id/members/:userId',
      summary: 'Add someone to a circle',
      tags: ['circles'],
      auth: 'user',
      params: circleMemberParams,
      handler: async ({ auth, params }) => {
        const own = await ctx.db.query('SELECT 1 FROM circles WHERE id = $1 AND owner_id = $2', [
          params.id,
          auth.userId,
        ]);
        if (!own.rowCount) throw notFound('Circle');
        if (params.userId === auth.userId)
          throw new AppError('unprocessable', 'You cannot add yourself');
        const exists = await ctx.db.query(
          `SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL AND status = 'active'`,
          [params.userId],
        );
        if (!exists.rowCount || (await isBlockedEitherWay(ctx.db, auth.userId, params.userId)))
          throw notFound('User');
        await ctx.db.query(
          'INSERT INTO circle_members (circle_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [params.id, params.userId],
        );
        return { added: true };
      },
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/circles/:id/members/:userId',
      summary: 'Remove someone from a circle',
      tags: ['circles'],
      auth: 'user',
      params: circleMemberParams,
      handler: async ({ auth, params }) => {
        const r = await ctx.db.query(
          `DELETE FROM circle_members m USING circles c WHERE c.id = m.circle_id AND c.owner_id = $2 AND m.circle_id = $1 AND m.user_id = $3`,
          [params.id, auth.userId, params.userId],
        );
        if (!r.rowCount) throw notFound('Circle member');
      },
    });

    // ------------------------------------------------------------------ block / mute / restrict
    route(app, ctx, {
      method: 'PUT',
      url: '/v1/users/:username/block',
      summary: 'Block a user',
      tags: ['safety'],
      auth: 'user',
      params: usernameParams,
      handler: async ({ auth, req, params }) => {
        const { rows } = await ctx.db.query<{ user_id: string }>(
          'SELECT p.user_id FROM profiles p JOIN users u ON u.id = p.user_id WHERE p.username = $1 AND u.deleted_at IS NULL',
          [params.username.toLowerCase()],
        );
        const targetId = rows[0]?.user_id;
        if (!targetId) throw notFound('User');
        if (targetId === auth.userId)
          throw new AppError('unprocessable', 'You cannot block yourself');
        await withTransaction(ctx.db, async (tx) => {
          await tx.query(
            'INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
            [auth.userId, targetId],
          );
          await removeFollow(tx, auth.userId, targetId);
          await removeFollow(tx, targetId, auth.userId);
          await removeFriendship(tx, auth.userId, targetId);
          await tx.query(
            `DELETE FROM circle_members m USING circles c WHERE c.id = m.circle_id AND ((c.owner_id = $1 AND m.user_id = $2) OR (c.owner_id = $2 AND m.user_id = $1))`,
            [auth.userId, targetId],
          );
        });
        await audit(
          ctx,
          { actorId: auth.userId, action: 'user.blocked', targetType: 'user', targetId },
          req,
        );
        return { blocked: true };
      },
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/users/:username/block',
      summary: 'Unblock a user',
      tags: ['safety'],
      auth: 'user',
      params: usernameParams,
      handler: async ({ auth, params }) => {
        await ctx.db.query(
          `DELETE FROM user_blocks b USING profiles p WHERE b.blocker_id = $1 AND p.user_id = b.blocked_id AND p.username = $2`,
          [auth.userId, params.username.toLowerCase()],
        );
      },
    });

    for (const [path, table, meCol, otherCol, label] of [
      ['mute', 'user_mutes', 'muter_id', 'muted_id', 'Mute'],
      ['restrict', 'user_restrictions', 'restrictor_id', 'restricted_id', 'Restrict'],
    ] as const) {
      route(app, ctx, {
        method: 'PUT',
        url: `/v1/users/:username/${path}`,
        summary: `${label} a user`,
        tags: ['safety'],
        auth: 'user',
        params: usernameParams,
        handler: async ({ auth, params }) => {
          const target = await resolveUser(ctx, auth.userId, params.username);
          if (target.id === auth.userId)
            throw new AppError('unprocessable', `You cannot ${path} yourself`);
          await ctx.db.query(
            `INSERT INTO ${table} (${meCol}, ${otherCol}) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
            [auth.userId, target.id],
          );
          return { [`${path}d`.replace('restrictd', 'restricted')]: true };
        },
      });
      route(app, ctx, {
        method: 'DELETE',
        url: `/v1/users/:username/${path}`,
        summary: `Undo ${path}`,
        tags: ['safety'],
        auth: 'user',
        params: usernameParams,
        handler: async ({ auth, params }) => {
          await ctx.db.query(
            `DELETE FROM ${table} t USING profiles p WHERE t.${meCol} = $1 AND p.user_id = t.${otherCol} AND p.username = $2`,
            [auth.userId, params.username.toLowerCase()],
          );
        },
      });
    }

    for (const [path, table, meCol, otherCol] of [
      ['blocks', 'user_blocks', 'blocker_id', 'blocked_id'],
      ['mutes', 'user_mutes', 'muter_id', 'muted_id'],
      ['restrictions', 'user_restrictions', 'restrictor_id', 'restricted_id'],
    ] as const) {
      route(app, ctx, {
        method: 'GET',
        url: `/v1/${path}`,
        summary: `Your ${path}`,
        tags: ['safety'],
        auth: 'user',
        handler: async ({ auth }) => {
          const { rows } = await ctx.db.query(
            `SELECT ${CARD_COLUMNS} FROM ${table} t JOIN profiles p ON p.user_id = t.${otherCol} WHERE t.${meCol} = $1 ORDER BY t.created_at DESC`,
            [auth.userId],
          );
          return { items: rows.map(toCard) };
        },
      });
    }
    void invalid;
  },
};
