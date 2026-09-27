import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createMomentSchema, pollPercents, reshareMomentSchema } from '@yapilapi/shared';
import { z } from 'zod';
import { AppError, conflict, forbidden, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { analyzeText } from '../lib/moderation.ts';
import { MEDIA_BLOCKED_MESSAGE } from '../lib/media-moderation.ts';
import { assertRecapUse } from '../lib/recap-sharing.ts';
import { notify, track } from '../lib/services.ts';
import { isStoredMediaUrl } from '../lib/storage.ts';
import { plusCol, publicUserFrom } from '../lib/users.ts';
import { notBlockedSql } from '../lib/visibility.ts';
import {
  groupStories,
  notifyStoryMentions,
  prepareStory,
  STORY_FROM,
  STORY_SELECT,
  stickerResults,
  storyVisibleSql,
  type StoredMusic,
  type StoredSticker,
} from '../lib/stories.ts';
import { me, requireAuth } from '../plugins/auth.ts';
import { langOf } from '../lib/translation.ts';

/** Stories in the strip: your own and your people's (see storyVisibleSql). */
const STORY_VISIBLE = storyVisibleSql('$1');
/** Stories you can open: those, and public stories from accounts that aren't private. */
const STORY_OPEN = storyVisibleSql('$1', { open: true });

type Found = {
  id: string;
  author_id: string;
  body: string;
  visibility: string;
  stickers: StoredSticker[];
  mentions: string[];
  reshare_of: string | null;
  allow_reshare: boolean;
  author_name: string;
};

const hoursFor = (expiresIn: string, customHours?: number) =>
  expiresIn === '1h' ? 1 : expiresIn === '24h' ? 24 : expiresIn === 'custom' ? (customHours ?? 24) : null;

/**
 * Stories (called moments in the API): short-lived photos, videos or text
 * (1h, 24h, custom or permanent) shown to your people, with views, likes and
 * replies that arrive as a direct message. Stories can carry @mentions,
 * #hashtags and interactive stickers, be sent to a chat as a story card, and be
 * reshared into your own story (public ones, or ones that mention you).
 */
export default async function momentsModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;
  const idParam = z.object({ id: z.string().uuid() });
  const userParam = z.object({ userId: z.string().uuid() });

  /** A story the viewer can open (see storyVisibleSql). */
  async function visibleStory(id: string, viewer: string): Promise<Found> {
    const { rows } = await db.query(
      `SELECT m.id, m.author_id, m.body, m.visibility, m.stickers, m.mentions, m.reshare_of, m.allow_reshare, pr.display_name AS author_name
       FROM moments m JOIN users au ON au.id = m.author_id JOIN profiles pr ON pr.user_id = m.author_id
       WHERE m.id = $2 AND ${STORY_OPEN}`,
      [viewer, id],
    );
    if (!rows[0]) throw notFound('Story');
    return rows[0] as Found;
  }

  /** Store a new story (with its stickers, tags and mentions) and tell the people it mentions who can see it. */
  async function createStory(
    authorId: string,
    input: {
      body: string;
      mediaUrl: string | null;
      mediaKind: string | null;
      mediaId: string | null;
      visibility: string;
      locationText: string | null;
      hours: number | null;
      stickers: Parameters<typeof prepareStory>[3];
      allowReshare: boolean;
      reshareOf?: string;
      music?: { soundId: string | null; trackId: string | null; stored: StoredMusic } | null;
    },
  ) {
    if (analyzeText(input.body).risk !== 'normal') throw new AppError(422, 'content_blocked', "This story can't be shared.");
    const prepared = await prepareStory(db, authorId, input.body, input.stickers);
    const { rows } = await db.query(
      `INSERT INTO moments (author_id, body, media_url, media_kind, media_id, visibility, location_text, expires_at, stickers, tags, mentions, reshare_of, allow_reshare,
                            sound_id, music, lang, music_track_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $8::int IS NULL THEN NULL ELSE now() + make_interval(hours => $8::int) END, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       RETURNING id, expires_at, created_at, tags`,
      [
        authorId,
        input.body,
        input.mediaUrl,
        input.mediaKind,
        input.mediaId,
        input.visibility,
        input.locationText,
        input.hours,
        JSON.stringify(prepared.stickers),
        prepared.tags,
        prepared.mentionIds,
        input.reshareOf ?? null,
        input.allowReshare,
        input.music?.soundId ?? null,
        input.music ? JSON.stringify(input.music.stored) : null,
        langOf(input.body),
        input.music?.trackId ?? null,
      ],
    );
    const moment = rows[0] as { id: string; expires_at: Date | null; created_at: Date; tags: string[] };
    await notifyStoryMentions(db, ctx.realtime, { storyId: moment.id, actorId: authorId, userIds: prepared.mentionIds });
    return moment;
  }

  /**
   * Check music for a new story: a sound the author may use (the same rules as for reels), or a
   * catalogue song whose licence allows it (checked with its provider now), and a part that starts
   * inside it. Photo, text and video stories only (on a video it replaces the video's own sound; the
   * two are not mixed).
   */
  async function storyMusic(
    authorId: string,
    m: NonNullable<ReturnType<typeof createMomentSchema.parse>['music']>,
    mediaKind: string | null,
  ): Promise<{ soundId: string | null; trackId: string | null; stored: StoredMusic }> {
    if (mediaKind === 'audio') throw new AppError(400, 'validation_failed', 'Music can be added to photo, video and text stories.');
    const prepared = await ctx.music.prepareUse(authorId, m, 'stories');
    return { soundId: prepared.soundId, trackId: prepared.trackId, stored: { ...prepared.stored, style: m.style, x: m.x, y: m.y } };
  }

  app.post('/v1/moments', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    const input = parse(createMomentSchema, req.body);
    let mediaUrl = input.mediaUrl ?? null;
    let mediaKind = input.mediaKind ?? null;
    if (input.mediaId) {
      // Only your own upload; its URL and kind come from the stored item, not the request.
      const m = (await db.query(`SELECT url, kind, moderation FROM media WHERE id = $1 AND owner_id = $2 AND NOT private`, [input.mediaId, u.id])).rows[0];
      if (!m) throw notFound('That photo or video');
      if (m.moderation === 'blocked') throw new AppError(422, 'media_blocked', MEDIA_BLOCKED_MESSAGE);
      // A recap video goes in a story only when everything in it is yours.
      await assertRecapUse(db, u.id, [input.mediaId], 'story');
      mediaUrl = m.url;
      mediaKind = m.kind;
    } else if (mediaUrl && isStoredMediaUrl(mediaUrl)) {
      // A file stored here goes in by its id, so who owns it and where it may go are checked (a recap, someone else's photo).
      throw new AppError(400, 'validation_failed', 'Add photos and videos uploaded here by their id.');
    }
    if (!input.body && !mediaUrl && !input.stickers.length && !input.music)
      throw new AppError(400, 'validation_failed', 'Add text, a photo or a video to your story.');
    const music = input.music ? await storyMusic(u.id, input.music, mediaKind) : null;
    const moment = await createStory(u.id, {
      body: input.body,
      mediaUrl,
      mediaKind,
      mediaId: input.mediaId ?? null,
      visibility: input.visibility,
      locationText: input.locationText ?? null,
      hours: hoursFor(input.expiresIn, input.customHours),
      stickers: input.stickers,
      allowReshare: input.allowReshare,
      music,
    });
    track(db, u.id, 'moment_created', { expiresIn: input.expiresIn, stickers: input.stickers.length, music: !!music });
    reply.code(201);
    return { moment };
  });

  /**
   * Active stories grouped by author: yours first, then people with stories you
   * haven't seen, newest first. Each story says whether you've seen and liked
   * it; your own carry their view count.
   */
  app.get('/v1/moments', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { rows } = await db.query(`SELECT ${STORY_SELECT} ${STORY_FROM} WHERE ${STORY_VISIBLE} ORDER BY m.created_at ASC LIMIT 300`, [u.id]);
    return { items: await groupStories(db, rows, u.id) };
  });

  /** One story, as a group of one: for a link, a story card or a notification. */
  app.get('/v1/moments/:id', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { rows } = await db.query(`SELECT ${STORY_SELECT} ${STORY_FROM} WHERE m.id = $2 AND ${STORY_OPEN}`, [u.id, id]);
    if (!rows[0]) throw notFound('Story');
    const [group] = await groupStories(db, rows, u.id);
    return { group };
  });

  /** Your own story's settings: whether other people may reshare it. */
  app.patch('/v1/moments/:id', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { allowReshare } = parse(z.object({ allowReshare: z.boolean() }), req.body);
    const r = await db.query(`UPDATE moments SET allow_reshare = $3 WHERE id = $1 AND author_id = $2 AND deleted_at IS NULL RETURNING allow_reshare`, [
      id,
      u.id,
      allowReshare,
    ]);
    if (!r.rowCount) throw notFound('Story');
    return { allowReshare: r.rows[0].allow_reshare as boolean };
  });

  /**
   * Add someone else's story to yours. Allowed for public stories and for
   * stories that mention you, unless the author turned resharing off. Your
   * story shows the original as a card credited to its author, which opens
   * only for people who can see the original. The author is told.
   */
  app.post('/v1/moments/:id/reshare', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(reshareMomentSchema, req.body);
    const s = await visibleStory(id, u.id);
    if (s.author_id === u.id) throw new AppError(400, 'validation_failed', "You can't reshare your own story.");
    if (s.reshare_of) throw new AppError(400, 'validation_failed', 'Open the original story to reshare it.');
    if (!s.allow_reshare) throw new AppError(403, 'reshare_off', `${s.author_name} turned off resharing for this story.`);
    if (s.visibility !== 'public' && !s.mentions.includes(u.id))
      throw new AppError(403, 'reshare_not_allowed', 'You can reshare public stories, and stories you’re mentioned in.');
    const moment = await createStory(u.id, {
      body: input.body,
      mediaUrl: null,
      mediaKind: null,
      mediaId: null,
      visibility: input.visibility,
      locationText: null,
      hours: hoursFor(input.expiresIn),
      stickers: input.stickers,
      allowReshare: false,
      reshareOf: s.id,
    });
    await notify(db, ctx.realtime, { userId: s.author_id, category: 'friends', type: 'story_reshare', actorId: u.id, entityType: 'moment', entityId: s.id });
    track(db, u.id, 'moment_reshared', {});
    reply.code(201);
    return { moment };
  });

  /**
   * Send a story to people or conversations as a message with a story card.
   * Sent through the messaging endpoints as you, so blocks, minor protection
   * and family settings apply as for any message. The card opens only for
   * people who can see the story.
   */
  app.post('/v1/moments/:id/send', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(
      z
        .object({
          userIds: z.array(z.string().uuid()).max(20).default([]),
          conversationIds: z.array(z.string().uuid()).max(20).default([]),
          body: z.string().trim().max(1000).default(''),
        })
        .refine((v) => v.userIds.length + v.conversationIds.length > 0, { message: 'Choose someone to send it to.', path: ['userIds'] }),
      req.body,
    );
    await visibleStory(id, u.id);
    const asSender = asSameUser(req);
    const targets = [...new Set(input.conversationIds)];
    const failed: { id: string; message: string }[] = [];
    for (const userId of new Set(input.userIds.filter((x) => x !== u.id))) {
      const convo = await app.inject({ method: 'POST', url: '/v1/conversations', headers: asSender, payload: { memberIds: [userId] } });
      if (convo.statusCode >= 300) failed.push({ id: userId, message: convo.json().error?.message ?? 'Not sent.' });
      else targets.push(convo.json().conversation.id as string);
    }
    const sent: string[] = [];
    for (const conversationId of new Set(targets)) {
      const r = await app.inject({
        method: 'POST',
        url: `/v1/conversations/${conversationId}/messages`,
        headers: asSender,
        payload: { body: input.body, storyId: id, clientId: `story-share-${id.slice(0, 8)}-${conversationId.slice(0, 8)}-${Date.now()}` },
      });
      if (r.statusCode >= 300) failed.push({ id: conversationId, message: r.json().error?.message ?? 'Not sent.' });
      else sent.push(conversationId);
    }
    if (!sent.length) throw new AppError(403, 'not_sent', failed[0]?.message ?? 'Not sent.');
    track(db, u.id, 'moment_sent', { to: sent.length });
    reply.code(201);
    return { conversationIds: sent, failed };
  });

  // ── Interactive stickers ──────────────────────────────────────────────
  const stickerParam = z.object({ id: z.string().uuid(), stickerId: z.string().min(1).max(40) });
  async function stickerOn<T extends StoredSticker['type']>(id: string, stickerId: string, viewer: string, type: T) {
    const story = await visibleStory(id, viewer);
    const sticker = story.stickers.find((x) => x.id === stickerId && x.type === type) as Extract<StoredSticker, { type: T }> | undefined;
    if (!sticker) throw notFound('That sticker');
    return { story, sticker };
  }
  const ONCE = `ON CONFLICT (moment_id, sticker_id, user_id) WHERE kind IN ('poll','slider','reminder') DO NOTHING`;

  /** Vote in a poll, once. The results come back with your vote. */
  app.post(
    '/v1/moments/:id/stickers/:stickerId/vote',
    { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req) => {
      const u = me(req);
      const { id, stickerId } = parse(stickerParam, req.params);
      const { option } = parse(z.object({ option: z.union([z.literal(0), z.literal(1)]) }), req.body);
      const { story } = await stickerOn(id, stickerId, u.id, 'poll');
      if (story.author_id === u.id) throw new AppError(400, 'validation_failed', "You can't vote in your own poll.");
      const r = await db.query(`INSERT INTO story_responses (moment_id, sticker_id, user_id, kind, choice) VALUES ($1,$2,$3,'poll',$4) ${ONCE}`, [
        id,
        stickerId,
        u.id,
        option,
      ]);
      if (!r.rowCount) throw conflict('You already voted in this poll.');
      const { rows } = await db.query(
        `SELECT choice, count(*)::int AS n FROM story_responses WHERE moment_id = $1 AND sticker_id = $2 AND kind = 'poll' GROUP BY 1`,
        [id, stickerId],
      );
      const counts: [number, number] = [0, 0];
      for (const x of rows) counts[x.choice as 0 | 1] = x.n;
      return { voted: option, results: pollPercents(counts), votes: counts[0] + counts[1] };
    },
  );

  /** Answer a question sticker (up to 10 answers each). Only the author sees answers. */
  app.post(
    '/v1/moments/:id/stickers/:stickerId/answers',
    { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const u = me(req);
      const { id, stickerId } = parse(stickerParam, req.params);
      const { text } = parse(z.object({ text: z.string().trim().min(1).max(300) }), req.body);
      const { story } = await stickerOn(id, stickerId, u.id, 'question');
      if (story.author_id === u.id) throw new AppError(400, 'validation_failed', "You can't answer your own question.");
      if (analyzeText(text).risk !== 'normal') throw new AppError(422, 'content_blocked', "This answer can't be sent.");
      const n = await db.query(
        `SELECT count(*)::int AS n FROM story_responses WHERE moment_id = $1 AND sticker_id = $2 AND user_id = $3 AND kind = 'question'`,
        [id, stickerId, u.id],
      );
      if (n.rows[0].n >= 10) throw new AppError(400, 'validation_failed', 'You can send up to 10 answers to a question.');
      await db.query(`INSERT INTO story_responses (moment_id, sticker_id, user_id, kind, answer) VALUES ($1,$2,$3,'question',$4)`, [id, stickerId, u.id, text]);
      reply.code(201);
      return { answered: n.rows[0].n + 1 };
    },
  );

  /** Answer an emoji slider (0 to 1), once. The author sees the average. */
  app.post(
    '/v1/moments/:id/stickers/:stickerId/slide',
    { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req) => {
      const u = me(req);
      const { id, stickerId } = parse(stickerParam, req.params);
      const { value } = parse(z.object({ value: z.number().min(0).max(1) }), req.body);
      const { story } = await stickerOn(id, stickerId, u.id, 'slider');
      if (story.author_id === u.id) throw new AppError(400, 'validation_failed', "You can't answer your own slider.");
      const r = await db.query(`INSERT INTO story_responses (moment_id, sticker_id, user_id, kind, value) VALUES ($1,$2,$3,'slider',$4) ${ONCE}`, [
        id,
        stickerId,
        u.id,
        value,
      ]);
      if (!r.rowCount) throw conflict('You already answered this slider.');
      return { mine: value };
    },
  );

  /** "Remind me": a notification when the countdown ends. */
  app.put(
    '/v1/moments/:id/stickers/:stickerId/reminder',
    { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req) => {
      const u = me(req);
      const { id, stickerId } = parse(stickerParam, req.params);
      const { sticker } = await stickerOn(id, stickerId, u.id, 'countdown');
      if (new Date(sticker.endsAt).getTime() <= Date.now()) throw new AppError(400, 'validation_failed', 'This countdown has ended.');
      await db.query(`INSERT INTO story_responses (moment_id, sticker_id, user_id, kind, remind_at) VALUES ($1,$2,$3,'reminder',$4) ${ONCE}`, [
        id,
        stickerId,
        u.id,
        sticker.endsAt,
      ]);
      return { reminding: true };
    },
  );

  app.delete('/v1/moments/:id/stickers/:stickerId/reminder', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id, stickerId } = parse(stickerParam, req.params);
    await db.query(`DELETE FROM story_responses WHERE moment_id = $1 AND sticker_id = $2 AND user_id = $3 AND kind = 'reminder' AND notified_at IS NULL`, [
      id,
      stickerId,
      u.id,
    ]);
    return { reminding: false };
  });

  // ── Close friends ─────────────────────────────────────────────────────
  /** Your close friends list (people who follow you), most recently added first. */
  app.get('/v1/me/close-friends', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { rows } = await db.query(
      `SELECT cf.created_at, EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = cf.friend_id AND f.followee_id = $1) AS follows_you,
              pr.user_id AS a_id, pr.username AS a_username, pr.display_name AS a_display_name, pr.avatar_url AS a_avatar_url, pr.mode AS a_mode, ${plusCol('a_')}
       FROM close_friends cf JOIN profiles pr ON pr.user_id = cf.friend_id JOIN users fu ON fu.id = cf.friend_id
       WHERE cf.owner_id = $1 AND fu.status = 'active' AND ${notBlockedSql('cf.friend_id', '$1')}
       ORDER BY cf.created_at DESC LIMIT 1000`,
      [u.id],
    );
    return { items: rows.map((r) => ({ user: publicUserFrom(r, 'a_'), addedAt: r.created_at, followsYou: r.follows_you })) };
  });

  /** Add someone who follows you to your close friends. They aren't told. */
  app.put('/v1/me/close-friends/:userId', { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { userId } = parse(userParam, req.params);
    if (userId === u.id) throw new AppError(400, 'validation_failed', "You can't add yourself.");
    const follows = await db.query(
      `SELECT 1 FROM follows f JOIN users fu ON fu.id = f.follower_id
       WHERE f.follower_id = $2 AND f.followee_id = $1 AND fu.status = 'active' AND ${notBlockedSql('f.follower_id', '$1')}`,
      [u.id, userId],
    );
    if (!follows.rowCount) throw new AppError(400, 'validation_failed', 'Only people who follow you can be on your close friends list.');
    const count = await db.query(`SELECT count(*)::int AS n FROM close_friends WHERE owner_id = $1`, [u.id]);
    if (count.rows[0].n >= 1000) throw new AppError(400, 'validation_failed', 'Your close friends list is full.');
    await db.query(`INSERT INTO close_friends (owner_id, friend_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [u.id, userId]);
    return { closeFriend: true };
  });

  app.delete('/v1/me/close-friends/:userId', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { userId } = parse(userParam, req.params);
    await db.query(`DELETE FROM close_friends WHERE owner_id = $1 AND friend_id = $2`, [u.id, userId]);
    return { closeFriend: false };
  });

  app.post('/v1/moments/:id/view', { preHandler: requireAuth, config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const s = await visibleStory(id, u.id);
    if (s.author_id !== u.id) await db.query(`INSERT INTO moment_views (moment_id, viewer_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, u.id]);
    return { ok: true };
  });

  app.put('/v1/moments/:id/like', { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { liked } = parse(z.object({ liked: z.boolean() }), req.body);
    const s = await visibleStory(id, u.id);
    if (s.author_id === u.id) throw new AppError(400, 'validation_failed', "You can't like your own story.");
    await db.query(
      `INSERT INTO moment_views (moment_id, viewer_id, liked) VALUES ($1,$2,$3) ON CONFLICT (moment_id, viewer_id) DO UPDATE SET liked = EXCLUDED.liked`,
      [id, u.id, liked],
    );
    return { liked };
  });

  /**
   * Who saw your story (only yours), with who liked it, plus what people
   * answered on its stickers (poll results, slider average, question answers,
   * countdown reminders) and how many reshared it.
   */
  app.get('/v1/moments/:id/viewers', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const s = await visibleStory(id, u.id);
    if (s.author_id !== u.id) throw forbidden();
    const [viewers, results, reshares] = await Promise.all([
      db.query(
        `SELECT v.liked, v.viewed_at, pr.user_id AS a_id, pr.username AS a_username, pr.display_name AS a_display_name, pr.avatar_url AS a_avatar_url, pr.mode AS a_mode
         FROM moment_views v JOIN profiles pr ON pr.user_id = v.viewer_id
         WHERE v.moment_id = $1 AND ${notBlockedSql('v.viewer_id', '$2')} ORDER BY v.liked DESC, v.viewed_at DESC LIMIT 500`,
        [id, u.id],
      ),
      stickerResults(db, id, s.stickers, u.id),
      db.query(
        `SELECT count(*)::int AS n FROM moments m JOIN users au ON au.id = m.author_id
         WHERE m.reshare_of = $1 AND m.deleted_at IS NULL AND au.status = 'active' AND ${notBlockedSql('m.author_id', '$2')}`,
        [id, u.id],
      ),
    ]);
    return {
      items: viewers.rows.map((r) => ({ user: publicUserFrom(r, 'a_'), liked: r.liked, viewedAt: r.viewed_at })),
      results,
      reshares: reshares.rows[0].n as number,
      allowReshare: s.allow_reshare,
    };
  });

  /**
   * Reply to a story: it arrives in your direct conversation with the author.
   * Sent through the messaging endpoints as you, so blocks, minor protection
   * and family settings apply exactly as for any message.
   */
  app.post('/v1/moments/:id/reply', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { body } = parse(z.object({ body: z.string().trim().min(1).max(1000) }), req.body);
    const s = await visibleStory(id, u.id);
    if (s.author_id === u.id) throw new AppError(400, 'validation_failed', "You can't reply to your own story.");
    const asViewer = asSameUser(req);
    const convo = await app.inject({ method: 'POST', url: '/v1/conversations', headers: asViewer, payload: { memberIds: [s.author_id] } });
    if (convo.statusCode >= 300) return reply.code(convo.statusCode).send(convo.json());
    const conversationId = convo.json().conversation.id as string;
    const quote = s.body ? `“${s.body.slice(0, 80)}${s.body.length > 80 ? '…' : ''}”` : 'your story';
    const sent = await app.inject({
      method: 'POST',
      url: `/v1/conversations/${conversationId}/messages`,
      headers: asViewer,
      payload: { body: `Replied to ${quote}: ${body}`, clientId: `story-${id}-${Date.now()}` },
    });
    if (sent.statusCode >= 300) return reply.code(sent.statusCode).send(sent.json());
    reply.code(201);
    return { conversationId };
  });

  app.delete('/v1/moments/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    const r = await db.query(`UPDATE moments SET deleted_at = now() WHERE id = $1 AND author_id = $2 AND deleted_at IS NULL`, [id, me(req).id]);
    if (!r.rowCount) throw notFound('Story');
    return { ok: true };
  });
}

/** The caller's own credentials, for an internal call made on their behalf. */
function asSameUser(req: FastifyRequest): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (req.headers.authorization) h.authorization = req.headers.authorization;
  if (req.headers.cookie) h.cookie = req.headers.cookie;
  if (req.headers['x-csrf-token']) h['x-csrf-token'] = String(req.headers['x-csrf-token']);
  return h;
}
