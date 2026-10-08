import type { FastifyInstance } from 'fastify';
import { tx } from '@yapilapi/database';
import { askCitySchema, askDefaultExpiry, askHelperSchema, askListSchema, createPostSchema, pageQuerySchema } from '@yapilapi/shared';
import { z } from 'zod';
import type { AppContext } from '../lib/context.ts';
import { decodeCursor, encodeCursor } from '../lib/cursor.ts';
import { badRequest, featureDisabled, notFound, parse } from '../lib/errors.ts';
import { hydratePosts } from '../lib/posts.ts';
import { announcePost, moderationNotice, recordFlags, screenPost, writePost } from '../lib/publishing.ts';
import { isEnabled, track } from '../lib/services.ts';
import { assertYapPace } from '../lib/voice.ts';
import { enqueue } from '../lib/jobs.ts';
import { safeZone } from '../lib/city-map.ts';
import {
  ASK_NOTIFY_JOB,
  assertAskPace,
  asksAboutSomeone,
  expiryOf,
  helperSettings,
  homeCity,
  listQuestions,
  markHelpful,
  myQuestions,
  notifyNearby,
  resolveArea,
  setHelperSettings,
  unmarkHelpful,
  writeQuestion,
} from '../lib/ask-city.ts';
import { me, requireAuth } from '../plugins/auth.ts';

const helpfulParams = z.object({ id: z.string().uuid(), commentId: z.string().uuid() });

/** An offset cursor ({ o }): lists here are short and change as answers come in. */
function offsetOf(cursor: string | undefined): number {
  const c = decodeCursor<{ o?: unknown }>(cursor);
  if (!c) return 0;
  if (typeof c.o !== 'number' || !Number.isInteger(c.o) || c.o < 0 || c.o > 10_000) throw badRequest('Invalid cursor.');
  return c.o;
}

/**
 * Ask the city (docs/product/ask-the-city.md, lib/ask-city.ts): ask people nearby, list open
 * questions near you, mark helpful answers, and "Help answer questions near me". Behind ASK_CITY.
 * Answers are comments (POST /v1/posts/:id/comments, with `voiceId` for a spoken one).
 */
