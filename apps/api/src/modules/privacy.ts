import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE, verifyPassword } from '@yapilapi/auth';
import { tx } from '@yapilapi/database';
import { consentSchema } from '@yapilapi/shared';
import { z } from 'zod';
import { badRequest, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { deliverable } from '../lib/email.ts';
import { collectAccountFiles, removeAccountFiles } from '../lib/media-files.ts';
import { audit, securityEvent } from '../lib/services.ts';
import { me, requireAuth } from '../plugins/auth.ts';

/** Privacy Center: inspect, export and delete your data; manage consent. */
export default async function privacyModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;

  app.get('/v1/me/privacy', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const [consents, counts, requests] = await Promise.all([
      db.query(`SELECT purpose, granted, updated_at FROM consents WHERE user_id = $1`, [u.id]),
      db.query(
        `SELECT (SELECT count(*) FROM posts WHERE author_id = $1 AND deleted_at IS NULL) AS posts,
                (SELECT count(*) FROM comments WHERE author_id = $1 AND deleted_at IS NULL) AS comments,
                (SELECT count(*) FROM messages WHERE sender_id = $1 AND deleted_at IS NULL) AS messages,
                (SELECT count(*) FROM media WHERE owner_id = $1) AS media,
                (SELECT count(*) FROM ai_memories WHERE user_id = $1) AS ai_memories,
                (SELECT count(*) FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()) AS active_sessions`,
        [u.id],
      ),
      db.query(`SELECT kind, status, created_at, completed_at FROM privacy_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`, [u.id]),
    ]);
    return { consents: consents.rows, dataSummary: counts.rows[0], requests: requests.rows };
  });

  app.put('/v1/me/consents', { preHandler: requireAuth }, async (req) => {
    const input = parse(consentSchema, req.body);
    await db.query(
      `INSERT INTO consents (user_id, purpose, granted) VALUES ($1,$2,$3) ON CONFLICT (user_id, purpose) DO UPDATE SET granted = EXCLUDED.granted, updated_at = now()`,
      [me(req).id, input.purpose, input.granted],
    );
    // Turning analytics off also unlinks the events already recorded: they stay in the totals without being yours.
    if (input.purpose === 'analytics' && !input.granted) await db.query(`UPDATE analytics_events SET user_id = NULL WHERE user_id = $1`, [me(req).id]);
    await audit(db, { actorId: me(req).id, action: 'consent.update', entityType: 'consent', entityId: input.purpose, metadata: { granted: input.granted } });
    return { ok: true };
  });

  /** Everything we hold about you, as JSON. Messages include only what you sent. */
  app.get('/v1/me/export', { preHandler: requireAuth, config: { rateLimit: { max: 3, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    const q = (sql: string) => db.query(sql, [u.id]).then((r) => r.rows);
    const data = {
      exportedAt: new Date().toISOString(),
      account: (
        await q(`SELECT id, email, email_verified_at, phone_e164, phone_verified_at, role, status, birth_date, created_at FROM users WHERE id = $1`)
      )[0],
      profile: (
        await q(
          `SELECT username, display_name, bio, avatar_url, cover_url, cover_alt, links, mode, locale, is_private, pronouns, city, accent, header_style, tabs, featured_post_ids, song_sound_id, song_track_id, song_part FROM profiles WHERE user_id = $1`,
        )
      )[0],
      nowStatus: (await q(`SELECT text, icon, audience, created_at, expires_at FROM profile_statuses WHERE user_id = $1`))[0] ?? null,
      interests: await q(`SELECT t.slug FROM user_interests ui JOIN topics t ON t.id = ui.topic_id WHERE ui.user_id = $1`),
      following: await q(`SELECT followee_id, created_at FROM follows WHERE follower_id = $1`),
      followers: await q(`SELECT follower_id, created_at FROM follows WHERE followee_id = $1`),
      circles: await q(
        `SELECT c.name, c.kind, array_agg(cm.user_id) AS members FROM circles c LEFT JOIN circle_members cm ON cm.circle_id = c.id WHERE c.owner_id = $1 GROUP BY c.id`,
      ),
      closeFriends: await q(`SELECT friend_id, created_at FROM close_friends WHERE owner_id = $1`),
      posts: await q(
        `SELECT id, kind, format, body, visibility, topics, allow_remix, remix_of_post_id, remix_mode, sound_id, status, scheduled_at, created_at, edited_at, deleted_at
         FROM posts WHERE author_id = $1`,
      ),
      // Earlier versions of your posts' text.
      postEdits: await q(`SELECT e.post_id, e.body, e.edited_at FROM post_edits e JOIN posts p ON p.id = e.post_id WHERE p.author_id = $1`),
      sounds: await q(`SELECT id, title, source_post_id, duration_ms, created_at FROM sounds WHERE owner_id = $1`),
      comments: await q(`SELECT id, post_id, parent_id, reply_to_id, body, created_at, edited_at FROM comments WHERE author_id = $1`),
      // Earlier versions of your comments' text, the comments you liked, and your hidden words.
      commentEdits: await q(`SELECT e.comment_id, e.body, e.created_at FROM comment_edits e JOIN comments c ON c.id = e.comment_id WHERE c.author_id = $1`),
      commentLikes: await q(`SELECT comment_id, created_at FROM comment_likes WHERE user_id = $1`),
      hiddenWords: await q(`SELECT word, created_at FROM hidden_words WHERE user_id = $1`),
      reactions: await q(`SELECT post_id, kind, created_at FROM reactions WHERE user_id = $1`),
      messagesSent: await q(`SELECT conversation_id, body, attachments, created_at FROM messages WHERE sender_id = $1 AND deleted_at IS NULL`),
      communities: await q(`SELECT c.slug, cm.role, cm.joined_at FROM community_members cm JOIN communities c ON c.id = cm.community_id WHERE cm.user_id = $1`),
      events: await q(`SELECT event_id, status FROM event_attendees WHERE user_id = $1`),
      orders: await q(`SELECT id, status, total_cents, currency, created_at FROM orders WHERE buyer_id = $1`),
      consents: await q(`SELECT purpose, granted, updated_at FROM consents WHERE user_id = $1`),
      aiMemories: await q(`SELECT content, source, created_at FROM ai_memories WHERE user_id = $1`),
      securityEvents: await q(`SELECT type, created_at FROM security_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 500`),
      problemReports: await q(`SELECT body, platform, app_version, page, status, created_at FROM problem_reports WHERE user_id = $1 ORDER BY created_at DESC`),
    };
    await db.query(`INSERT INTO privacy_requests (user_id, kind, status, completed_at) VALUES ($1,'export','completed',now())`, [u.id]);
    reply.header('content-disposition', `attachment; filename="yapilapi-export-${u.id}.json"`);
    return data;
  });

  /**
   * Account deletion: requires the password, then anonymizes the profile,
   * removes content and connections, and revokes every session. The row stays
   * (status = deleted) so audit trails and other people's conversations remain consistent.
   */
  app.delete('/v1/me', { preHandler: requireAuth, config: { rateLimit: { max: 3, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    const { password } = parse(z.object({ password: z.string().min(1) }), req.body);
    const { rows } = await db.query(`SELECT password_hash FROM users WHERE id = $1`, [u.id]);
    if (!(await verifyPassword(password, rows[0]?.password_hash))) throw badRequest('Your password is incorrect.', { fields: { password: 'Incorrect.' } });
    // Every file behind their photos, videos and voice notes, with each size, MP4 and HLS segment,
    // view-once files, live recordings, recap and shared-reel videos (not the private files of digital
    // products they sold, which buyers paid for). Removed from storage once the account is gone.
    const files = await collectAccountFiles(db, u.id);
    const address = (await db.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [u.id])).rows[0]?.email;
    await tx(db, async (c) => {
      await c.query(
        `UPDATE users SET status = 'deleted', deleted_at = now(), email = 'deleted+' || id || '@deleted.invalid', password_hash = NULL, birth_date = NULL,
           phone_e164 = NULL, phone_verified_at = NULL WHERE id = $1`,
        [u.id],
      );
      await c.query(
        `UPDATE profiles SET username = 'deleted_' || substr(replace(user_id::text, '-', ''), 1, 12), display_name = 'Deleted account', bio = '', avatar_url = NULL, cover_url = NULL, cover_media_id = NULL, cover_alt = NULL, links = '[]', is_private = true WHERE user_id = $1`,
        [u.id],
      );
      await c.query(`UPDATE posts SET deleted_at = now(), body = '' WHERE author_id = $1 AND deleted_at IS NULL`, [u.id]);
      // Problems they reported stay (they may describe a bug), without their words or who sent them.
      await c.query(`UPDATE problem_reports SET user_id = NULL, body = '', page = NULL WHERE user_id = $1`, [u.id]);
      // Earlier versions of the text go too.
      await c.query(`DELETE FROM post_edits e USING posts p WHERE p.id = e.post_id AND p.author_id = $1`, [u.id]);
      await c.query(`UPDATE comments SET deleted_at = now(), body = '' WHERE author_id = $1 AND deleted_at IS NULL`, [u.id]);
      await c.query(`DELETE FROM comment_edits e USING comments cm WHERE cm.id = e.comment_id AND cm.author_id = $1`, [u.id]);
      // Their likes come off other people's comments.
      await c.query(
        `WITH gone AS (DELETE FROM comment_likes WHERE user_id = $1 RETURNING comment_id)
         UPDATE comments SET like_count = greatest(like_count - 1, 0) WHERE id IN (SELECT comment_id FROM gone)`,
        [u.id],
      );
      await c.query(`UPDATE messages SET deleted_at = now(), body = '', attachments = '[]' WHERE sender_id = $1 AND deleted_at IS NULL`, [u.id]);
      await c.query(`UPDATE moments SET deleted_at = coalesce(deleted_at, now()), body = '', media_url = NULL, location_text = NULL WHERE author_id = $1`, [
        u.id,
      ]);
      for (const sql of [
        `DELETE FROM follows WHERE follower_id = $1 OR followee_id = $1`,
        `DELETE FROM friendships WHERE user_a = $1 OR user_b = $1`,
        `DELETE FROM close_friends WHERE owner_id = $1 OR friend_id = $1`,
        `DELETE FROM profile_statuses WHERE user_id = $1`,
        `DELETE FROM sounds WHERE owner_id = $1`,
        `DELETE FROM circles WHERE owner_id = $1`,
        `DELETE FROM circle_members WHERE user_id = $1`,
        `DELETE FROM user_interests WHERE user_id = $1`,
        `DELETE FROM ai_memories WHERE user_id = $1`,
        // Nothing can reach this phone or browser any more, and nobody can sign in with these.
        `DELETE FROM push_subscriptions WHERE user_id = $1`,
        `DELETE FROM passkeys WHERE user_id = $1`,
        `DELETE FROM media WHERE owner_id = $1`,
        `DELETE FROM share_videos sv USING posts p WHERE p.id = sv.post_id AND p.author_id = $1`,
        `UPDATE recaps SET deleted_at = coalesce(deleted_at, now()) WHERE owner_id = $1`,
        // Product analytics stay in the totals without being linked to them.
        `UPDATE analytics_events SET user_id = NULL WHERE user_id = $1`,
        `UPDATE conversation_members SET left_at = now() WHERE user_id = $1`,
        `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
      ])
        await c.query(sql, [u.id]);
      await c.query(`INSERT INTO privacy_requests (user_id, kind, status, completed_at) VALUES ($1,'delete','completed',now())`, [u.id]);
      await securityEvent(c, u.id, 'account_deleted', req.ip);
      await audit(c, { actorId: u.id, action: 'account.delete', entityType: 'user', entityId: u.id, ip: req.ip, requestId: req.id });
    });
    // In the background: many files can take a while, and a file that fails to go is only logged.
    void removeAccountFiles(ctx, files).then(
      (r) => r.failed && req.log.warn({ failed: r.failed }, 'some of a deleted account’s files could not be removed'),
      (err: unknown) => req.log.warn({ err }, 'could not remove a deleted account’s files'),
    );
    // A last note to the address the account had, so a deletion nobody asked for doesn't go unnoticed.
    if (deliverable(address))
      await ctx.email
        .send({
          to: address,
          subject: 'Your YAPILAPI account was deleted',
          text: 'Your YAPILAPI account and what you shared were deleted, as you asked. Nothing else will be sent to this address.\n\nIf you didn’t delete your account, reply to this email or contact support straight away.',
        })
        .catch((err: Error) => req.log.warn({ err: err.message }, 'account deletion email not sent'));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
}
