import type { FastifyInstance } from 'fastify';
import { tx } from '@yapilapi/database';
import {
  commentSchema,
  createPostSchema,
  feedbackSchema,
  feedQuerySchema,
  pageQuerySchema,
  reactionSchema,
  usernameSchema,
  type Comment,
} from '@yapilapi/shared';
import { z } from 'zod';
import { AppError, badRequest, forbidden, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { decodeCursor, encodeCursor, keyCursorOf, type KeyCursor } from '../lib/cursor.ts';
import { analyzeText, statusForRisk } from '../lib/moderation.ts';
import { hydratePosts } from '../lib/posts.ts';
import { notifyMentions } from '../lib/mentions.ts';
import { topicsFor } from './tags.ts';
import { isPlus, PLUS_REEL_MAX_MS, REEL_MAX_MS } from '../lib/plus.ts';
import { notify, track } from '../lib/services.ts';
import { emitWebhook } from '../lib/webhooks.ts';
import { isAdultViewer, plusCol, publicUserFrom } from '../lib/users.ts';
import { notBlockedSql, postUnlockedSql, postVisibleSql } from '../lib/visibility.ts';
import { assertRemixable, assertSoundUsable, registerOwnSound } from '../lib/sounds.ts';
import { assertPostPace, assessPost, flagContent, recordSignals } from '../lib/spam.ts';
import { requireVerified } from '../lib/verification.ts';
import { MEDIA_BLOCKED_MESSAGE } from '../lib/media-moderation.ts';
import { me, requireAuth } from '../plugins/auth.ts';

const idParam = z.object({ id: z.string().uuid() });
const VISIBLE = postVisibleSql('$1');
const UNLOCKED = postUnlockedSql('$1');
/** For You scores posts from your connections plus this many of the newest other posts. */
const RECENT_CANDIDATES = 1000;
/** …and up to this many of the newest posts on the viewer's interests. */
const INTEREST_CANDIDATES = 300;
const POST_FROM = `FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id`;

export default async function postsModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;

  async function assertVisible(postId: string, viewer: string | null) {
    const r = await db.query(`SELECT 1 ${POST_FROM} WHERE p.id = $2 AND ${VISIBLE}`, [viewer, postId]);
    if (!r.rowCount) throw notFound('That post');
  }

  /** Visible and open to this viewer: subscriber-only posts need a current subscription (or to be the author). */
  async function assertUnlocked(postId: string, viewer: string | null) {
    const r = await db.query(`SELECT coalesce(${UNLOCKED}, false) AS unlocked ${POST_FROM} WHERE p.id = $2 AND ${VISIBLE}`, [viewer, postId]);
    if (!r.rows[0]) throw notFound('That post');
    if (!r.rows[0].unlocked) throw new AppError(403, 'subscribers_only', 'This post is for subscribers. Subscribe to see it.');
  }

  // ── Create ────────────────────────────────────────────────────────────
  /**
   * Reels: short vertical videos in a full-screen feed. Ranked like For You
   * (people you're close to, your interests, engagement, freshness) but only
   * reels, with a stable window so paging never repeats or skips.
   */
  app.get('/v1/reels', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const q = parse(z.object({ cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(20).default(8) }), req.query);
    const c = decodeCursor<{ asOf: string; o: number }>(q.cursor) ?? {
      asOf: ((await db.query<{ t: Date }>(`SELECT now() AS t`)).rows[0]!.t as Date).toISOString(),
      o: 0,
    };
    const { rows } = await db.query(
      `SELECT p.id ${POST_FROM}
       WHERE p.format = 'reel' AND ${VISIBLE} AND p.moderation_status = 'normal' AND p.created_at <= $2::timestamptz
         AND ($5 OR NOT EXISTS (SELECT 1 FROM post_media pm JOIN media m ON m.id = pm.media_id WHERE pm.post_id = p.id AND m.moderation = 'sensitive'))
       ORDER BY (
           CASE WHEN EXISTS (SELECT 1 FROM friendships fr WHERE (fr.user_a = $1 AND fr.user_b = p.author_id) OR (fr.user_b = $1 AND fr.user_a = p.author_id)) THEN 3 ELSE 0 END
         + CASE WHEN EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followee_id = p.author_id) THEN 2 ELSE 0 END
         + (SELECT count(*) FROM unnest(p.topics) t WHERE t IN (SELECT tp.slug FROM user_interests ui JOIN topics tp ON tp.id = ui.topic_id WHERE ui.user_id = $1)) * 1.2
         + ln(1 + p.like_count + 2 * p.comment_count) * 0.6
         + 4.0 * exp(-extract(epoch FROM ($2::timestamptz - p.created_at)) / 86400.0)
       ) DESC, p.created_at DESC, p.id DESC
       LIMIT $3 OFFSET $4`,
      // A reel is its video: people under 18 don't get reels whose video is marked sensitive.
      [u.id, c.asOf, q.limit + 1, c.o, await isAdultViewer(db, u.id)],
    );
    const page = rows.slice(0, q.limit);
    const items = await hydratePosts(
      db,
      page.map((r) => r.id),
      u.id,
    );
    // Each author's follower count, and whether you follow them, for the follow button on the reel.
    const stats = await db.query(
      `SELECT pr.user_id, (SELECT count(*) FROM follows f WHERE f.followee_id = pr.user_id)::int AS followers,
              EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $2 AND f.followee_id = pr.user_id) AS following
       FROM profiles pr WHERE pr.user_id = ANY($1)`,
      [[...new Set(items.map((p) => p.author.id))], u.id],
    );
    return {
      items,
      authors: Object.fromEntries(stats.rows.map((r) => [r.user_id, { followers: r.followers, following: r.following }])),
      nextCursor: rows.length > q.limit ? encodeCursor({ asOf: c.asOf, o: c.o + q.limit }) : null,
    };
  });

  app.post('/v1/posts', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = me(req);
    const input = parse(createPostSchema, req.body);
    const analysis = analyzeText(`${input.body} ${input.poll?.options.join(' ') ?? ''}`);
    if (analysis.risk === 'escalate')
      throw new AppError(
        422,
        'content_blocked',
        "This post can't be published because it may put someone at risk. If you or someone else is in danger, contact local emergency services.",
      );
    // Reaching everyone needs a confirmed email or phone (when REQUIRE_VERIFICATION is on).
    const reachesEveryone = input.visibility === 'public' || !!input.communityId;
    if (reachesEveryone) await requireVerified(db, ctx.config, u.id, 'post');
    await assertPostPace(db, ctx.config, u.id);
    const spam = await assessPost(db, ctx.config, u.id, input.body);
    const heldForAccount = spam.risky && reachesEveryone;
    const status = spam.restricted
      ? 'restricted'
      : analysis.risk !== 'normal'
        ? statusForRisk(analysis.risk)
        : spam.flags.length || heldForAccount
          ? 'review'
          : 'normal';
    let limitedNow = false;

    const kind = input.poll
      ? 'poll'
      : input.media.length > 1
        ? 'carousel'
        : input.media[0]?.kind === 'video'
          ? 'video'
          : input.media[0]?.kind === 'audio'
            ? 'audio'
            : input.media[0]
              ? 'photo'
              : input.linkUrl
                ? 'link'
                : input.kind;

    if (input.visibility === 'subscribers') {
      if (input.communityId) throw badRequest('Posts in a community are for its members, not for subscribers.');
      const plan = await db.query(`SELECT 1 FROM creator_plans WHERE creator_id = $1 AND active LIMIT 1`, [u.id]);
      if (!plan.rowCount) throw badRequest('Add a subscription plan in Studio before posting for subscribers.');
    }

    let remixAuthor = null as string | null;
    const postId = await tx(db, async (c) => {
      // Reels: a duet or remix borrows the original's sound; otherwise a chosen sound, or the reel's own audio.
      let soundId: string | null = null;
      if (input.format === 'reel' && input.remixOf) {
        const o = await assertRemixable(c, input.remixOf, u.id);
        remixAuthor = o.authorId;
        soundId = o.soundId;
      } else if (input.format === 'reel' && input.soundId) {
        await assertSoundUsable(c, input.soundId, u.id);
        soundId = input.soundId;
      }
      if (input.communityId) {
        const m = await c.query(`SELECT role FROM community_members WHERE community_id = $1 AND user_id = $2 AND status = 'active'`, [input.communityId, u.id]);
        if (!m.rows[0] || m.rows[0].role === 'guest') throw forbidden('Join the community to post in it.');
      }
      if (input.circleId) {
        const owns = await c.query(`SELECT 1 FROM circles WHERE id = $1 AND owner_id = $2`, [input.circleId, u.id]);
        if (!owns.rowCount) throw notFound('Circle');
      }
      if (input.productId) {
        const own = await c.query(`SELECT 1 FROM products WHERE id = $1 AND seller_id = $2 AND deleted_at IS NULL`, [input.productId, u.id]);
        if (!own.rowCount) throw forbidden('You can only link products you sell.');
      }
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO posts (author_id, kind, body, visibility, circle_id, community_id, event_id, product_id, link_url, topics, moderation_status, ai_provenance, rights, format,
                            allow_remix, remix_of_post_id, remix_mode, sound_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
        [
          u.id,
          kind,
          input.body,
          input.communityId ? 'public' : input.visibility,
          input.circleId ?? null,
          input.communityId ?? null,
          input.eventId ?? null,
          input.productId ?? null,
          input.linkUrl ?? null,
          topicsFor(input.topics, input.body),
          status,
          input.aiAssisted ? { assisted: true, at: new Date().toISOString() } : {},
          { owner: u.id, license: 'all_rights_reserved' },
          input.format,
          input.allowRemix,
          input.format === 'reel' ? (input.remixOf ?? null) : null,
          input.format === 'reel' && input.remixOf ? input.remixMode : null,
          soundId,
        ],
      );
      const id = rows[0]!.id;
      for (const [i, m] of input.media.entries()) {
        let mediaId = m.id;
        if (mediaId) {
          // Reuse the uploaded item (only your own), updating its alt text.
          const own = await c.query(`UPDATE media SET alt_text = coalesce($3, alt_text) WHERE id = $1 AND owner_id = $2 RETURNING id, moderation`, [
            mediaId,
            u.id,
            m.altText ?? null,
          ]);
          if (!own.rowCount) throw notFound('One of the photos or videos');
          if (own.rows[0].moderation === 'blocked') throw new AppError(422, 'media_blocked', MEDIA_BLOCKED_MESSAGE);
        } else {
          const media = await c.query<{ id: string }>(
            `INSERT INTO media (owner_id, kind, url, alt_text, width, height) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
            [u.id, m.kind, m.url, m.altText ?? null, m.width ?? null, m.height ?? null],
          );
          mediaId = media.rows[0]!.id;
        }
        await c.query(`INSERT INTO post_media (post_id, media_id, position) VALUES ($1,$2,$3)`, [id, mediaId, i]);
        if (input.format === 'reel') {
          // Reels are short. Uploads still processing have no length yet; those are checked by the player, not refused here.
          const len = (await c.query(`SELECT duration_ms FROM media WHERE id = $1`, [mediaId])).rows[0]?.duration_ms;
          if (len && len > REEL_MAX_MS) {
            // Plus members can post reels up to 10 minutes.
            const plus = await isPlus(c, u.id);
            if (!plus) throw new AppError(400, 'validation_failed', 'Reels can be up to 3 minutes, or 10 minutes with YAPILAPI Plus. Trim it in Studio first.');
            if (len > PLUS_REEL_MAX_MS) throw new AppError(400, 'validation_failed', 'Reels can be up to 10 minutes. Trim it in Studio first.');
          }
        }
      }
      if (input.format === 'reel' && !soundId) {
        const mediaId = (await c.query(`SELECT media_id FROM post_media WHERE post_id = $1 ORDER BY position LIMIT 1`, [id])).rows[0]?.media_id;
        if (mediaId) await registerOwnSound(c, { postId: id, ownerId: u.id, mediaId, title: input.soundTitle });
      }
      if (input.poll)
        for (const [i, label] of input.poll.options.entries())
          await c.query(`INSERT INTO poll_options (post_id, label, position) VALUES ($1,$2,$3)`, [id, label, i]);
      if (input.visibility === 'selected' && input.audience)
        await c.query(`INSERT INTO post_audience (post_id, user_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING`, [id, input.audience]);
      // Flagged posts go to a moderator with the signals that flagged them.
      if (analysis.risk !== 'normal' || spam.flags.length || heldForAccount)
        await c.query(
          `INSERT INTO moderation_cases (target_type, target_id, subject_user_id, source, risk, signals) VALUES ('post', $1, $2, 'automated', $3, $4)`,
          [
            id,
            u.id,
            analysis.risk !== 'normal' ? analysis.risk : 'review',
            {
              signals: [...analysis.signals, ...spam.flags.map((f) => f.kind), ...(heldForAccount ? ['risky_account'] : [])],
              ...(spam.flags.length ? { spam: spam.flags } : {}),
            },
          ],
        );
      limitedNow = await flagContent(c, ctx.realtime, u.id, { type: 'post', id }, spam.flags);
      // Posts from a limited account wait with the account's review; clearing it publishes them.
      if (spam.restricted) await recordSignals(c, u.id, [{ kind: 'held_while_limited', weight: 0 }], { type: 'post', id });
      return id;
    });
    track(db, u.id, 'post_created', { kind, visibility: input.visibility, community: !!input.communityId });
    await emitWebhook(db, u.id, 'post.created', { postId, kind, visibility: input.visibility });
    if (status === 'normal') await notifyMentions(db, ctx.realtime, { text: input.body, actorId: u.id, postId });
    // Tell the original's creator about a duet or remix, when they can see it.
    if (remixAuthor && status === 'normal') {
      const seen = await db.query(`SELECT 1 ${POST_FROM} WHERE p.id = $2 AND ${VISIBLE}`, [remixAuthor, postId]);
      if (seen.rowCount)
        await notify(db, ctx.realtime, {
          userId: remixAuthor,
          category: 'creators',
          type: input.remixMode === 'duet' ? 'reel_duet' : 'reel_remix',
          actorId: u.id,
          entityType: 'post',
          entityId: postId,
          data: { originalId: input.remixOf },
        });
      track(db, u.id, 'reel_remixed', { mode: input.remixMode });
    }
    reply.code(201);
    const [post] = await hydratePosts(db, [postId], u.id);
    return {
      post,
      moderation:
        status === 'normal'
          ? undefined
          : spam.restricted || limitedNow
            ? {
                status,
                message: 'Your account is limited while our team reviews some recent activity, so new posts are visible only to you for now.',
              }
            : { status, message: 'Your post is published to you only until it has been reviewed.' },
    };
  });

  app.get('/v1/posts/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    await assertVisible(id, req.user?.id ?? null);
    const [post] = await hydratePosts(db, [id], req.user?.id ?? null);
    return { post };
  });

  app.delete('/v1/posts/:id', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const r = await db.query(`UPDATE posts SET deleted_at = now() WHERE id = $1 AND author_id = $2 AND deleted_at IS NULL`, [id, u.id]);
    if (!r.rowCount) throw notFound('That post');
    return { ok: true };
  });

  /** A person's posts, newest first, with their pinned post (if you can see it) at the top of the first page. */
  app.get('/v1/users/:username/posts', async (req) => {
    const { username } = parse(z.object({ username: usernameSchema }), req.params);
    const q = parse(pageQuerySchema, req.query);
    const c = decodeCursor<KeyCursor>(q.cursor);
    const viewer = req.user?.id ?? null;
    const pinned = c
      ? null
      : (await db.query(`SELECT p.id ${POST_FROM} WHERE lower(ap.username) = lower($2) AND p.id = ap.pinned_post_id AND ${VISIBLE}`, [viewer, username]))
          .rows[0]?.id;
    const { rows } = await db.query(
      `SELECT p.id, p.created_at ${POST_FROM}
       WHERE lower(ap.username) = lower($2) AND p.community_id IS NULL AND ${VISIBLE} AND p.id IS DISTINCT FROM ap.pinned_post_id
         ${c ? 'AND (p.created_at, p.id) < ($4::timestamptz, $5::uuid)' : ''}
       ORDER BY p.created_at DESC, p.id DESC LIMIT $3`,
      c ? [req.user?.id ?? null, username, q.limit + 1, c.t, c.id] : [req.user?.id ?? null, username, q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    const items = await hydratePosts(db, pinned ? [pinned, ...page.map((r) => r.id)] : page.map((r) => r.id), viewer);
    const top = items[0];
    if (pinned && top && top.id === pinned) top.pinned = true;
    return { items, nextCursor: rows.length > q.limit ? keyCursorOf(page.at(-1)!) : null };
  });

  /** Pin one of your own posts to the top of your profile, or unpin with null. */
  app.put('/v1/me/pinned-post', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { postId } = parse(z.object({ postId: z.string().uuid().nullable() }), req.body);
    if (postId) {
      const own = await db.query(`SELECT 1 FROM posts WHERE id = $1 AND author_id = $2 AND deleted_at IS NULL AND community_id IS NULL`, [postId, u.id]);
      if (!own.rowCount) throw notFound('That post');
    }
    await db.query(`UPDATE profiles SET pinned_post_id = $2 WHERE user_id = $1`, [u.id, postId]);
    return { pinnedPostId: postId };
  });

  /** Someone watched a reel or opened a post: counted once per person, never for the author. */
  app.post('/v1/posts/:id/view', { preHandler: requireAuth, config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    await assertVisible(id, u.id);
    const r = await db.query(
      `WITH ins AS (INSERT INTO post_views (post_id, viewer_id) SELECT $1, $2 FROM posts WHERE id = $1 AND author_id <> $2 ON CONFLICT DO NOTHING RETURNING 1)
       UPDATE posts SET view_count = view_count + (SELECT count(*) FROM ins) WHERE id = $1 RETURNING view_count`,
      [id, u.id],
    );
    return { views: r.rows[0]?.view_count ?? 0 };
  });

  // ── Remixes ───────────────────────────────────────────────────────────
  /** Turn duets and remixes of your reel on or off. Existing ones stay up. */
  app.put('/v1/posts/:id/remix-settings', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { allowRemix } = parse(z.object({ allowRemix: z.boolean() }), req.body);
    const r = await db.query(`UPDATE posts SET allow_remix = $3 WHERE id = $1 AND author_id = $2 AND format = 'reel' AND deleted_at IS NULL`, [
      id,
      u.id,
      allowRemix,
    ]);
    if (!r.rowCount) throw notFound('That reel');
    return { allowRemix };
  });

  /** Duets and remixes of a reel that you can see, newest first. `mode` narrows to one kind. */
  app.get('/v1/posts/:id/remixes', async (req) => {
    const { id } = parse(idParam, req.params);
    const q = parse(
      z.object({
        mode: z.enum(['duet', 'remix']).optional(),
        cursor: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      }),
      req.query,
    );
    const viewer = req.user?.id ?? null;
    await assertVisible(id, viewer);
    const c = decodeCursor<KeyCursor>(q.cursor);
    const params: unknown[] = [viewer, id, q.limit + 1, q.mode ?? null];
    if (c) params.push(c.t, c.id);
    const { rows } = await db.query(
      `SELECT p.id, p.created_at ${POST_FROM}
       WHERE p.remix_of_post_id = $2 AND p.format = 'reel' AND ($4::text IS NULL OR p.remix_mode = $4) AND ${VISIBLE}
       ${c ? 'AND (p.created_at, p.id) < ($5::timestamptz, $6::uuid)' : ''}
       ORDER BY p.created_at DESC, p.id DESC LIMIT $3`,
      params,
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

  // ── Feed ──────────────────────────────────────────────────────────────
  app.get('/v1/feed', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const q = parse(feedQuerySchema, req.query);
    const prefs = (await db.query(`SELECT friends_only, reduced_recommendations FROM user_preferences WHERE user_id = $1`, [u.id])).rows[0] ?? {};
    const mode = prefs.friends_only && q.mode === 'for_you' ? 'friends' : q.mode;

    // Personal filters apply to every mode: muted people, "not interested", muted topics.
    const personal = `
      AND NOT EXISTS (SELECT 1 FROM mutes m WHERE m.muter_id = $1 AND m.muted_id = p.author_id)
      AND NOT EXISTS (SELECT 1 FROM feed_feedback ff WHERE ff.user_id = $1 AND (
            (ff.signal = 'not_interested' AND ff.post_id = p.id)
         OR (ff.signal = 'mute_creator' AND ff.author_id = p.author_id)
         OR (ff.signal = 'mute_topic' AND ff.topic = ANY(p.topics))))`;

    if (mode === 'for_you') return rankedFeed(u.id, q.cursor, q.limit, personal, !!prefs.reduced_recommendations);

    const scope: Record<string, string> = {
      following: `(p.author_id = $1 OR EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followee_id = p.author_id)) AND p.community_id IS NULL`,
      friends: `EXISTS (SELECT 1 FROM friendships fr WHERE (fr.user_a = $1 AND fr.user_b = p.author_id) OR (fr.user_b = $1 AND fr.user_a = p.author_id)) AND p.community_id IS NULL`,
      communities: `EXISTS (SELECT 1 FROM community_members cm WHERE cm.community_id = p.community_id AND cm.user_id = $1 AND cm.status = 'active')`,
      local: `p.event_id IS NOT NULL AND EXISTS (SELECT 1 FROM events e JOIN places pl ON pl.id = e.place_id WHERE e.id = p.event_id AND pl.city IS NOT NULL
               AND pl.city = (SELECT pl2.city FROM event_attendees ea JOIN events e2 ON e2.id = ea.event_id JOIN places pl2 ON pl2.id = e2.place_id
                              WHERE ea.user_id = $1 ORDER BY ea.updated_at DESC LIMIT 1))`,
    };
    const c = decodeCursor<KeyCursor>(q.cursor);
    if (mode === 'following') {
      // Posts by people you follow, and posts they reposted (placed at the time of the repost, newest per post).
      const { rows } = await db.query(
        `WITH items AS (
           SELECT p.id, p.created_at AS at, NULL::uuid AS by FROM posts p
           WHERE (p.author_id = $1 OR EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followee_id = p.author_id)) AND p.community_id IS NULL
           UNION ALL
           SELECT r.post_id, r.created_at, r.user_id FROM post_reposts r
           WHERE EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followee_id = r.user_id)
         ), latest AS (
           SELECT DISTINCT ON (id) id, at, by FROM items ORDER BY id, at DESC
         )
         SELECT p.id, l.at AS created_at, l.by, rp.display_name AS by_name ${POST_FROM}
         JOIN latest l ON l.id = p.id LEFT JOIN profiles rp ON rp.user_id = l.by
         WHERE ${VISIBLE} ${personal} ${c ? 'AND (l.at, p.id) < ($3::timestamptz, $4::uuid)' : ''}
         ORDER BY l.at DESC, p.id DESC LIMIT $2`,
        c ? [u.id, q.limit + 1, c.t, c.id] : [u.id, q.limit + 1],
      );
      const page = rows.slice(0, q.limit);
      const reasons = new Map<string, string>(page.filter((r) => r.by).map((r) => [r.id as string, `${r.by_name} reposted`]));
      return {
        mode,
        items: await hydratePosts(
          db,
          page.map((r) => r.id),
          u.id,
          reasons,
        ),
        nextCursor: rows.length > q.limit ? keyCursorOf(page.at(-1)!) : null,
      };
    }
    const { rows } = await db.query(
      `SELECT p.id, p.created_at ${POST_FROM} WHERE ${scope[mode]} AND ${VISIBLE} ${personal}
       ${c ? 'AND (p.created_at, p.id) < ($3::timestamptz, $4::uuid)' : ''}
       ORDER BY p.created_at DESC, p.id DESC LIMIT $2`,
      c ? [u.id, q.limit + 1, c.t, c.id] : [u.id, q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    return {
      mode,
      items: await hydratePosts(
        db,
        page.map((r) => r.id),
        u.id,
      ),
      nextCursor: rows.length > q.limit ? keyCursorOf(page.at(-1)!) : null,
    };
  });

  /**
   * For You ranking. Score = affinity + interest match + engagement + freshness
   * − negative feedback. The candidate window is fixed at the first page (asOf)
   * so pagination is stable. Diversity: at most 2 posts per author per page.
   * Not optimized for time spent: no autoplay loops, a clear end of feed.
   */
  async function rankedFeed(userId: string, cursor: string | undefined, limit: number, personal: string, reduced: boolean) {
    // The window starts at the database's clock, not this process's: a post written a moment ago must be inside it
    // even when the two clocks drift (common with containers after the host sleeps).
    const c = decodeCursor<{ asOf: string; o: number }>(cursor) ?? {
      asOf: ((await db.query<{ t: Date }>(`SELECT now() AS t`)).rows[0]!.t as Date).toISOString(),
      o: 0,
    };
    const connectionOnly = reduced
      ? `AND (p.author_id = $1 OR p.author_id IN (SELECT id FROM followed)
              OR EXISTS (SELECT 1 FROM community_members cm WHERE cm.community_id = p.community_id AND cm.user_id = $1))`
      : '';
    // Candidates: everything in the window from you, people you follow, friends and your
    // communities, plus the newest RECENT_CANDIDATES other posts. Scoring every post of the
    // last 14 days made this query grow with the whole platform (docs/architecture/performance.md).
    // The viewer's follows, friends and topic lists are built once (hashed sets and arrays)
    // instead of being looked up with correlated subqueries for each post.
    const { rows } = await db.query(
      `WITH me AS (
         SELECT coalesce((SELECT array_agg(t.slug) FROM user_interests ui JOIN topics t ON t.id = ui.topic_id WHERE ui.user_id = $1), '{}') AS interests,
                coalesce((SELECT array_agg(DISTINCT x) FROM feed_feedback ff JOIN posts p2 ON p2.id = ff.post_id, unnest(p2.topics) x
                          WHERE ff.user_id = $1 AND ff.signal = 'more_like_this'), '{}') AS more,
                coalesce((SELECT array_agg(DISTINCT x) FROM feed_feedback ff JOIN posts p2 ON p2.id = ff.post_id, unnest(p2.topics) x
                          WHERE ff.user_id = $1 AND ff.signal = 'less_like_this'), '{}') AS less
       ),
       followed AS (SELECT followee_id AS id FROM follows WHERE follower_id = $1),
       friends AS (SELECT user_b AS id FROM friendships WHERE user_a = $1 UNION ALL SELECT user_a FROM friendships WHERE user_b = $1),
       candidates AS (
         SELECT p.id FROM (SELECT $1::uuid AS id UNION SELECT id FROM followed UNION SELECT id FROM friends) a
         JOIN posts p ON p.author_id = a.id
         WHERE p.deleted_at IS NULL AND p.created_at <= $2::timestamptz AND p.created_at > $2::timestamptz - interval '14 days'
         UNION
         SELECT p.id FROM community_members cm JOIN posts p ON p.community_id = cm.community_id
         WHERE cm.user_id = $1 AND cm.status = 'active'
           AND p.deleted_at IS NULL AND p.created_at <= $2::timestamptz AND p.created_at > $2::timestamptz - interval '14 days'
         UNION
         (SELECT id FROM posts
          WHERE deleted_at IS NULL AND created_at <= $2::timestamptz AND created_at > $2::timestamptz - interval '14 days'
          ORDER BY created_at DESC, id DESC LIMIT ${RECENT_CANDIDATES})
         UNION
         -- Posts about your interests, even when they're older than the newest window: someone who
         -- just picked interests in onboarding sees them in For you straight away (topics GIN index).
         (SELECT p.id FROM posts p CROSS JOIN me
          WHERE cardinality(me.interests) > 0 AND p.topics && me.interests
            AND p.deleted_at IS NULL AND p.created_at <= $2::timestamptz AND p.created_at > $2::timestamptz - interval '14 days'
          ORDER BY p.created_at DESC, p.id DESC LIMIT ${INTEREST_CANDIDATES})
       ),
       scored AS (
         SELECT p.id, p.author_id, p.created_at, p.topics, ap.display_name, cm_c.name AS community_name, (cm_self.user_id IS NOT NULL) AS member,
                p.author_id IN (SELECT id FROM followed) AS followed,
                p.author_id IN (SELECT id FROM friends) AS friend,
                (SELECT 1.2 * count(*) FILTER (WHERE t = ANY(me.interests)) + 1.0 * count(*) FILTER (WHERE t = ANY(me.more))
                        - 2.0 * count(*) FILTER (WHERE t = ANY(me.less)) FROM unnest(p.topics) t)
                + ln(1 + p.like_count + 2 * p.comment_count) * 0.6
                + 4.0 * exp(-extract(epoch FROM ($2::timestamptz - p.created_at)) / 86400.0) AS base
         ${POST_FROM}
         CROSS JOIN me
         LEFT JOIN communities cm_c ON cm_c.id = p.community_id
         LEFT JOIN community_members cm_self ON cm_self.community_id = p.community_id AND cm_self.user_id = $1 AND cm_self.status = 'active'
         WHERE p.id IN (SELECT id FROM candidates) AND ${VISIBLE} ${personal} ${connectionOnly}
           AND (p.community_id IS NULL OR cm_self.user_id IS NOT NULL OR cm_c.visibility = 'public')
       )
       SELECT s.id, s.author_id, s.display_name, s.community_name, s.member, s.followed, s.friend,
              (SELECT t FROM unnest(s.topics) t WHERE t = ANY(me.interests) LIMIT 1) AS matched_topic,
              s.base
                + CASE WHEN s.author_id = $1 THEN 1 ELSE 0 END
                + CASE WHEN s.friend THEN 3 ELSE 0 END
                + CASE WHEN s.followed THEN 2 ELSE 0 END
                + CASE WHEN s.member THEN 1.5 ELSE 0 END AS score
       FROM scored s CROSS JOIN me
       ORDER BY score DESC, s.created_at DESC, s.id DESC
       LIMIT $3 OFFSET $4`,
      [userId, c.asOf, limit * 2 + 1, c.o],
    );
    // Diversity pass: cap posts per author on this page.
    const perAuthor = new Map<string, number>();
    const picked: typeof rows = [];
    let consumed = 0;
    for (const r of rows) {
      if (picked.length >= limit) break;
      consumed++;
      const n = perAuthor.get(r.author_id) ?? 0;
      if (n >= 2) continue;
      perAuthor.set(r.author_id, n + 1);
      picked.push(r);
    }
    const reasons = new Map<string, string>();
    for (const r of picked)
      reasons.set(
        r.id,
        r.author_id === userId
          ? 'Your post'
          : r.friend
            ? `You're friends with ${r.display_name}`
            : r.followed
              ? `You follow ${r.display_name}`
              : r.community_name && r.member
                ? `From ${r.community_name}, a community you're in`
                : r.matched_topic
                  ? `You're interested in ${r.matched_topic}`
                  : r.community_name
                    ? `Popular in ${r.community_name}`
                    : 'Popular with people on YAPILAPI right now',
      );
    const more = rows.length > consumed;
    return {
      mode: 'for_you',
      items: await hydratePosts(
        db,
        picked.map((r) => r.id),
        userId,
        reasons,
      ),
      nextCursor: more ? encodeCursor({ asOf: c.asOf, o: c.o + consumed }) : null,
    };
  }

  app.post('/v1/feed/feedback', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const input = parse(feedbackSchema, req.body);
    let authorId = input.authorId ?? null;
    if (input.postId) {
      await assertVisible(input.postId, u.id);
      if (input.signal === 'mute_creator' && !authorId)
        authorId = (await db.query(`SELECT author_id FROM posts WHERE id = $1`, [input.postId])).rows[0]?.author_id ?? null;
    }
    if (input.signal === 'mute_topic' && !input.topic) throw badRequest('Choose a topic to mute.');
    await db.query(`INSERT INTO feed_feedback (user_id, signal, post_id, author_id, topic) VALUES ($1,$2,$3,$4,$5)`, [
      u.id,
      input.signal,
      input.postId ?? null,
      authorId,
      input.topic ?? null,
    ]);
    return { ok: true };
  });

  app.get('/v1/posts/:id/why', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    await assertVisible(id, u.id);
    const { rows } = await db.query(
      `SELECT pr.display_name, p.topics, p.like_count, p.comment_count, c.name AS community,
        EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followee_id = p.author_id) AS followed,
        EXISTS (SELECT 1 FROM friendships fr WHERE (fr.user_a = $1 AND fr.user_b = p.author_id) OR (fr.user_b = $1 AND fr.user_a = p.author_id)) AS friend,
        ARRAY(SELECT t FROM unnest(p.topics) t WHERE ${UNLOCKED} AND t IN (SELECT tp.slug FROM user_interests ui JOIN topics tp ON tp.id = ui.topic_id WHERE ui.user_id = $1)) AS matched,
        EXISTS (SELECT 1 FROM community_members cm WHERE cm.community_id = p.community_id AND cm.user_id = $1) AS member
       FROM posts p JOIN profiles pr ON pr.user_id = p.author_id LEFT JOIN communities c ON c.id = p.community_id WHERE p.id = $2`,
      [u.id, id],
    );
    const r = rows[0];
    const reasons: string[] = [];
    if (r.friend) reasons.push(`You're friends with ${r.display_name}.`);
    else if (r.followed) reasons.push(`You follow ${r.display_name}.`);
    if (r.member) reasons.push(`This is from ${r.community}, a community you joined.`);
    if (r.matched.length) reasons.push(`You follow the topic${r.matched.length > 1 ? 's' : ''} ${r.matched.join(', ')}.`);
    if (r.like_count + r.comment_count > 5) reasons.push('People are engaging with it.');
    if (!reasons.length) reasons.push("It's recent and public, and we're still learning what you like.");
    return { reasons, controls: ['more_like_this', 'less_like_this', 'not_interested', 'mute_topic', 'mute_creator'] };
  });

  // ── Reactions, saves, polls ───────────────────────────────────────────
  app.put('/v1/posts/:id/reaction', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { kind } = parse(reactionSchema, req.body ?? {});
    await assertVisible(id, u.id);
    const inserted = await tx(db, async (c) => {
      const r = await c.query(
        `INSERT INTO reactions (post_id, user_id, kind) VALUES ($1,$2,$3) ON CONFLICT (post_id, user_id) DO UPDATE SET kind = EXCLUDED.kind RETURNING (xmax = 0) AS inserted`,
        [id, u.id, kind],
      );
      const isNew = r.rows[0].inserted as boolean;
      if (isNew) await c.query(`UPDATE posts SET like_count = like_count + 1 WHERE id = $1`, [id]);
      return isNew;
    });
    if (inserted) {
      const author = (await db.query(`SELECT author_id FROM posts WHERE id = $1`, [id])).rows[0].author_id;
      await notify(db, ctx.realtime, {
        userId: author,
        category: 'creators',
        type: 'post_reaction',
        actorId: u.id,
        entityType: 'post',
        entityId: id,
        data: { kind },
      });
      track(db, u.id, 'post_reacted');
    }
    const likes = (await db.query(`SELECT like_count FROM posts WHERE id = $1`, [id])).rows[0].like_count;
    return { liked: true, likes };
  });

  app.delete('/v1/posts/:id/reaction', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    await tx(db, async (c) => {
      const r = await c.query(`DELETE FROM reactions WHERE post_id = $1 AND user_id = $2`, [id, u.id]);
      if (r.rowCount) await c.query(`UPDATE posts SET like_count = greatest(like_count - 1, 0) WHERE id = $1`, [id]);
    });
    const likes = (await db.query(`SELECT like_count FROM posts WHERE id = $1`, [id])).rows[0]?.like_count ?? 0;
    return { liked: false, likes };
  });

  /**
   * Repost: share someone else's public post or reel with your followers. It
   * shows in their Following feed as "<you> reposted", at the time you reposted.
   * Only public posts can be reposted, so a repost never widens who can see it.
   */
  app.put('/v1/posts/:id/repost', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    await assertVisible(id, u.id);
    const p = (await db.query(`SELECT author_id, visibility, community_id FROM posts WHERE id = $1`, [id])).rows[0];
    if (p.author_id === u.id) throw badRequest("You can't repost your own post.");
    if (p.visibility !== 'public') throw badRequest('Only public posts can be reposted.');
    const inserted = await tx(db, async (c) => {
      const r = await c.query(`INSERT INTO post_reposts (user_id, post_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [u.id, id]);
      if (r.rowCount) await c.query(`UPDATE posts SET repost_count = repost_count + 1 WHERE id = $1`, [id]);
      return !!r.rowCount;
    });
    if (inserted) {
      await notify(db, ctx.realtime, { userId: p.author_id, category: 'creators', type: 'post_repost', actorId: u.id, entityType: 'post', entityId: id });
      track(db, u.id, 'post_reposted');
    }
    const reposts = (await db.query(`SELECT repost_count FROM posts WHERE id = $1`, [id])).rows[0].repost_count;
    return { reposted: true, reposts };
  });

  app.delete('/v1/posts/:id/repost', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    await tx(db, async (c) => {
      const r = await c.query(`DELETE FROM post_reposts WHERE user_id = $1 AND post_id = $2`, [u.id, id]);
      if (r.rowCount) await c.query(`UPDATE posts SET repost_count = greatest(repost_count - 1, 0) WHERE id = $1`, [id]);
    });
    const reposts = (await db.query(`SELECT repost_count FROM posts WHERE id = $1`, [id])).rows[0]?.repost_count ?? 0;
    return { reposted: false, reposts };
  });

  /** A person's reposts, newest first (what they chose to share). */
  app.get('/v1/users/:id/reposts', async (req) => {
    const viewer = req.user?.id ?? null;
    const { id } = parse(idParam, req.params);
    const q = parse(pageQuerySchema, req.query);
    const c = decodeCursor<KeyCursor>(q.cursor);
    const { rows } = await db.query(
      `SELECT p.id, r.created_at, r.post_id AS rid FROM post_reposts r JOIN posts p ON p.id = r.post_id
       JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
       WHERE r.user_id = $2 AND ${VISIBLE} AND ${notBlockedSql('r.user_id', '$1')}
       ${c ? 'AND (r.created_at, r.post_id) < ($4::timestamptz, $5::uuid)' : ''}
       ORDER BY r.created_at DESC, r.post_id DESC LIMIT $3`,
      c ? [viewer, id, q.limit + 1, c.t, c.id] : [viewer, id, q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    return {
      items: await hydratePosts(
        db,
        page.map((r) => r.id),
        viewer,
      ),
      nextCursor: rows.length > q.limit ? keyCursorOf({ created_at: page.at(-1)!.created_at, id: page.at(-1)!.rid }) : null,
    };
  });

  app.put('/v1/posts/:id/save', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    await assertVisible(id, me(req).id);
    await db.query(`INSERT INTO saves (post_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, me(req).id]);
    return { saved: true };
  });

  app.delete('/v1/posts/:id/save', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    await db.query(`DELETE FROM saves WHERE post_id = $1 AND user_id = $2`, [id, me(req).id]);
    return { saved: false };
  });

  app.get('/v1/me/saved', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { rows } = await db.query(
      `SELECT s.post_id AS id ${POST_FROM} JOIN saves s ON s.post_id = p.id AND s.user_id = $1 WHERE ${VISIBLE} ORDER BY s.created_at DESC LIMIT 100`,
      [u.id],
    );
    return {
      items: await hydratePosts(
        db,
        rows.map((r) => r.id),
        u.id,
      ),
    };
  });

  app.post('/v1/posts/:id/vote', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { optionId } = parse(z.object({ optionId: z.string().uuid() }), req.body);
    await assertUnlocked(id, u.id);
    const opt = await db.query(`SELECT 1 FROM poll_options WHERE id = $1 AND post_id = $2`, [optionId, id]);
    if (!opt.rowCount) throw notFound('Poll option');
    await db.query(
      `INSERT INTO poll_votes (post_id, option_id, user_id) VALUES ($1,$2,$3) ON CONFLICT (post_id, user_id) DO UPDATE SET option_id = EXCLUDED.option_id`,
      [id, optionId, u.id],
    );
    const [post] = await hydratePosts(db, [id], u.id);
    return { poll: post!.poll };
  });

  // ── Comments ──────────────────────────────────────────────────────────
  app.get('/v1/posts/:id/comments', async (req) => {
    const viewer = req.user?.id ?? null;
    const { id } = parse(idParam, req.params);
    const q = parse(pageQuerySchema, req.query);
    await assertUnlocked(id, viewer);
    const c = decodeCursor<KeyCursor>(q.cursor);
    const { rows } = await db.query(
      `SELECT cm.id, cm.post_id, cm.parent_id, cm.body, cm.created_at,
              pr.user_id AS a_id, pr.username AS a_username, pr.display_name AS a_display_name, pr.avatar_url AS a_avatar_url, pr.mode AS a_mode, ${plusCol('a_')}
       FROM comments cm JOIN profiles pr ON pr.user_id = cm.author_id
       WHERE cm.post_id = $2 AND cm.deleted_at IS NULL AND (cm.moderation_status IN ('normal','review') OR cm.author_id = $1)
         AND ${notBlockedSql('cm.author_id', '$1')}
         AND NOT EXISTS (SELECT 1 FROM restrictions r JOIN posts p ON p.id = cm.post_id WHERE r.restrictor_id = p.author_id AND r.restricted_id = cm.author_id AND cm.author_id <> $1 AND p.author_id <> $1)
         ${c ? 'AND (cm.created_at, cm.id) > ($4::timestamptz, $5::uuid)' : ''}
       ORDER BY cm.created_at, cm.id LIMIT $3`,
      c ? [viewer, id, q.limit + 1, c.t, c.id] : [viewer, id, q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    const items: Comment[] = page.map((r) => ({
      id: r.id,
      postId: r.post_id,
      parentId: r.parent_id,
      body: r.body,
      author: publicUserFrom(r, 'a_'),
      createdAt: r.created_at.toISOString(),
    }));
    return { items, nextCursor: rows.length > q.limit ? keyCursorOf(page.at(-1)!) : null };
  });

  app.post('/v1/posts/:id/comments', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(commentSchema, req.body);
    await assertUnlocked(id, u.id);
    const analysis = analyzeText(input.body);
    if (analysis.risk === 'escalate') throw new AppError(422, 'content_blocked', "This comment can't be posted because it may put someone at risk.");
    const comment = await tx(db, async (c) => {
      if (input.parentId) {
        const parent = await c.query(`SELECT 1 FROM comments WHERE id = $1 AND post_id = $2 AND deleted_at IS NULL`, [input.parentId, id]);
        if (!parent.rowCount) throw notFound('The comment you replied to');
      }
      const { rows } = await c.query(
        `INSERT INTO comments (post_id, author_id, parent_id, body, moderation_status) VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
        [id, u.id, input.parentId ?? null, input.body, statusForRisk(analysis.risk)],
      );
      await c.query(`UPDATE posts SET comment_count = comment_count + 1 WHERE id = $1`, [id]);
      if (analysis.risk !== 'normal')
        await c.query(
          `INSERT INTO moderation_cases (target_type, target_id, subject_user_id, source, risk, signals) VALUES ('comment',$1,$2,'automated',$3,$4) ON CONFLICT DO NOTHING`,
          [rows[0].id, u.id, analysis.risk, { signals: analysis.signals }],
        );
      return rows[0];
    });
    const post = (await db.query(`SELECT author_id FROM posts WHERE id = $1`, [id])).rows[0];
    await notify(db, ctx.realtime, {
      userId: post.author_id,
      category: 'creators',
      type: 'post_comment',
      actorId: u.id,
      entityType: 'post',
      entityId: id,
      data: { commentId: comment.id },
    });
    if (analysis.risk === 'normal')
      await notifyMentions(db, ctx.realtime, { text: input.body, actorId: u.id, postId: id, commentId: comment.id, skip: [post.author_id] });
    track(db, u.id, 'comment_created');
    const author = (
      await db.query(
        `SELECT user_id AS a_id, username AS a_username, display_name AS a_display_name, avatar_url AS a_avatar_url, mode AS a_mode FROM profiles WHERE user_id = $1`,
        [u.id],
      )
    ).rows[0];
    reply.code(201);
    return {
      comment: {
        id: comment.id,
        postId: id,
        parentId: input.parentId ?? null,
        body: input.body,
        author: publicUserFrom(author, 'a_'),
        createdAt: comment.created_at.toISOString(),
      } satisfies Comment,
    };
  });

  app.delete('/v1/comments/:id', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    // The comment author or the post author can remove a comment.
    const r = await db.query(
      `UPDATE comments cm SET deleted_at = now() FROM posts p
       WHERE cm.id = $1 AND p.id = cm.post_id AND cm.deleted_at IS NULL AND (cm.author_id = $2 OR p.author_id = $2) RETURNING cm.post_id`,
      [id, u.id],
    );
    if (!r.rowCount) throw notFound('Comment');
    await db.query(`UPDATE posts SET comment_count = greatest(comment_count - 1, 0) WHERE id = $1`, [r.rows[0].post_id]);
    return { ok: true };
  });

  void encodeCursor;
}
