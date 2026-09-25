import type { FastifyInstance } from 'fastify';
import { tx } from '@yapilapi/database';
import { commentSchema, createPostSchema, feedbackSchema, feedQuerySchema, pageQuerySchema, reactionSchema, usernameSchema, type Comment } from '@yapilapi/shared';
import { z } from 'zod';
import { AppError, badRequest, forbidden, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { decodeCursor, encodeCursor, keyCursorOf, type KeyCursor } from '../lib/cursor.ts';
import { analyzeText, statusForRisk } from '../lib/moderation.ts';
import { hydratePosts } from '../lib/posts.ts';
import { notify, track } from '../lib/services.ts';
import { publicUserFrom } from '../lib/users.ts';
import { notBlockedSql, postVisibleSql } from '../lib/visibility.ts';
import { me, requireAuth } from '../plugins/auth.ts';

const idParam = z.object({ id: z.string().uuid() });
const VISIBLE = postVisibleSql('$1');
const POST_FROM = `FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id`;

export default async function postsModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;

  async function assertVisible(postId: string, viewer: string | null) {
    const r = await db.query(`SELECT 1 ${POST_FROM} WHERE p.id = $2 AND ${VISIBLE}`, [viewer, postId]);
    if (!r.rowCount) throw notFound('That post');
  }

  // ── Create ────────────────────────────────────────────────────────────
  app.post('/v1/posts', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = me(req);
    const input = parse(createPostSchema, req.body);
    const analysis = analyzeText(`${input.body} ${input.poll?.options.join(' ') ?? ''}`);
    if (analysis.risk === 'escalate') throw new AppError(422, 'content_blocked', "This post can't be published because it may put someone at risk. If you or someone else is in danger, contact local emergency services.");

    const kind = input.poll ? 'poll' : input.media.length > 1 ? 'carousel' : input.media[0]?.kind === 'video' ? 'video' : input.media[0]?.kind === 'audio' ? 'audio' : input.media[0] ? 'photo' : input.linkUrl ? 'link' : input.kind;

    const postId = await tx(db, async (c) => {
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
        `INSERT INTO posts (author_id, kind, body, visibility, circle_id, community_id, event_id, product_id, link_url, topics, moderation_status, ai_provenance, rights)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [
          u.id, kind, input.body, input.communityId ? 'public' : input.visibility, input.circleId ?? null, input.communityId ?? null,
          input.eventId ?? null, input.productId ?? null, input.linkUrl ?? null,
          input.topics.map((t) => t.toLowerCase()), statusForRisk(analysis.risk),
          input.aiAssisted ? { assisted: true, at: new Date().toISOString() } : {},
          { owner: u.id, license: 'all_rights_reserved' },
        ],
      );
      const id = rows[0]!.id;
      for (const [i, m] of input.media.entries()) {
        const media = await c.query<{ id: string }>(
          `INSERT INTO media (owner_id, kind, url, alt_text, width, height) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [u.id, m.kind, m.url, m.altText ?? null, m.width ?? null, m.height ?? null],
        );
        await c.query(`INSERT INTO post_media (post_id, media_id, position) VALUES ($1,$2,$3)`, [id, media.rows[0]!.id, i]);
      }
      if (input.poll)
        for (const [i, label] of input.poll.options.entries())
          await c.query(`INSERT INTO poll_options (post_id, label, position) VALUES ($1,$2,$3)`, [id, label, i]);
      if (input.visibility === 'selected' && input.audience)
        await c.query(`INSERT INTO post_audience (post_id, user_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING`, [id, input.audience]);
      if (analysis.risk !== 'normal')
        await c.query(
          `INSERT INTO moderation_cases (target_type, target_id, subject_user_id, source, risk, signals) VALUES ('post', $1, $2, 'automated', $3, $4)`,
          [id, u.id, analysis.risk, { signals: analysis.signals }],
        );
      return id;
    });
    track(db, u.id, 'post_created', { kind, visibility: input.visibility, community: !!input.communityId });
    reply.code(201);
    const [post] = await hydratePosts(db, [postId], u.id);
    return { post, moderation: analysis.risk === 'normal' ? undefined : { status: statusForRisk(analysis.risk), message: 'Your post is published to you only until it has been reviewed.' } };
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

  app.get('/v1/users/:username/posts', async (req) => {
    const { username } = parse(z.object({ username: usernameSchema }), req.params);
    const q = parse(pageQuerySchema, req.query);
    const c = decodeCursor<KeyCursor>(q.cursor);
    const { rows } = await db.query(
      `SELECT p.id, p.created_at ${POST_FROM}
       WHERE lower(ap.username) = lower($2) AND p.community_id IS NULL AND ${VISIBLE}
         ${c ? 'AND (p.created_at, p.id) < ($4::timestamptz, $5::uuid)' : ''}
       ORDER BY p.created_at DESC, p.id DESC LIMIT $3`,
      c ? [req.user?.id ?? null, username, q.limit + 1, c.t, c.id] : [req.user?.id ?? null, username, q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    return { items: await hydratePosts(db, page.map((r) => r.id), req.user?.id ?? null), nextCursor: rows.length > q.limit ? keyCursorOf(page.at(-1)!) : null };
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
    const { rows } = await db.query(
      `SELECT p.id, p.created_at ${POST_FROM} WHERE ${scope[mode]} AND ${VISIBLE} ${personal}
       ${c ? 'AND (p.created_at, p.id) < ($3::timestamptz, $4::uuid)' : ''}
       ORDER BY p.created_at DESC, p.id DESC LIMIT $2`,
      c ? [u.id, q.limit + 1, c.t, c.id] : [u.id, q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    return { mode, items: await hydratePosts(db, page.map((r) => r.id), u.id), nextCursor: rows.length > q.limit ? keyCursorOf(page.at(-1)!) : null };
  });

  /**
   * For You ranking. Score = affinity + interest match + engagement + freshness
   * − negative feedback. The candidate window is fixed at the first page (asOf)
   * so pagination is stable. Diversity: at most 2 posts per author per page.
   * Not optimized for time spent: no autoplay loops, a clear end of feed.
   */
  async function rankedFeed(userId: string, cursor: string | undefined, limit: number, personal: string, reduced: boolean) {
    const c = decodeCursor<{ asOf: string; o: number }>(cursor) ?? { asOf: new Date().toISOString(), o: 0 };
    const connectionOnly = reduced
      ? `AND (p.author_id = $1 OR EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followee_id = p.author_id)
              OR EXISTS (SELECT 1 FROM community_members cm WHERE cm.community_id = p.community_id AND cm.user_id = $1))`
      : '';
    const { rows } = await db.query(
      `WITH my_topics AS (SELECT t.slug FROM user_interests ui JOIN topics t ON t.id = ui.topic_id WHERE ui.user_id = $1),
            less AS (SELECT DISTINCT unnest(p2.topics) AS topic FROM feed_feedback ff JOIN posts p2 ON p2.id = ff.post_id WHERE ff.user_id = $1 AND ff.signal = 'less_like_this'),
            more AS (SELECT DISTINCT unnest(p2.topics) AS topic FROM feed_feedback ff JOIN posts p2 ON p2.id = ff.post_id WHERE ff.user_id = $1 AND ff.signal = 'more_like_this')
       SELECT p.id, p.author_id, ap.display_name, cm_c.name AS community_name, (cm_self.user_id IS NOT NULL) AS member,
              EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followee_id = p.author_id) AS followed,
              EXISTS (SELECT 1 FROM friendships fr WHERE (fr.user_a = $1 AND fr.user_b = p.author_id) OR (fr.user_b = $1 AND fr.user_a = p.author_id)) AS friend,
              (SELECT t FROM unnest(p.topics) t WHERE t IN (SELECT slug FROM my_topics) LIMIT 1) AS matched_topic,
              (
                CASE WHEN p.author_id = $1 THEN 1 ELSE 0 END
                + CASE WHEN EXISTS (SELECT 1 FROM friendships fr WHERE (fr.user_a = $1 AND fr.user_b = p.author_id) OR (fr.user_b = $1 AND fr.user_a = p.author_id)) THEN 3 ELSE 0 END
                + CASE WHEN EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followee_id = p.author_id) THEN 2 ELSE 0 END
                + CASE WHEN cm_self.user_id IS NOT NULL THEN 1.5 ELSE 0 END
                + (SELECT count(*) FROM unnest(p.topics) t WHERE t IN (SELECT slug FROM my_topics)) * 1.2
                + (SELECT count(*) FROM unnest(p.topics) t WHERE t IN (SELECT topic FROM more)) * 1.0
                - (SELECT count(*) FROM unnest(p.topics) t WHERE t IN (SELECT topic FROM less)) * 2.0
                + ln(1 + p.like_count + 2 * p.comment_count) * 0.6
                + 4.0 * exp(-extract(epoch FROM ($2::timestamptz - p.created_at)) / 86400.0)
              ) AS score
       ${POST_FROM}
       LEFT JOIN communities cm_c ON cm_c.id = p.community_id
       LEFT JOIN community_members cm_self ON cm_self.community_id = p.community_id AND cm_self.user_id = $1 AND cm_self.status = 'active'
       WHERE ${VISIBLE} ${personal} ${connectionOnly}
         AND p.created_at <= $2::timestamptz AND p.created_at > $2::timestamptz - interval '14 days'
         AND (p.community_id IS NULL OR cm_self.user_id IS NOT NULL OR cm_c.visibility = 'public')
       ORDER BY score DESC, p.created_at DESC, p.id DESC
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
      items: await hydratePosts(db, picked.map((r) => r.id), userId, reasons),
      nextCursor: more ? encodeCursor({ asOf: c.asOf, o: c.o + consumed }) : null,
    };
  }

  app.post('/v1/feed/feedback', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const input = parse(feedbackSchema, req.body);
    let authorId = input.authorId ?? null;
    if (input.postId) {
      await assertVisible(input.postId, u.id);
      if (input.signal === 'mute_creator' && !authorId) authorId = (await db.query(`SELECT author_id FROM posts WHERE id = $1`, [input.postId])).rows[0]?.author_id ?? null;
    }
    if (input.signal === 'mute_topic' && !input.topic) throw badRequest('Choose a topic to mute.');
    await db.query(`INSERT INTO feed_feedback (user_id, signal, post_id, author_id, topic) VALUES ($1,$2,$3,$4,$5)`, [u.id, input.signal, input.postId ?? null, authorId, input.topic ?? null]);
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
        ARRAY(SELECT t FROM unnest(p.topics) t WHERE t IN (SELECT tp.slug FROM user_interests ui JOIN topics tp ON tp.id = ui.topic_id WHERE ui.user_id = $1)) AS matched,
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
      await notify(db, ctx.realtime, { userId: author, category: 'creators', type: 'post_reaction', actorId: u.id, entityType: 'post', entityId: id, data: { kind } });
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
    const { rows } = await db.query(`SELECT s.post_id AS id ${POST_FROM} JOIN saves s ON s.post_id = p.id AND s.user_id = $1 WHERE ${VISIBLE} ORDER BY s.created_at DESC LIMIT 100`, [u.id]);
    return { items: await hydratePosts(db, rows.map((r) => r.id), u.id) };
  });

  app.post('/v1/posts/:id/vote', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { optionId } = parse(z.object({ optionId: z.string().uuid() }), req.body);
    await assertVisible(id, u.id);
    const opt = await db.query(`SELECT 1 FROM poll_options WHERE id = $1 AND post_id = $2`, [optionId, id]);
    if (!opt.rowCount) throw notFound('Poll option');
    await db.query(`INSERT INTO poll_votes (post_id, option_id, user_id) VALUES ($1,$2,$3) ON CONFLICT (post_id, user_id) DO UPDATE SET option_id = EXCLUDED.option_id`, [id, optionId, u.id]);
    const [post] = await hydratePosts(db, [id], u.id);
    return { poll: post!.poll };
  });

  // ── Comments ──────────────────────────────────────────────────────────
  app.get('/v1/posts/:id/comments', async (req) => {
    const viewer = req.user?.id ?? null;
    const { id } = parse(idParam, req.params);
    const q = parse(pageQuerySchema, req.query);
    await assertVisible(id, viewer);
    const c = decodeCursor<KeyCursor>(q.cursor);
    const { rows } = await db.query(
      `SELECT cm.id, cm.post_id, cm.parent_id, cm.body, cm.created_at,
              pr.user_id AS a_id, pr.username AS a_username, pr.display_name AS a_display_name, pr.avatar_url AS a_avatar_url, pr.mode AS a_mode
       FROM comments cm JOIN profiles pr ON pr.user_id = cm.author_id
       WHERE cm.post_id = $2 AND cm.deleted_at IS NULL AND (cm.moderation_status IN ('normal','review') OR cm.author_id = $1)
         AND ${notBlockedSql('cm.author_id', '$1')}
         AND NOT EXISTS (SELECT 1 FROM restrictions r JOIN posts p ON p.id = cm.post_id WHERE r.restrictor_id = p.author_id AND r.restricted_id = cm.author_id AND cm.author_id <> $1 AND p.author_id <> $1)
         ${c ? 'AND (cm.created_at, cm.id) > ($4::timestamptz, $5::uuid)' : ''}
       ORDER BY cm.created_at, cm.id LIMIT $3`,
      c ? [viewer, id, q.limit + 1, c.t, c.id] : [viewer, id, q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    const items: Comment[] = page.map((r) => ({ id: r.id, postId: r.post_id, parentId: r.parent_id, body: r.body, author: publicUserFrom(r, 'a_'), createdAt: r.created_at.toISOString() }));
    return { items, nextCursor: rows.length > q.limit ? keyCursorOf(page.at(-1)!) : null };
  });

  app.post('/v1/posts/:id/comments', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(commentSchema, req.body);
    await assertVisible(id, u.id);
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
        await c.query(`INSERT INTO moderation_cases (target_type, target_id, subject_user_id, source, risk, signals) VALUES ('comment',$1,$2,'automated',$3,$4) ON CONFLICT DO NOTHING`, [rows[0].id, u.id, analysis.risk, { signals: analysis.signals }]);
      return rows[0];
    });
    const post = (await db.query(`SELECT author_id FROM posts WHERE id = $1`, [id])).rows[0];
    await notify(db, ctx.realtime, { userId: post.author_id, category: 'creators', type: 'post_comment', actorId: u.id, entityType: 'post', entityId: id, data: { commentId: comment.id } });
    track(db, u.id, 'comment_created');
    const author = (await db.query(`SELECT user_id AS a_id, username AS a_username, display_name AS a_display_name, avatar_url AS a_avatar_url, mode AS a_mode FROM profiles WHERE user_id = $1`, [u.id])).rows[0];
    reply.code(201);
    return { comment: { id: comment.id, postId: id, parentId: input.parentId ?? null, body: input.body, author: publicUserFrom(author, 'a_'), createdAt: comment.created_at.toISOString() } satisfies Comment };
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
