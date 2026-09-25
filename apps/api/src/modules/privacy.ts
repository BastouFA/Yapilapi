import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE, verifyPassword } from '@yapilapi/auth';
import { tx } from '@yapilapi/database';
import { consentSchema } from '@yapilapi/shared';
import { z } from 'zod';
import { badRequest, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
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
    await audit(db, { actorId: me(req).id, action: 'consent.update', entityType: 'consent', entityId: input.purpose, metadata: { granted: input.granted } });
    return { ok: true };
  });

  /** Everything we hold about you, as JSON. Messages include only what you sent. */
  app.get('/v1/me/export', { preHandler: requireAuth, config: { rateLimit: { max: 3, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    const q = (sql: string) => db.query(sql, [u.id]).then((r) => r.rows);
    const data = {
      exportedAt: new Date().toISOString(),
      account: (await q(`SELECT id, email, email_verified_at, role, status, birth_date, created_at FROM users WHERE id = $1`))[0],
      profile: (await q(`SELECT username, display_name, bio, avatar_url, cover_url, links, mode, locale, is_private FROM profiles WHERE user_id = $1`))[0],
      interests: await q(`SELECT t.slug FROM user_interests ui JOIN topics t ON t.id = ui.topic_id WHERE ui.user_id = $1`),
      following: await q(`SELECT followee_id, created_at FROM follows WHERE follower_id = $1`),
      followers: await q(`SELECT follower_id, created_at FROM follows WHERE followee_id = $1`),
      circles: await q(
        `SELECT c.name, c.kind, array_agg(cm.user_id) AS members FROM circles c LEFT JOIN circle_members cm ON cm.circle_id = c.id WHERE c.owner_id = $1 GROUP BY c.id`,
      ),
      posts: await q(`SELECT id, kind, body, visibility, topics, created_at, deleted_at FROM posts WHERE author_id = $1`),
      comments: await q(`SELECT id, post_id, body, created_at FROM comments WHERE author_id = $1`),
      reactions: await q(`SELECT post_id, kind, created_at FROM reactions WHERE user_id = $1`),
      messagesSent: await q(`SELECT conversation_id, body, attachments, created_at FROM messages WHERE sender_id = $1 AND deleted_at IS NULL`),
      communities: await q(`SELECT c.slug, cm.role, cm.joined_at FROM community_members cm JOIN communities c ON c.id = cm.community_id WHERE cm.user_id = $1`),
      events: await q(`SELECT event_id, status FROM event_attendees WHERE user_id = $1`),
      orders: await q(`SELECT id, status, total_cents, currency, created_at FROM orders WHERE buyer_id = $1`),
      consents: await q(`SELECT purpose, granted, updated_at FROM consents WHERE user_id = $1`),
      aiMemories: await q(`SELECT content, source, created_at FROM ai_memories WHERE user_id = $1`),
      securityEvents: await q(`SELECT type, created_at FROM security_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 500`),
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
    await tx(db, async (c) => {
      await c.query(
        `UPDATE users SET status = 'deleted', deleted_at = now(), email = 'deleted+' || id || '@deleted.invalid', password_hash = NULL, birth_date = NULL WHERE id = $1`,
        [u.id],
      );
      await c.query(
        `UPDATE profiles SET username = 'deleted_' || substr(replace(user_id::text, '-', ''), 1, 12), display_name = 'Deleted account', bio = '', avatar_url = NULL, cover_url = NULL, links = '[]', is_private = true WHERE user_id = $1`,
        [u.id],
      );
      await c.query(`UPDATE posts SET deleted_at = now(), body = '' WHERE author_id = $1 AND deleted_at IS NULL`, [u.id]);
      await c.query(`UPDATE comments SET deleted_at = now(), body = '' WHERE author_id = $1 AND deleted_at IS NULL`, [u.id]);
      await c.query(`UPDATE messages SET deleted_at = now(), body = '', attachments = '[]' WHERE sender_id = $1 AND deleted_at IS NULL`, [u.id]);
      await c.query(`UPDATE moments SET deleted_at = now() WHERE author_id = $1`, [u.id]);
      for (const sql of [
        `DELETE FROM follows WHERE follower_id = $1 OR followee_id = $1`,
        `DELETE FROM friendships WHERE user_a = $1 OR user_b = $1`,
        `DELETE FROM circles WHERE owner_id = $1`,
        `DELETE FROM circle_members WHERE user_id = $1`,
        `DELETE FROM user_interests WHERE user_id = $1`,
        `DELETE FROM ai_memories WHERE user_id = $1`,
        `DELETE FROM media WHERE owner_id = $1`,
        `UPDATE conversation_members SET left_at = now() WHERE user_id = $1`,
        `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
      ])
        await c.query(sql, [u.id]);
      await c.query(`INSERT INTO privacy_requests (user_id, kind, status, completed_at) VALUES ($1,'delete','completed',now())`, [u.id]);
      await securityEvent(c, u.id, 'account_deleted', req.ip);
      await audit(c, { actorId: u.id, action: 'account.delete', entityType: 'user', entityId: u.id, ip: req.ip, requestId: req.id });
    });
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
}
