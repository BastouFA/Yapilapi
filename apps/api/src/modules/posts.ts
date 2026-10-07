import type { FastifyInstance } from 'fastify';
import { tx } from '@yapilapi/database';
import {
  createPostSchema,
  editPostSchema,
  feedbackSchema,
  feedQuerySchema,
  pageQuerySchema,
  postCountsSchema,
  reactionSchema,
  sendPostSchema,
  SAVED_FILTERS,
  usernameSchema,
  extractHashtags,
  MAX_EDITS_PER_DAY,
  reelHighlightsSchema,
  reelResumeSchema,
  resumeWorthKeeping,
  whyReasonText,
  type MessageFailureCode,
  type PostVersion,
  type PostWhy,
  type WhyReason,
} from '@yapilapi/shared';
import { z } from 'zod';
import { AppError, badRequest, forbidden, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { decodeCursor, keyCursorOf, type KeyCursor } from '../lib/cursor.ts';
import { analyzeText, statusForRisk } from '../lib/moderation.ts';
import { ENGLISH_REASONS, hydratePosts, type FeedReason } from '../lib/posts.ts';
import { RANKING, rankedPage } from '../lib/ranking.ts';
import { fadedScoreSql, learn, learnFromPost, learnQuietly } from '../lib/affinity.ts';
import { bumpStats, trendSql, TREND } from '../lib/post-stats.ts';
import { attachSaveNotes, savedFilterSql } from '../lib/saves.ts';
import { notifyMentions } from '../lib/mentions.ts';
import { coAuthoredIdsSql } from '../lib/collabs.ts';
import { topicsFor } from './tags.ts';
import { notify, personalizationAllowed, track } from '../lib/services.ts';
import { plusCol, publicUserFrom } from '../lib/users.ts';
import { seesSensitiveMedia } from '../lib/interactions.ts';
import { notBlockedSql, postUnlockedSql, postVisibleSql } from '../lib/visibility.ts';
import { assessPost } from '../lib/spam.ts';
import { requireVerified } from '../lib/verification.ts';
import {
  announcePost,
  assertDraftRoom,
  moderationNotice,
  prepareMusic,
  recordFlags,
  schedulePost,
  scheduleTime,
  screenPost,
  writePost,
  type Screening,
} from '../lib/publishing.ts';
import { me, requireAuth } from '../plugins/auth.ts';
import { langOf } from '../lib/translation.ts';
import { checkEchoSong } from '../lib/echoes.ts';
import { checkMilestones } from '../lib/milestones.ts';
import { messageFailureCode, messageFailureEnglish } from '../lib/failures.ts';
import { asSameUser } from './moments.ts';
import { recordShare } from './recommendations.ts';

const idParam = z.object({ id: z.string().uuid() });

/** Personal filters for every feed (the viewer is $1): muted people, "not interested", muted creators and topics. */
const PERSONAL_FILTERS = `
      AND NOT EXISTS (SELECT 1 FROM mutes m WHERE m.muter_id = $1 AND m.muted_id = p.author_id)
      AND NOT EXISTS (SELECT 1 FROM feed_feedback ff WHERE ff.user_id = $1 AND (
            (ff.signal = 'not_interested' AND ff.post_id = p.id)
         OR (ff.signal = 'mute_creator' AND ff.author_id = p.author_id)
         OR (ff.signal = 'mute_topic' AND ff.topic = ANY(p.topics))))`;
const VISIBLE = postVisibleSql('$1');
const UNLOCKED = postUnlockedSql('$1');
const POST_FROM = `FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id`;

/** The stricter of two moderation states. */
function worseStatus(a: string, b: string): string {
  const order = ['normal', 'review', 'restricted', 'removed'];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

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
   * Reels: short vertical videos in a full-screen feed, ranked by the recommender (lib/ranking.ts):
   * people you're close to, what you watch, finish and skip, your interests and feedback, quality,
   * momentum and freshness, with room for new creators. The order is kept while you page, so
   * paging never repeats or skips.
   */
  app.get('/v1/reels', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const q = parse(z.object({ cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(20).default(8) }), req.query);
    // A reel is its video: people under 18 don't get reels whose video is marked sensitive.
    const ranked = await rankedPage(
      db,
      {
        userId: u.id,
        surface: 'reels',
        personalized: await personalizationAllowed(db, u.id),
        personal: PERSONAL_FILTERS,
        sensitiveOk: await seesSensitiveMedia(db, u.id),
      },
      q.cursor,
      q.limit,
    );
    const items = await hydratePosts(
      db,
      ranked.items.map((r) => r.id),
      u.id,
      new Map(ranked.items.map((r) => [r.id, r.reason])),
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
      nextCursor: ranked.nextCursor,
    };
  });

  /**
   * Share a post, or keep it for later: `draft: true` saves a draft and
   * `scheduledAt` publishes it at that time. Drafts and scheduled posts are
   * only the author's until they're published (see lib/publishing.ts).
   */
  app.post('/v1/posts', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = me(req);
    const input = parse(createPostSchema, req.body);
    if (input.draft || input.scheduledAt) {
      const music = await prepareMusic(ctx, u.id, input);
      const at = input.scheduledAt ? scheduleTime(input.scheduledAt) : null;
      // Scheduling says now, not at the time, if the account can't reach everyone yet.
      if (at && (input.visibility === 'public' || input.communityId)) await requireVerified(db, ctx.config, u.id, 'post');
      await assertDraftRoom(db, u.id);
      const { id } = await tx(db, async (c) => {
        const w = await writePost(c, u.id, input, { state: 'draft', music });
        if (at) await schedulePost(c, w.id, u.id, at);
        return w;
      });
      track(db, u.id, at ? 'post_scheduled' : 'post_drafted', { visibility: input.visibility });
      reply.code(201);
      const [post] = await hydratePosts(db, [id], u.id);
      return { post };
    }
    const screening = await screenPost(db, ctx.config, u.id, {
      body: input.body,
      pollText: input.poll?.options.join(' ') ?? '',
      visibility: input.visibility,
      communityId: input.communityId,
    });
    // A song is checked again at publish time: still offered, and its licence allows this author, country and part.
    const music = await prepareMusic(ctx, u.id, input);
    // So is the song an echo keeps from the reel it answers.
    if (input.echo) await checkEchoSong(ctx, u.id, input.echo);
    let limitedNow = false;
    const written = await tx(db, async (c) => {
      const w = await writePost(c, u.id, input, { state: 'published', moderationStatus: screening.status, music });
      limitedNow = await recordFlags(c, ctx.realtime, u.id, w.id, screening);
      return w;
    });
    await announcePost(ctx, {
      postId: written.id,
      authorId: u.id,
      kind: written.kind,
      visibility: input.visibility,
      communityId: input.communityId,
      body: input.body,
      status: screening.status,
      taggedIds: written.taggedIds,
      collaborators: input.collaborators,
      remixAuthor: written.remixAuthor,
      remixOf: input.remixOf,
      remixMode: input.remixMode,
      echo: written.echo,
    });
    reply.code(201);
    const [post] = await hydratePosts(db, [written.id], u.id);
    return { post, moderation: moderationNotice(screening, limitedNow) };
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

  /**
   * Change a post you shared: its text, who can see it, and how its photos and
   * videos are described. Media, polls and links stay as they are. A new text
   * keeps the old one in the post's history (anyone who can see the post can
   * read it), shows "Edited", updates its hashtags and tells only the people it
   * newly mentions. Reposts and quotes keep pointing at the same post.
   */
  app.patch('/v1/posts/:id', { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(editPostSchema, req.body);
    const post = (
      await db.query(
        `SELECT p.author_id, p.visibility, p.community_id, p.link_url, p.moderation_status, p.is_echo,
                EXISTS (SELECT 1 FROM post_media pm WHERE pm.post_id = p.id) AS has_media,
                EXISTS (SELECT 1 FROM poll_options o WHERE o.post_id = p.id) AS has_poll,
                EXISTS (SELECT 1 FROM post_collaborators pc WHERE pc.post_id = p.id AND pc.status IN ('pending', 'accepted')) AS has_collabs,
                (SELECT count(*)::int FROM post_edits e WHERE e.post_id = p.id AND e.edited_at > now() - interval '1 day') AS edits_today
         ${POST_FROM} WHERE p.id = $2 AND ${VISIBLE}`,
        [u.id, id],
      )
    ).rows[0];
    if (!post) throw notFound('That post');
    if (post.author_id !== u.id) throw forbidden('Only the person who shared this post can change it.');
    if (post.moderation_status === 'removed') throw forbidden("This post was removed, so it can't be changed.");

    const visibility: string = input.visibility ?? post.visibility;
    if (visibility !== post.visibility) {
      if (post.community_id) throw badRequest('Posts in a community are shared with its members.');
      if (post.has_collabs && !['public', 'followers', 'friends'].includes(visibility))
        throw badRequest('Posts with co-authors can be shared publicly, with followers or with friends.');
      if (visibility === 'subscribers' && post.is_echo) throw badRequest("An echo can't be for subscribers only: it shows someone else's reel.");
      if (visibility === 'subscribers') {
        const plan = await db.query(`SELECT 1 FROM creator_plans WHERE creator_id = $1 AND active LIMIT 1`, [u.id]);
        if (!plan.rowCount) throw badRequest('Add a subscription plan in Studio before posting for subscribers.');
      }
      if (visibility === 'public') await requireVerified(db, ctx.config, u.id, 'post');
    }

    // A new text is checked like a new post: harmful text is refused, anything flagged waits for a moderator.
    let screening: Screening | null = null;
    if (input.body !== undefined) {
      if (!input.body && !post.has_media && !post.link_url && !post.has_poll)
        throw new AppError(400, 'validation_failed', 'A post needs text, media, a link or a poll.', { fields: { body: 'Add some text.' } });
      const analysis = analyzeText(input.body);
      if (analysis.risk === 'escalate')
        throw new AppError(
          422,
          'content_blocked',
          "This change can't be saved because it may put someone at risk. If you or someone else is in danger, contact local emergency services.",
        );
      const spam = await assessPost(db, ctx.config, u.id, input.body);
      // As for a new post: a risky account's post that reaches everyone waits for review.
      const heldForAccount = spam.risky && visibility === 'public';
      const status = spam.restricted
        ? 'restricted'
        : analysis.risk !== 'normal'
          ? statusForRisk(analysis.risk)
          : spam.flags.length || heldForAccount
            ? 'review'
            : 'normal';
      screening = { analysis, spam, heldForAccount, status };
    }
    // Opening a post up to everyone goes through the account checks a new public post does, so posting to
    // followers first and widening it later doesn't skip them.
    const widened = visibility === 'public' && post.visibility !== 'public';
    if (widened && !screening) {
      const spam = await assessPost(db, ctx.config, u.id, '');
      if (spam.restricted || spam.risky)
        screening = { analysis: analyzeText(''), spam, heldForAccount: spam.risky, status: spam.restricted ? 'restricted' : 'review' };
    }

    let limitedNow = false;
    const edit = await tx(db, async (c) => {
      const cur = (await c.query(`SELECT body, topics, moderation_status FROM posts WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      const changed = input.body !== undefined && input.body !== cur.body;
      if (changed && post.edits_today >= MAX_EDITS_PER_DAY)
        throw new AppError(429, 'slow_down', `You can change a post's text up to ${MAX_EDITS_PER_DAY} times a day. Try again later.`);
      // Topics chosen when posting stay; hashtags follow the text.
      const topics = changed
        ? topicsFor(
            cur.topics.filter((t: string) => !extractHashtags(cur.body).includes(t)),
            input.body,
          )
        : cur.topics;
      // An edit can put a post on hold, never take it off hold.
      const screened = (changed || widened) && screening;
      const status = screened ? worseStatus(cur.moderation_status, screening!.status) : cur.moderation_status;
      if (changed) await c.query(`INSERT INTO post_edits (post_id, body) VALUES ($1, $2)`, [id, cur.body]);
      await c.query(
        `UPDATE posts SET body = $2, visibility = $3, topics = $4, moderation_status = $5, edited_at = CASE WHEN $6 THEN now() ELSE edited_at END, updated_at = now(),
                          lang = CASE WHEN $6 THEN $7 ELSE lang END
         WHERE id = $1`,
        [id, changed ? input.body : cur.body, visibility, topics, status, changed, changed ? langOf(input.body!) : null],
      );
      // Descriptions of the post's own photos and videos (an empty one clears it).
      for (const m of input.media ?? []) {
        const r = await c.query(
          `UPDATE media SET alt_text = nullif($3, '') WHERE id = $1 AND owner_id = $2 AND EXISTS (SELECT 1 FROM post_media pm WHERE pm.post_id = $4 AND pm.media_id = media.id)`,
          [m.id, u.id, m.altText, id],
        );
        if (!r.rowCount) throw notFound('One of the photos or videos');
      }
      if (screened) limitedNow = await recordFlags(c, ctx.realtime, u.id, id, screening!);
      return { changed, screened: !!screened, before: cur.body as string, status };
    });
    if (edit.changed && edit.status === 'normal') {
      // Only people the post didn't mention before hear about it.
      const earlier = await db.query<{ body: string }>(`SELECT body FROM post_edits WHERE post_id = $1`, [id]);
      await notifyMentions(db, ctx.realtime, { text: input.body, actorId: u.id, postId: id, previously: [edit.before, ...earlier.rows.map((r) => r.body)] });
    }
    if (edit.changed) track(db, u.id, 'post_edited');
    const [updated] = await hydratePosts(db, [id], u.id);
    return { post: updated, moderation: edit.screened && screening ? moderationNotice({ ...screening, status: edit.status }, limitedNow) : undefined };
  });

  /** Every version of a post's text, newest first, for anyone who can see and open the post. */
  app.get('/v1/posts/:id/history', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = parse(idParam, req.params);
    await assertUnlocked(id, req.user?.id ?? null);
    const { rows } = await db.query(
      `SELECT p.body, p.created_at,
              (SELECT coalesce(json_agg(json_build_object('body', e.body, 'editedAt', e.edited_at) ORDER BY e.edited_at, e.id), '[]')
               FROM post_edits e WHERE e.post_id = p.id) AS edits
       FROM posts p WHERE p.id = $1`,
      [id],
    );
    const r = rows[0];
    const edits = r.edits as { body: string; editedAt: string }[];
    // Each text was written when the one before it was replaced; the first one when the post was shared.
    const writtenAt = (i: number) => (i === 0 ? (r.created_at as Date).toISOString() : new Date(edits[i - 1]!.editedAt).toISOString());
    const items: PostVersion[] = [
      ...edits.map((e, i) => ({ body: e.body, at: writtenAt(i), current: false })),
      { body: r.body, at: writtenAt(edits.length), current: true },
    ];
    return { items: items.reverse() };
  });

  /**
   * A person's posts, newest first, with their pinned post (if you can see it) at the top of the first page.
   * Posts they co-author are listed too, still only where you can see them. A private co-author's
   * collabs are listed only to the people who can see that profile (them and their followers).
   */
  app.get('/v1/users/:username/posts', async (req) => {
    const { username } = parse(z.object({ username: usernameSchema }), req.params);
    const q = parse(pageQuerySchema, req.query);
    // `format=reel`: only their reels (the profile's Reels tab), with no pinned post on top.
    const { format } = parse(z.object({ format: z.enum(['reel']).optional() }), req.query);
    const c = decodeCursor<KeyCursor>(q.cursor);
    const viewer = req.user?.id ?? null;
    const pinned =
      c || format
        ? null
        : (await db.query(`SELECT p.id ${POST_FROM} WHERE lower(ap.username) = lower($2) AND p.id = ap.pinned_post_id AND ${VISIBLE}`, [viewer, username]))
            .rows[0]?.id;
    // Their own posts and their collabs are read separately, each newest first and stopping after a
    // page (posts_author_idx walks only this person's posts), then merged.
    const branch = (whose: string) =>
      `(SELECT p.id, p.created_at ${POST_FROM}
        CROSS JOIN (SELECT pr.user_id AS id, pr.is_private, pr.pinned_post_id FROM profiles pr WHERE lower(pr.username) = lower($2)) o
        WHERE ${whose}
          AND p.community_id IS NULL AND ${VISIBLE} AND (${format ? `p.format = 'reel'` : 'p.id IS DISTINCT FROM o.pinned_post_id'})
          ${c ? 'AND (p.created_at, p.id) < ($4::timestamptz, $5::uuid)' : ''}
        ORDER BY p.created_at DESC, p.id DESC LIMIT $3)`;
    const { rows } = await db.query(
      `SELECT id, created_at FROM (
         ${branch('p.author_id = o.id')}
         UNION
         ${branch(`p.id = ANY(${coAuthoredIdsSql('o.id')})
                   AND (NOT o.is_private OR o.id = $1 OR EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followee_id = o.id))`)}
       ) x
       ORDER BY created_at DESC, id DESC LIMIT $3`,
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
      const own = await db.query(
        `SELECT 1 FROM posts WHERE id = $1 AND author_id = $2 AND deleted_at IS NULL AND status = 'published' AND community_id IS NULL`,
        [postId, u.id],
      );
      if (!own.rowCount) throw notFound('That post');
    }
    await db.query(`UPDATE profiles SET pinned_post_id = $2 WHERE user_id = $1`, [u.id, postId]);
    return { pinnedPostId: postId };
  });

  /**
   * Someone watched a reel or opened a post: counted once per person, never for the author (posts
   * seen in a feed count too, from POST /v1/feed/events). Passing 100, 1,000… views tells the author.
   * The count comes back only where the viewer may see it (the author can hide it).
   */
  app.post('/v1/posts/:id/view', { preHandler: requireAuth, config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    await assertVisible(id, u.id);
    const r = await db.query(
      `WITH ins AS (INSERT INTO post_views (post_id, viewer_id) SELECT $1, $2 FROM posts WHERE id = $1 AND author_id <> $2 ON CONFLICT DO NOTHING RETURNING 1)
       UPDATE posts p SET view_count = view_count + (SELECT count(*) FROM ins) FROM profiles pr
       WHERE p.id = $1 AND pr.user_id = p.author_id
       RETURNING p.view_count, (SELECT count(*) FROM ins)::int AS added, coalesce(p.hide_counts, pr.hide_counts) AND p.author_id <> $2 AS hidden`,
      [id, u.id],
    );
    const row = r.rows[0];
    if (row?.added) await checkMilestones(db, ctx.realtime, [id], 'views');
    return row?.hidden ? {} : { views: row?.view_count ?? 0 };
  });

  /** Hide your post's like and view counts from everyone but you, or show them again (it overrides your account's choice). */
  app.put('/v1/posts/:id/counts', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { hidden } = parse(postCountsSchema, req.body);
    const r = await db.query(`UPDATE posts SET hide_counts = $3 WHERE id = $1 AND author_id = $2 AND deleted_at IS NULL`, [id, u.id, hidden]);
    if (!r.rowCount) throw notFound('That post');
    return { countsHidden: hidden };
  });

  /**
   * Send a post or reel into chats: a message with its link (and your words), sent through the
   * messaging endpoints as you, so blocks, minor protection and who can message whom apply as for
   * any message. The link opens only for people who can see the post. It counts as a share once
   * per person and post in FEED_EVENT_RULES.dedupeMinutes, like a share from the share sheet.
   */
  app.post('/v1/posts/:id/send', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(sendPostSchema, req.body);
    await assertVisible(id, u.id);
    const p = (await db.query<{ author_id: string; format: string; status: string }>(`SELECT author_id, format, status FROM posts WHERE id = $1`, [id]))
      .rows[0]!;
    if (p.status !== 'published') throw notFound('That post');
    const origin = ctx.config.WEB_ORIGIN.replace(/\/+$/, '');
    const link = `${origin}${p.format === 'reel' ? `/reels?start=${id}` : `/p/${id}`}`;
    const body = input.body ? `${input.body}\n${link}` : link;
    const asSender = asSameUser(req);
    const targets = [...new Set(input.conversationIds)];
    // Why each one wasn't sent, as a code the app says in your language (the English for older apps).
    const failed: { id: string; code: MessageFailureCode; message: string }[] = [];
    const refused = (to: string, r: { statusCode: number; json: () => { error?: { code?: string } } }) => {
      const code = messageFailureCode({ status: r.statusCode, code: r.json().error?.code });
      failed.push({ id: to, code, message: messageFailureEnglish(code) });
    };
    for (const userId of new Set(input.userIds.filter((x) => x !== u.id))) {
      const convo = await app.inject({ method: 'POST', url: '/v1/conversations', headers: asSender, payload: { memberIds: [userId] } });
      if (convo.statusCode >= 300) refused(userId, convo);
      else targets.push(convo.json().conversation.id as string);
    }
    const sent: string[] = [];
    for (const conversationId of new Set(targets)) {
      const r = await app.inject({
        method: 'POST',
        url: `/v1/conversations/${conversationId}/messages`,
        headers: asSender,
        payload: { body, clientId: `post-share-${id.slice(0, 8)}-${conversationId.slice(0, 8)}-${Date.now()}` },
      });
      if (r.statusCode >= 300) refused(conversationId, r);
      else sent.push(conversationId);
    }
    if (!sent.length) throw new AppError(403, 'not_sent', failed[0]?.message ?? 'Not sent.', { reason: failed[0]?.code ?? 'not_sent' });
    if (p.author_id !== u.id && (await recordShare(db, u.id, id))) await learnQuietly(learnFromPost(db, u.id, id, 'share'), req.log);
    track(db, u.id, 'post_sent', { to: sent.length });
    reply.code(201);
    return { conversationIds: sent, failed };
  });

  // ── Reels plus: highlights and continue where you left off ────────────
  /** A reel the viewer can see and open, with its author and its video's length (null while unknown). */
  async function openReel(postId: string, viewer: string) {
    const { rows } = await db.query(
      `SELECT p.author_id, p.format, coalesce(${UNLOCKED}, false) AS unlocked,
              (SELECT m.duration_ms FROM post_media pm JOIN media m ON m.id = pm.media_id WHERE pm.post_id = p.id ORDER BY pm.position LIMIT 1) AS duration_ms
       ${POST_FROM} WHERE p.id = $2 AND ${VISIBLE}`,
      [viewer, postId],
    );
    const r = rows[0];
    if (!r || r.format !== 'reel') throw notFound('That reel');
    if (!r.unlocked) throw new AppError(403, 'subscribers_only', 'This post is for subscribers. Subscribe to see it.');
    return { authorId: r.author_id as string, durationMs: (r.duration_ms as number | null) ?? null };
  }

  /**
   * The creator's highlights: up to five named points in their reel, shown as ticks on the
   * scrubber and in a list. Replaces the list; an empty list removes them.
   */
  app.put('/v1/posts/:id/highlights', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { highlights } = parse(z.object({ highlights: reelHighlightsSchema }), req.body);
    const reel = await openReel(id, u.id);
    if (reel.authorId !== u.id) throw forbidden('Only the creator can mark highlights in a reel.');
    if (reel.durationMs && highlights.some((h) => h.atMs >= reel.durationMs!)) throw badRequest('Each highlight has to be within the video.');
    await db.query(`UPDATE posts SET highlights = $2 WHERE id = $1`, [id, highlights.length ? JSON.stringify(highlights) : null]);
    return { highlights };
  });

  /**
   * Continue where you left off: where you are in a reel, sent while watching and when you
   * leave it. Positions in the first few seconds or the last stretch clear it instead.
   */
  app.put('/v1/posts/:id/resume', { preHandler: requireAuth, config: { rateLimit: { max: 240, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(reelResumeSchema, req.body);
    const reel = await openReel(id, u.id);
    const length = reel.durationMs ?? input.durationMs ?? null;
    if (length && input.positionMs > length) throw badRequest('That time is past the end of the reel.');
    if (!resumeWorthKeeping(input.positionMs, length)) {
      await db.query(`DELETE FROM reel_resume WHERE user_id = $1 AND post_id = $2`, [u.id, id]);
      return { resumeMs: null };
    }
    await db.query(
      `INSERT INTO reel_resume (user_id, post_id, position_ms) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, post_id) DO UPDATE SET position_ms = EXCLUDED.position_ms, updated_at = now()`,
      [u.id, id, input.positionMs],
    );
    return { resumeMs: input.positionMs };
  });

  /** Start the reel from the top next time. */
  app.delete('/v1/posts/:id/resume', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    await db.query(`DELETE FROM reel_resume WHERE user_id = $1 AND post_id = $2`, [u.id, id]);
    return { resumeMs: null };
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

    const personal = PERSONAL_FILTERS;

    if (mode === 'for_you') return rankedFeed(u.id, q.cursor, q.limit, personal, !!prefs.reduced_recommendations, await personalizationAllowed(db, u.id));

    const scope: Record<string, string> = {
      following: `(p.author_id = $1 OR EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followee_id = p.author_id)) AND p.community_id IS NULL`,
      friends: `p.author_id IN (SELECT user_b FROM friendships WHERE user_a = $1 UNION ALL SELECT user_a FROM friendships WHERE user_b = $1) AND p.community_id IS NULL`,
      communities: `EXISTS (SELECT 1 FROM community_members cm WHERE cm.community_id = p.community_id AND cm.user_id = $1 AND cm.status = 'active')`,
      local: `p.event_id IS NOT NULL AND EXISTS (SELECT 1 FROM events e JOIN places pl ON pl.id = e.place_id WHERE e.id = p.event_id AND pl.city IS NOT NULL
               AND pl.city = (SELECT pl2.city FROM event_attendees ea JOIN events e2 ON e2.id = ea.event_id JOIN places pl2 ON pl2.id = e2.place_id
                              WHERE ea.user_id = $1 ORDER BY ea.updated_at DESC LIMIT 1))`,
    };
    const c = decodeCursor<KeyCursor>(q.cursor);
    if (mode === 'following') {
      // Posts by people you follow, and posts they reposted (placed at the time of the repost, newest per post).
      const { rows } = await db.query(
        `WITH followed AS (SELECT followee_id AS id FROM follows WHERE follower_id = $1),
         -- You and the people you follow, joined to posts by author (posts_author_idx) rather than
         -- checking every post on the platform against your follows.
         people AS (SELECT $1::uuid AS id UNION SELECT id FROM followed),
         items AS (
           SELECT p.id, p.created_at AS at, NULL::uuid AS by FROM people a JOIN posts p ON p.author_id = a.id
           WHERE p.deleted_at IS NULL AND p.community_id IS NULL
           UNION ALL
           -- Collabs reach every co-author's followers (and the co-authors), still only where they can see them.
           SELECT p.id, p.created_at, NULL::uuid FROM people a JOIN post_collaborators pc ON pc.user_id = a.id JOIN posts p ON p.id = pc.post_id
           WHERE pc.status = 'accepted' AND p.community_id IS NULL
           UNION ALL
           SELECT r.post_id, r.created_at, r.user_id FROM followed a JOIN post_reposts r ON r.user_id = a.id
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
      const reasons = new Map<string, FeedReason>(page.filter((r) => r.by).map((r) => [r.id as string, { code: 'reposted', params: { name: r.by_name } }]));
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
   * For you, ranked by the recommender (lib/ranking.ts, docs/product/recommendations.md): your
   * connections, what you engage with and what people like you engage with, your interests and
   * feedback, quality, momentum and freshness, with room for new creators, no more than a few
   * posts in a row from one creator or topic, and a clear end of feed. With Personalization off
   * it's the same for everyone (quality, momentum, freshness); your own filters still apply, and
   * so does who may see what. "Fewer suggestions" keeps it to your connections and communities.
   */
  async function rankedFeed(userId: string, cursor: string | undefined, limit: number, personal: string, reduced: boolean, personalized: boolean) {
    const ranked = await rankedPage(db, { userId, surface: 'for_you', personalized, personal, reduced }, cursor, limit);
    return {
      mode: 'for_you',
      items: await hydratePosts(
        db,
        ranked.items.map((r) => r.id),
        userId,
        new Map(ranked.items.map((r) => [r.id, r.reason])),
      ),
      nextCursor: ranked.nextCursor,
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
    // Feedback teaches the recommender too (with Personalization on): the post's topics and creator, or what you muted.
    const s = input.signal;
    if (s === 'mute_creator') await learnQuietly(learn(db, u.id, [{ signal: s, authorId }]), req.log);
    else if (s === 'mute_topic') await learnQuietly(learn(db, u.id, [{ signal: s, topics: [input.topic!] }]), req.log);
    else if (input.postId) await learnQuietly(learnFromPost(db, u.id, input.postId, s), req.log);
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
        EXISTS (SELECT 1 FROM community_members cm WHERE cm.community_id = p.community_id AND cm.user_id = $1) AS member,
        -- What the recommender learned (lib/affinity.ts), as of now.
        coalesce((SELECT ${fadedScoreSql('a', 'now()')} FROM user_creator_affinity a WHERE a.user_id = $1 AND a.author_id = p.author_id), 0) AS creator_aff,
        ARRAY(SELECT a.topic FROM user_topic_affinity a WHERE ${UNLOCKED} AND a.user_id = $1 AND a.topic = ANY(p.topics)
                AND ${fadedScoreSql('a', 'now()')} >= ${RANKING.likedTopicReason} ORDER BY a.score DESC) AS learned,
        -- Someone who liked or saved it also liked or saved something you did in the last 30 days.
        EXISTS (SELECT 1 FROM (SELECT r.user_id FROM reactions r WHERE r.post_id = p.id UNION SELECT s.user_id FROM saves s WHERE s.post_id = p.id) other
                WHERE other.user_id <> $1
                  AND NOT EXISTS (SELECT 1 FROM consents cs WHERE cs.user_id = other.user_id AND cs.purpose = 'personalization' AND NOT cs.granted)
                  AND EXISTS (SELECT 1 FROM (SELECT r.post_id FROM reactions r WHERE r.user_id = $1 AND r.created_at > now() - interval '30 days'
                                             UNION SELECT s.post_id FROM saves s WHERE s.user_id = $1 AND s.created_at > now() - interval '30 days') m
                              WHERE m.post_id <> p.id
                                AND (EXISTS (SELECT 1 FROM reactions r2 WHERE r2.post_id = m.post_id AND r2.user_id = other.user_id)
                                     OR EXISTS (SELECT 1 FROM saves s2 WHERE s2.post_id = m.post_id AND s2.user_id = other.user_id)))) AS alike,
        (SELECT ${trendSql('now()')} FROM post_stats ps WHERE ps.post_id = p.id) AS trend,
        (pu.created_at > now() - make_interval(days => ${RANKING.exploration.newCreatorDays})
         OR (SELECT count(*) FROM (SELECT 1 FROM posts p3 WHERE p3.author_id = p.author_id AND p3.deleted_at IS NULL AND p3.status = 'published'
                                   LIMIT ${RANKING.exploration.newCreatorPosts}) z) < ${RANKING.exploration.newCreatorPosts}) AS new_creator
       FROM posts p JOIN profiles pr ON pr.user_id = p.author_id JOIN users pu ON pu.id = p.author_id LEFT JOIN communities c ON c.id = p.community_id WHERE p.id = $2`,
      [u.id, id],
    );
    const r = rows[0];
    const details: WhyReason[] = [];
    // Each line as a code the apps put into words, and in English for older apps.
    const answer = (controls: string[]): PostWhy => ({ reasons: details.map((d) => whyReasonText(d, ENGLISH_REASONS)), details, controls });
    if (!(await personalizationAllowed(db, u.id))) {
      details.push({ code: 'personalization_off' });
      return answer(['not_interested', 'mute_topic', 'mute_creator']);
    }
    if (r.friend) details.push({ code: 'friend', params: { name: r.display_name } });
    else if (r.followed) details.push({ code: 'follow', params: { name: r.display_name } });
    if (r.member) details.push({ code: 'community', params: { community: r.community } });
    if (r.matched.length) details.push({ code: 'topics', params: { topics: r.matched } });
    const close = r.friend || r.followed;
    if (!close && r.creator_aff >= RANKING.likedCreatorReason) details.push({ code: 'learned_creator', params: { name: r.display_name } });
    const learned = (r.learned as string[]).filter((t) => !r.matched.includes(t));
    if (learned.length) details.push({ code: 'learned_topics', params: { topics: learned } });
    if (r.alike) details.push({ code: 'similar_people' });
    if ((r.trend ?? 0) >= RANKING.trendingReason) details.push({ code: 'trending' });
    if (r.like_count + r.comment_count > 5) details.push({ code: 'engagement' });
    if (!close && !r.member && r.new_creator) details.push({ code: 'new_creator' });
    if (!details.length) details.push({ code: 'fallback' });
    return answer(['more_like_this', 'less_like_this', 'not_interested', 'mute_topic', 'mute_creator']);
  });

  // ── Reactions, saves, polls ───────────────────────────────────────────
  /** A post's like count for the viewer: left out when its author hid it (and the viewer isn't the author). */
  async function likesFor(id: string, viewer: string): Promise<{ likes?: number }> {
    const r = (
      await db.query(
        `SELECT p.like_count, coalesce(p.hide_counts, pr.hide_counts) AND p.author_id <> $2 AS hidden FROM posts p JOIN profiles pr ON pr.user_id = p.author_id WHERE p.id = $1`,
        [id, viewer],
      )
    ).rows[0];
    return !r ? { likes: 0 } : r.hidden ? {} : { likes: r.like_count as number };
  }

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
      // What you like teaches the recommender (with Personalization on), and the post's momentum goes up.
      await bumpStats(db, [{ postId: id, trend: TREND.weights.like }]);
      await learnQuietly(learnFromPost(db, u.id, id, 'like'), req.log);
      // Passing 100, 1,000… likes tells the author once.
      await checkMilestones(db, ctx.realtime, [id], 'likes');
    }
    return { liked: true, ...(await likesFor(id, u.id)) };
  });

  app.delete('/v1/posts/:id/reaction', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const removed = await tx(db, async (c) => {
      const r = await c.query(`DELETE FROM reactions WHERE post_id = $1 AND user_id = $2`, [id, u.id]);
      if (r.rowCount) await c.query(`UPDATE posts SET like_count = greatest(like_count - 1, 0) WHERE id = $1`, [id]);
      return !!r.rowCount;
    });
    if (removed) await learnQuietly(learnFromPost(db, u.id, id, 'unlike'), req.log);
    return { liked: false, ...(await likesFor(id, u.id)) };
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
      // A repost is a share: it counts for the post and teaches the recommender.
      await bumpStats(db, [{ postId: id, shares: 1, trend: TREND.weights.share }]);
      await learnQuietly(learnFromPost(db, u.id, id, 'share'), req.log);
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

  /**
   * Who reposted a post, newest first, for anyone who can see it. Private accounts appear only to
   * people who follow them (and to themselves); blocked people never appear.
   */
  app.get('/v1/posts/:id/reposters', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const viewer = req.user?.id ?? null;
    const { id } = parse(idParam, req.params);
    const q = parse(pageQuerySchema, req.query);
    await assertVisible(id, viewer);
    const c = decodeCursor<KeyCursor>(q.cursor);
    const { rows } = await db.query(
      `SELECT r.user_id AS uid, r.created_at, pr.username, pr.display_name, pr.avatar_url, pr.mode, ${plusCol('')}
       FROM post_reposts r JOIN profiles pr ON pr.user_id = r.user_id JOIN users u ON u.id = r.user_id
       WHERE r.post_id = $2 AND u.status = 'active' AND ${notBlockedSql('r.user_id', '$1')}
         AND (NOT pr.is_private OR r.user_id = $1 OR EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followee_id = r.user_id))
         ${c ? 'AND (r.created_at, r.user_id) < ($4::timestamptz, $5::uuid)' : ''}
       ORDER BY r.created_at DESC, r.user_id DESC LIMIT $3`,
      c ? [viewer, id, q.limit + 1, c.t, c.id] : [viewer, id, q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    return {
      items: page.map((r) => publicUserFrom({ ...r, id: r.uid }, '')),
      nextCursor: rows.length > q.limit ? keyCursorOf({ created_at: page.at(-1)!.created_at, id: page.at(-1)!.uid }) : null,
    };
  });

  /**
   * A person's reposts, newest first (what they chose to share). A private account's reposts are
   * for the people who can see that profile (the account and its followers); others get `hidden`.
   */
  app.get('/v1/users/:id/reposts', async (req) => {
    const viewer = req.user?.id ?? null;
    const { id } = parse(idParam, req.params);
    const q = parse(pageQuerySchema, req.query);
    const c = decodeCursor<KeyCursor>(q.cursor);
    const owner = (
      await db.query(
        `SELECT pr.is_private, (pr.user_id = $2 OR EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $2 AND f.followee_id = pr.user_id)) AS sees
         FROM profiles pr JOIN users u ON u.id = pr.user_id WHERE pr.user_id = $1 AND u.status = 'active' AND ${notBlockedSql('pr.user_id', '$2')}`,
        [id, viewer],
      )
    ).rows[0];
    if (!owner) throw notFound('That profile');
    if (owner.is_private && !owner.sees) return { items: [], nextCursor: null, hidden: true };
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
    const r = await db.query(`INSERT INTO saves (post_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, me(req).id]);
    if (r.rowCount) {
      await bumpStats(db, [{ postId: id, saves: 1, trend: TREND.weights.save }]);
      await learnQuietly(learnFromPost(db, me(req).id, id, 'save'), req.log);
    }
    return { saved: true };
  });

  /** Unsave: the post also comes off the boards you own (boards are made of your saves). Other people's shared boards keep it. */
  app.delete('/v1/posts/:id/save', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    const u = me(req);
    const unsaved = await tx(db, async (c) => {
      const r = await c.query(`DELETE FROM saves WHERE post_id = $1 AND user_id = $2`, [id, u.id]);
      await c.query(`DELETE FROM board_items bi USING boards bd WHERE bi.board_id = bd.id AND bd.owner_id = $2 AND bi.post_id = $1`, [id, u.id]);
      return !!r.rowCount;
    });
    if (unsaved) {
      await bumpStats(db, [{ postId: id, saves: -1 }]);
      await learnQuietly(learnFromPost(db, u.id, id, 'unsave'), req.log);
    }
    return { saved: false };
  });

  /**
   * Everything you saved, posts and reels, newest save first, with your private notes. `filter`
   * narrows to photos, videos (reels and posts with a video) or text. Only posts you can still
   * see; subscriber-only posts you can no longer open come back locked.
   */
  app.get('/v1/me/saved', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const q = parse(pageQuerySchema.extend({ filter: z.enum(SAVED_FILTERS).default('all') }), req.query);
    const c = decodeCursor<KeyCursor>(q.cursor);
    const params: unknown[] = [u.id, q.limit + 1];
    if (c) params.push(c.t, c.id);
    const { rows } = await db.query(
      `SELECT p.id, s.created_at ${POST_FROM} JOIN saves s ON s.post_id = p.id AND s.user_id = $1
       WHERE ${VISIBLE} AND ${savedFilterSql(q.filter)}
         ${c ? 'AND (s.created_at, p.id) < ($3::timestamptz, $4::uuid)' : ''}
       ORDER BY s.created_at DESC, p.id DESC LIMIT $2`,
      params,
    );
    const page = rows.slice(0, q.limit);
    const items = await hydratePosts(
      db,
      page.map((r) => r.id),
      u.id,
    );
    await attachSaveNotes(db, items, u.id);
    return { items, nextCursor: rows.length > q.limit ? keyCursorOf(page.at(-1)!) : null };
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
}
