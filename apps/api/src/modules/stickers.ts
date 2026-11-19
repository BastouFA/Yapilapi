import type { FastifyInstance } from 'fastify';
import { tx } from '@yapilapi/database';
import { STICKER_MAX, STICKER_MAX_BYTES, type Sticker } from '@yapilapi/shared';
import { z } from 'zod';
import { AppError, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { messageVisibleSql } from '../lib/chat.ts';
import { seesSensitiveMedia } from '../lib/interactions.ts';
import { enqueue } from '../lib/jobs.ts';
import { ALLOWED_MIME } from '../lib/storage.ts';
import { isBlockedEitherWay } from '../lib/users.ts';
import { me, requireAuth } from '../plugins/auth.ts';

const idParam = z.object({ id: z.string().uuid() });
const addBody = z.object({ mediaId: z.string().uuid() });
const saveBody = z.object({ messageId: z.string().uuid() });

const STICKER_COLS = `s.id, s.from_media_id, s.created_at, m.id AS media_id, m.url, m.variants->>'thumb' AS thumb_url, m.mime, m.width, m.height, m.size_bytes`;

function toSticker(r: Record<string, any>): Sticker {
  return {
    id: r.id,
    media: {
      id: r.media_id,
      url: r.url,
      thumbUrl: r.thumb_url ?? null,
      mime: r.mime ?? null,
      width: r.width ?? null,
      height: r.height ?? null,
      sizeBytes: r.size_bytes == null ? null : Number(r.size_bytes),
    },
    fromMediaId: r.from_media_id ?? null,
    createdAt: r.created_at.toISOString(),
  };
}

const limitError = () => new AppError(409, 'sticker_limit', 'You can keep up to 200 stickers. Remove one to add another.');

/**
 * Stickers in chats. Each person keeps up to STICKER_MAX: photos of their own they made into
 * stickers in the app (POST /v1/stickers with an upload), and stickers they saved from a chat
 * (POST /v1/stickers/save), which become a copy of their own, so they can send it on like any of
 * their photos. Sending one is a chat message with `sticker: true` (messaging.ts checks it's one
 * photo and no words). Removing a sticker takes it off your list; messages already sent keep it.
 */
export default async function stickersModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;

  async function one(ownerId: string, id: string): Promise<Sticker> {
    const { rows } = await db.query(`SELECT ${STICKER_COLS} FROM stickers s JOIN media m ON m.id = s.media_id WHERE s.id = $1 AND s.owner_id = $2`, [
      id,
      ownerId,
    ]);
    return toSticker(rows[0]);
  }

  /** Add a photo to someone's stickers, within the limit (counted under a lock, so two at once can't pass it). */
  async function keep(ownerId: string, mediaId: string, fromMediaId: string | null): Promise<string> {
    return tx(db, async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('stickers:' || $1))`, [ownerId]);
      const known = await c.query<{ id: string }>(`SELECT id FROM stickers WHERE owner_id = $1 AND (media_id = $2 OR from_media_id = $3)`, [
        ownerId,
        mediaId,
        fromMediaId,
      ]);
      if (known.rows[0]) return known.rows[0].id;
      const { rows } = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM stickers WHERE owner_id = $1`, [ownerId]);
      if (rows[0]!.n >= STICKER_MAX) throw limitError();
      const made = await c.query<{ id: string }>(`INSERT INTO stickers (owner_id, media_id, from_media_id) VALUES ($1,$2,$3) RETURNING id`, [
        ownerId,
        mediaId,
        fromMediaId,
      ]);
      return made.rows[0]!.id;
    });
  }

  /** A photo that can be a sticker: one that could be sent in a chat (not failed, removed, blocked or view once), and not too big. */
  function assertUsable(m: {
    kind: string;
    status: string;
    deleted_at: Date | null;
    private: boolean;
    for_watch: boolean;
    moderation: string;
    size_bytes: unknown;
  }) {
    if (m.kind !== 'image') throw new AppError(422, 'sticker_not_image', 'A sticker is made from a photo.');
    if (m.status === 'failed' || m.deleted_at || m.private || m.for_watch || m.moderation === 'blocked')
      throw new AppError(422, 'sticker_unavailable', 'This photo can’t be a sticker.');
    if (Number(m.size_bytes ?? 0) > STICKER_MAX_BYTES) throw new AppError(413, 'sticker_too_big', 'A sticker can be up to 5 MB.');
  }

  app.get('/v1/stickers', { preHandler: requireAuth, config: { rateLimit: { max: 600, timeWindow: '1 hour' } } }, async (req) => {
    const u = me(req);
    const { rows } = await db.query(
      `SELECT ${STICKER_COLS} FROM stickers s JOIN media m ON m.id = s.media_id
       WHERE s.owner_id = $1 AND m.deleted_at IS NULL AND m.moderation <> 'blocked' ORDER BY s.created_at DESC, s.id DESC LIMIT ${STICKER_MAX}`,
      [u.id],
    );
    return { items: rows.map(toSticker), max: STICKER_MAX };
  });

  // One of your own photos (made in the sticker maker and uploaded with POST /v1/media) becomes a sticker.
  app.post('/v1/stickers', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    const { mediaId } = parse(addBody, req.body);
    const m = (
      await db.query(`SELECT id, kind, status, deleted_at, private, for_watch, moderation, size_bytes FROM media WHERE id = $1 AND owner_id = $2`, [
        mediaId,
        u.id,
      ])
    ).rows[0];
    if (!m) throw notFound('Photo');
    assertUsable(m);
    const id = await keep(u.id, m.id, null);
    reply.code(201);
    return { sticker: await one(u.id, id) };
  });

  // A sticker someone sent in a chat you're in becomes one of yours: a copy of the file, so it stays
  // yours to send (and stays when they delete theirs).
  app.post('/v1/stickers/save', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    const { messageId } = parse(saveBody, req.body);
    const msg = (
      await db.query(
        `SELECT m.id, m.sender_id, m.attachments, m.meta, m.unsent_at FROM messages m
         JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $2 AND cm.left_at IS NULL
         WHERE m.id = $1 AND m.deleted_at IS NULL AND m.kind = 'message' AND ${messageVisibleSql('$2')}`,
        [messageId, u.id],
      )
    ).rows[0];
    if (!msg) throw notFound('Message');
    if (msg.sender_id !== u.id && (await isBlockedEitherWay(db, u.id, msg.sender_id))) throw notFound('Message');
    const attachments = (msg.attachments ?? []) as { mediaId?: string; kind?: string }[];
    const sourceId = attachments[0]?.mediaId;
    if (!msg.meta?.sticker || msg.unsent_at || attachments.length !== 1 || !sourceId) throw new AppError(422, 'not_a_sticker', 'That message isn’t a sticker.');
    const src = (
      await db.query(
        `SELECT id, owner_id, kind, status, deleted_at, private, for_watch, moderation, moderation_labels, moderation_provider, moderated_at,
                size_bytes, mime, width, height, alt_text, storage_key
         FROM media WHERE id = $1`,
        [sourceId],
      )
    ).rows[0];
    if (!src) throw new AppError(410, 'sticker_unavailable', 'This photo can’t be a sticker.');
    assertUsable(src);
    // Someone who isn't shown a sensitive photo can't keep it either.
    if (src.moderation === 'sensitive' && !(await seesSensitiveMedia(db, u.id)))
      throw new AppError(410, 'sticker_unavailable', 'This photo can’t be a sticker.');
    // Your own sticker, sent by you: it's already yours.
    if (src.owner_id === u.id) {
      const id = await keep(u.id, src.id, null);
      reply.code(201);
      return { sticker: await one(u.id, id) };
    }
    const known = await db.query<{ id: string }>(`SELECT id FROM stickers WHERE owner_id = $1 AND from_media_id = $2`, [u.id, src.id]);
    if (known.rows[0]) return { sticker: await one(u.id, known.rows[0].id) };
    const { rows: count } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM stickers WHERE owner_id = $1`, [u.id]);
    if (count[0]!.n >= STICKER_MAX) throw limitError();
    let bytes: Buffer;
    try {
      if (!src.storage_key) throw new Error('no stored file');
      bytes = await ctx.storage.read(src.storage_key);
    } catch (e) {
      req.log.warn({ err: (e as Error).message }, 'sticker copy failed');
      throw new AppError(410, 'sticker_unavailable', 'This photo can’t be a sticker.');
    }
    const mime = src.mime && ALLOWED_MIME[src.mime] ? src.mime : 'image/png';
    const stored = await ctx.storage.put(bytes, ALLOWED_MIME[mime]!.ext, mime);
    // The copy keeps the original's verdict: it's the same picture, checked once already (and again as it's processed).
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO media (owner_id, kind, url, mime, width, height, alt_text, status, storage_key, size_bytes, moderation, moderation_labels, moderation_provider, moderated_at)
       VALUES ($1,'image',$2,$3,$4,$5,$6,'ready',$7,$8,$9,$10,$11,$12) RETURNING id`,
      [
        u.id,
        stored.url,
        mime,
        src.width,
        src.height,
        src.alt_text,
        stored.key,
        bytes.length,
        src.moderation,
        JSON.stringify(src.moderation_labels ?? []),
        src.moderation_provider,
        src.moderated_at,
      ],
    );
    await enqueue(db, 'media.process', { mediaId: rows[0]!.id, filename: 'sticker' });
    const id = await keep(u.id, rows[0]!.id, src.id);
    reply.code(201);
    return { sticker: await one(u.id, id) };
  });

  app.delete('/v1/stickers/:id', { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 hour' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { rowCount } = await db.query(`DELETE FROM stickers WHERE id = $1 AND owner_id = $2`, [id, u.id]);
    if (!rowCount) throw notFound('Sticker');
    return { ok: true };
  });
}
