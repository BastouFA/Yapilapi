import type { FastifyInstance } from 'fastify';
import { tx } from '@yapilapi/database';
import { contactMatchSchema, MAX_CONTACT_HASHES, sharingSettingsSchema } from '@yapilapi/shared';
import { z } from 'zod';
import { AppError, badRequest, forbidden, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { enqueue } from '../lib/jobs.ts';
import { track } from '../lib/services.ts';
import { ageOf, PUBLIC_USER_COLS, toPublicUser, type PublicUserRow } from '../lib/users.ts';
import { allowDownloadSql, notBlockedSql, postVisibleSql } from '../lib/visibility.ts';
import { me, requireAuth } from '../plugins/auth.ts';

/** Identifier kinds the server can match today. Phone numbers are not stored yet. */
const CONTACT_KINDS = ['email'] as const;

const idParam = z.object({ id: z.string().uuid() });

/**
 * Growth: find friends from your contacts, share a reel as a watermarked video, and the
 * settings behind both ("Let people who have my email or phone number find me" and
 * "Allow downloads of my reels").
 */
export default async function growthModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;

  // ── Contacts ──────────────────────────────────────────────────────────
  /**
   * How to hash contacts on the device. Each identifier is normalized (emails trimmed and in
   * lower case, phone numbers in E.164) and hashed as hex sha256("<salt>:<kind>:<value>").
   * The salt is fixed for this deployment. Apps hash only the kinds listed here.
   */
  app.get('/v1/contacts/salt', { preHandler: requireAuth }, async () => {
    const { rows } = await db.query(`SELECT value FROM deployment_secrets WHERE name = 'contact_salt'`);
    return {
      salt: rows[0].value as string,
      kinds: CONTACT_KINDS,
      maxHashes: MAX_CONTACT_HASHES,
      format: 'sha256-hex("<salt>:<kind>:<normalized value>")',
    };
  });

  /**
   * Which of these hashed contacts are on YAPILAPI. Only verified emails of people who allow
   * being found this way match, never people under 18, never anyone either side blocked.
   * The hashes are used for this query only: nothing from the request is stored or logged.
   */
  app.post('/v1/contacts/match', { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req) => {
    const u = me(req);
    const input = parse(contactMatchSchema, req.body);
    const hashes = [...new Set(input.hashes.map((h) => h.toLowerCase()))];
    const { rows } = await db.query(
      `SELECT ${PUBLIC_USER_COLS}, encode(us.contact_email_hash, 'hex') AS hash,
                EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followee_id = us.id) AS following,
                EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = us.id AND f.followee_id = $1) AS follows_you
         FROM users us JOIN profiles pr ON pr.user_id = us.id
         WHERE us.contact_email_hash = ANY (SELECT decode(h, 'hex') FROM unnest($2::text[]) h)
           AND us.id <> $1 AND us.status = 'active' AND us.deleted_at IS NULL
           AND us.findable_by_contacts
           AND NOT coalesce(us.birth_date > current_date - interval '18 years', false)
           AND ${notBlockedSql('us.id', '$1')}
         ORDER BY pr.display_name, pr.username`,
      [u.id, hashes],
    );
    track(db, u.id, 'contacts_matched', { submitted: hashes.length, matched: rows.length, source: input.source ?? null });
    return {
      items: rows.map((r) => ({
        user: toPublicUser(r as PublicUserRow),
        following: !!r.following,
        followsYou: !!r.follows_you,
        // The request's own hashes that matched, so the app can tell which contacts are here.
        hashes: [r.hash as string],
      })),
    };
  });

  // ── Sharing settings ──────────────────────────────────────────────────
  async function sharingSettings(userId: string) {
    const r = (
      await db.query(
        `SELECT us.findable_by_contacts, us.birth_date, pr.allow_download, pr.is_private
         FROM users us JOIN profiles pr ON pr.user_id = us.id WHERE us.id = $1`,
        [userId],
      )
    ).rows[0];
    const age = ageOf(r.birth_date);
    const minor = age !== null && age < 18;
    return {
      /** "Let people who have my email or phone number find me". */
      findableByContacts: !minor && !!r.findable_by_contacts,
      /** "Allow downloads of my reels": others can save your reels as a video to share. */
      allowDownload: !minor && (r.allow_download ?? !r.is_private),
      /** Both stay off for people under 18. */
      locked: minor,
    };
  }

  app.get('/v1/me/sharing', { preHandler: requireAuth }, async (req) => ({ settings: await sharingSettings(me(req).id) }));

  app.put('/v1/me/sharing', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const input = parse(sharingSettingsSchema, req.body);
    const age = ageOf(u.birthDate);
    if (age !== null && age < 18 && (input.findableByContacts || input.allowDownload))
      throw forbidden('These settings stay off for accounts of people under 18.');
    await tx(db, async (c) => {
      if (input.findableByContacts !== undefined) await c.query(`UPDATE users SET findable_by_contacts = $2 WHERE id = $1`, [u.id, input.findableByContacts]);
      if (input.allowDownload !== undefined) await c.query(`UPDATE profiles SET allow_download = $2 WHERE user_id = $1`, [u.id, input.allowDownload]);
    });
    return { settings: await sharingSettings(u.id) };
  });

  // ── Share a reel as a video ───────────────────────────────────────────
  /**
   * The reel, if the viewer may save it as a video: a reel they can see, not waiting for a
   * moderator, whose author allows downloads (authors can always save their own).
   */
  async function shareableReel(postId: string, viewerId: string) {
    const { rows } = await db.query(
      `SELECT p.id, p.format, p.author_id, ap.username, ${allowDownloadSql('ap', 'au')} AS allowed, p.moderation_status,
              (SELECT m.status FROM post_media pm JOIN media m ON m.id = pm.media_id
               WHERE pm.post_id = p.id AND m.kind = 'video' ORDER BY pm.position LIMIT 1) AS media_status,
              (SELECT m.storage_key FROM post_media pm JOIN media m ON m.id = pm.media_id
               WHERE pm.post_id = p.id AND m.kind = 'video' ORDER BY pm.position LIMIT 1) AS storage_key
       FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
       WHERE p.id = $2 AND ${postVisibleSql('$1')}`,
      [viewerId, postId],
    );
    const r = rows[0];
    if (!r) throw notFound('That reel');
    if (r.format !== 'reel') throw badRequest('Only reels can be saved as a video.');
    if (r.author_id !== viewerId && !r.allowed) throw forbidden("The creator of this reel doesn't allow downloads.");
    if (r.moderation_status !== 'normal') throw forbidden("This reel can't be shared while it's being reviewed.");
    return r as { id: string; username: string; media_status: string | null; storage_key: string | null };
  }

  const fileName = (username: string, postId: string) => `yapilapi-${username}-${postId.slice(0, 8)}.mp4`;
  const shareState = (row: { status: string; url: string | null; username: string } | undefined, username: string, postId: string) => ({
    status: (row && row.username === username ? row.status : 'none') as 'none' | 'queued' | 'processing' | 'ready' | 'failed',
    url: row && row.username === username && row.status === 'ready' ? row.url : null,
    fileName: fileName(username, postId),
  });

  /** Ask for the share video. Rendered once per reel and reused; poll GET for the result. */
  app.post('/v1/posts/:id/share-video', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const reel = await shareableReel(id, u.id);
    if (!reel.storage_key) throw new AppError(422, 'not_shareable', "This reel can't be saved as a video.");
    if (reel.media_status !== 'ready') throw new AppError(409, 'not_ready', 'This reel is still processing. Try again in a minute.');
    // Start a render unless one is already done or on its way for the current @name.
    const started = await tx(db, async (c) => {
      const r = await c.query(
        `INSERT INTO share_videos (post_id, username, requested_by) VALUES ($1, $2, $3)
           ON CONFLICT (post_id) DO UPDATE SET status = 'queued', username = EXCLUDED.username, requested_by = EXCLUDED.requested_by,
                                               url = NULL, storage_key = NULL, error = NULL
             WHERE share_videos.status = 'failed' OR share_videos.username <> EXCLUDED.username
           RETURNING post_id`,
        [id, reel.username, u.id],
      );
      if (r.rowCount) await enqueue(c, 'share.render', { postId: id });
      return !!r.rowCount;
    });
    if (started) track(db, u.id, 'share_video_requested', { postId: id });
    const row = (await db.query(`SELECT status, url, username FROM share_videos WHERE post_id = $1`, [id])).rows[0];
    const state = shareState(row, reel.username, id);
    reply.code(state.status === 'ready' ? 200 : 202);
    return state;
  });

  app.get('/v1/posts/:id/share-video', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const reel = await shareableReel(id, u.id);
    const row = (await db.query(`SELECT status, url, username FROM share_videos WHERE post_id = $1`, [id])).rows[0];
    return shareState(row, reel.username, id);
  });
}