export default async function askCityModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;
  const on = async () => {
    if (!(await isEnabled(db, 'ASK_CITY'))) throw featureDisabled('Ask the city');
  };

  ctx.jobs[ASK_NOTIFY_JOB] = async ({ postId, tries }: { postId: string; tries?: number }) => {
    await notifyNearby(ctx, postId, tries ?? 0);
  };

  /**
   * Ask a question: spoken (`voiceId`, a clip recorded for a Yap) or written, about a place, a city
   * or the part of the map on screen, with a topic and, when it's about now, an end. It's a post
   * for everyone and goes through every check a post does; at most ASK_PER_DAY a day.
   */
  app.post('/v1/ask', { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    await on();
    const u = me(req);
    const input = parse(askCitySchema, req.body);
    if (asksAboutSomeone(input.body)) throw badRequest('Ask about places and things, not where someone lives.');
    await assertAskPace(db, u.id);
    let media: { id: string; url: string; kind: 'audio' }[] = [];
    if (input.voiceId) {
      const clip = await db.query<{ url: string }>(`SELECT m.url FROM media m JOIN voice_clips vc ON vc.media_id = m.id WHERE m.id = $1 AND vc.owner_id = $2`, [
        input.voiceId,
        u.id,
      ]);
      if (!clip.rows[0]) throw notFound('That recording');
      media = [{ id: input.voiceId, url: clip.rows[0].url, kind: 'audio' }];
      await assertYapPace(db, u.id);
    }
    const area = await resolveArea(db, u.id, input.area);
    const expiresAt = await expiryOf(db, input.expires === undefined ? askDefaultExpiry(input.topic) : input.expires, safeZone(input.timeZone));
    const post = parse(createPostSchema, {
      body: input.body,
      visibility: 'public',
      format: input.voiceId ? 'yap' : 'post',
      media,
      ...(area.placeId ? { placeId: area.placeId } : {}),
    });
    const screening = await screenPost(db, ctx.config, u.id, { body: post.body, pollText: '', visibility: 'public', communityId: null });
    let limitedNow = false;
    const written = await tx(db, async (c) => {
      const w = await writePost(c, u.id, post, { state: 'published', moderationStatus: screening.status });
      await writeQuestion(c, w.id, u.id, input.topic, area, expiresAt);
      limitedNow = await recordFlags(c, ctx.realtime, u.id, w.id, screening);
      return w;
    });
    await announcePost(ctx, {
      postId: written.id,
      authorId: u.id,
      kind: written.kind,
      visibility: 'public',
      communityId: null,
      body: post.body,
      status: screening.status,
      taggedIds: written.taggedIds,
      collaborators: [],
      remixAuthor: null,
      remixOf: null,
      remixMode: null,
    });
    // People who help answer here hear about it once it's cleared (a spoken one once its words pass).
    await enqueue(db, ASK_NOTIFY_JOB, { postId: written.id });
    track(db, u.id, 'ask_city_asked', { topic: input.topic, voice: !!input.voiceId, place: !!area.placeId });
    reply.code(201);
    const [created] = await hydratePosts(db, [written.id], u.id);
    return { post: created, moderation: moderationNotice(screening, limitedNow) };
  });

  /**
   * Open questions near you: in a city (or the one you help in, or your profile's), or with their
   * area in a box on the map; those still waiting for an answer first, then the newest. `city` in
   * the answer is the city listed (null when there's none to go by).
   */
  app.get('/v1/ask', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    await on();
    const viewer = me(req).id;
    const q = parse(askListSchema, req.query);
    const box =
      q.south !== undefined && q.west !== undefined && q.north !== undefined && q.east !== undefined
        ? { south: q.south, west: q.west, north: q.north, east: q.east }
        : null;
    if (box && (box.north <= box.south || box.east <= box.west)) throw badRequest('That place isn’t on the map.');
    const city = box ? null : (q.city ?? (await homeCity(db, viewer)));
    if (!box && !city) return { city: null, items: [], nextCursor: null };
    const offset = offsetOf(q.cursor);
    const ids = await listQuestions(db, { viewer, city, box, topic: q.topic, offset, limit: q.limit });
    return {
      city,
      items: await hydratePosts(db, ids.slice(0, q.limit), viewer),
      nextCursor: ids.length > q.limit ? encodeCursor({ o: offset + q.limit }) : null,
    };
  });

  /** Your questions, open or closed, newest first. */
  app.get('/v1/ask/mine', { preHandler: requireAuth }, async (req) => {
    await on();
    const u = me(req);
    const q = parse(pageQuerySchema, req.query);
    const offset = offsetOf(q.cursor);
    const ids = await myQuestions(db, u.id, offset, q.limit);
    return {
      items: await hydratePosts(db, ids.slice(0, q.limit), u.id),
      nextCursor: ids.length > q.limit ? encodeCursor({ o: offset + q.limit }) : null,
    };
  });

  /** The asker marks an answer (a comment under their question, by someone else) helpful. */
  app.put('/v1/ask/:id/helpful/:commentId', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    await on();
    const { id, commentId } = parse(helpfulParams, req.params);
    await markHelpful(ctx, me(req).id, id, commentId);
    return { helpful: true };
  });

  app.delete('/v1/ask/:id/helpful/:commentId', { preHandler: requireAuth }, async (req) => {
    await on();
    const { id, commentId } = parse(helpfulParams, req.params);
    await unmarkHelpful(db, me(req).id, id, commentId);
    return { helpful: false };
  });

  /** "Help answer questions near me": off by default. */
  app.get('/v1/me/ask-settings', { preHandler: requireAuth }, async (req) => {
    await on();
    return { settings: await helperSettings(db, me(req).id) };
  });

  app.put('/v1/me/ask-settings', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    await on();
    const input = parse(askHelperSchema, req.body);
    return { settings: await setHelperSettings(db, me(req).id, input) };
  });
}
