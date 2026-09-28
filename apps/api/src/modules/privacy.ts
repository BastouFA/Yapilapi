import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE, verifyPassword } from '@yapilapi/auth';
import { tx } from '@yapilapi/database';
import { consentSchema } from '@yapilapi/shared';
import { z } from 'zod';
import { badRequest, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { deliverable } from '../lib/email.ts';
import { EXPORT_README, exportSections, usernameOf } from '../lib/data-export.ts';
import { collectAccountFiles, removeAccountFiles } from '../lib/media-files.ts';
import { refundUnspentBudget } from '../lib/ad-refunds.ts';
import { releaseDropOrder } from '../lib/drops.ts';
import { audit, notify, securityEvent } from '../lib/services.ts';
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

  /**
   * Everything we hold about you, as JSON (the right of access). Messages include only what you
   * sent; other people appear by username; no secrets. The newer parts are built in lib/data-export.ts,
   * which explains what is summarised, capped or left out and why.
   */
  app.get('/v1/me/export', { preHandler: requireAuth, config: { rateLimit: { max: 3, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    const q = (sql: string) => db.query(sql, [u.id]).then((r) => r.rows);
    const data = {
      readme: EXPORT_README,
      exportedAt: new Date().toISOString(),
      account: (
        await q(
          `SELECT id, email, email_verified_at, phone_e164, phone_verified_at, role, status, birth_date, mfa_enabled, findable_by_contacts, onboarded_at, created_at
           FROM users WHERE id = $1`,
        )
      )[0],
      profile: (
        await q(
          `SELECT username, display_name, bio, avatar_url, cover_url, cover_alt, cover_media_id, cover_edit, links, mode, locale, is_private, pronouns, city, accent, header_style, tabs, featured_post_ids,
                  song_sound_id, song_track_id, song_part, country, country_source, cdn_country, plus_until, allow_download, tag_permission, pinned_post_id, created_at
           FROM profiles WHERE user_id = $1`,
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
        `SELECT id, kind, format, body, visibility, topics, allow_remix, remix_of_post_id, remix_mode, sound_id, allow_echoes, is_echo, echo_of_post_id, status, scheduled_at,
                created_at, edited_at, deleted_at
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
      // What you bought or paid for; the seller or person paid by username. Sales are under money.sales.
      orders: await q(
        `SELECT o.id, o.purpose, o.status, o.total_cents, o.currency, o.created_at, ${usernameOf('o.payee_id')} AS paid_to,
                coalesce((SELECT json_agg(json_build_object('product_id', p.id, 'title', p.title, 'seller', ${usernameOf('p.seller_id')}, 'quantity', i.quantity, 'unit_cents', i.unit_cents))
                          FROM order_items i JOIN products p ON p.id = i.product_id WHERE i.order_id = o.id), '[]') AS items
         FROM orders o WHERE o.buyer_id = $1 ORDER BY o.created_at DESC`,
      ),
      consents: await q(`SELECT purpose, granted, updated_at FROM consents WHERE user_id = $1`),
      aiMemories: await q(`SELECT content, source, created_at FROM ai_memories WHERE user_id = $1`),
      securityEvents: await q(`SELECT type, host(ip) AS ip, user_agent, created_at FROM security_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 500`),
      problemReports: await q(`SELECT body, platform, app_version, page, status, created_at FROM problem_reports WHERE user_id = $1 ORDER BY created_at DESC`),
      usernameChanges: await q(`SELECT old_username, new_username, changed_at, held_until FROM username_history WHERE user_id = $1 ORDER BY changed_at DESC`),
      signInDevices: await q(`SELECT fingerprint, first_seen_at, last_seen_at FROM known_sign_ins WHERE user_id = $1 ORDER BY last_seen_at DESC`),
      scheduledMessages: await q(`SELECT conversation_id, body, send_at, status, created_at FROM scheduled_messages WHERE sender_id = $1 ORDER BY send_at`),
      // Your weekly wraps (weeks with something in them): the counts and what they pointed to.
      weeklyWraps: await q(
        `SELECT week_start, timezone, summary, moment_post_id, created_at FROM weekly_wraps WHERE user_id = $1 AND NOT empty ORDER BY week_start DESC`,
      ),
      // Your question box, the questions you asked (with the answer while it's shown) and the ones you were asked.
      // Who asked a question without their name stays out, here as everywhere else.
      askBox: (await q(`SELECT enabled, prompt, audience, allow_hidden_names, updated_at FROM ask_boxes WHERE user_id = $1`))[0] ?? null,
      questionsAsked: await q(
        `SELECT recipient_id, body, hide_name, CASE WHEN moderation_status = 'normal' AND hidden_at IS NULL THEN answer END AS answer,
                CASE WHEN moderation_status = 'normal' AND hidden_at IS NULL THEN answered_at END AS answered_at, created_at
         FROM ask_questions WHERE asker_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`,
      ),
      questionsReceived: await q(
        `SELECT id, body, hide_name, CASE WHEN hide_name THEN NULL ELSE asker_id END AS asker_id, answer, answered_at, hidden_at, created_at
         FROM ask_questions WHERE recipient_id = $1 AND deleted_at IS NULL AND (moderation_status = 'normal' OR answered_at IS NOT NULL) ORDER BY created_at DESC`,
      ),
      questionBlocks: await q(`SELECT question_id, created_at FROM ask_blocks WHERE recipient_id = $1 ORDER BY created_at DESC`),
      // Collages you made: the layout and settings, which photos went in them, and the photo it became.
      collages: await q(
        `SELECT media_id, source_ids, spec, created_at FROM media_collages WHERE owner_id = $1 AND media_id IS NOT NULL ORDER BY created_at DESC`,
      ),
      // Echoes you made: the reel each answers (and whose it was, by username), how it was put together,
      // what was heard of the original, the video it became and the reel you posted it as.
      echoes: await q(
        `SELECT e.id, e.original_post_id, (SELECT username FROM profiles WHERE user_id = e.original_author_id) AS original_author, e.source_media_id,
                e.result_media_id, e.post_id, e.layout, e.cut_start_ms, e.cut_end_ms, e.balance, e.their_audio, e.status, e.duration_ms, e.created_at
         FROM echoes e WHERE e.owner_id = $1 ORDER BY e.created_at DESC`,
      ),
      // Your mixes with their songs in order (who added each), the songs you added to other people's
      // mixes, and the mixes you liked or saved.
      mixes: await q(
        `SELECT mx.id, mx.title, mx.description, mx.visibility, mx.created_at, mx.updated_at,
                (SELECT coalesce(json_agg(json_build_object('trackId', ms.track_id, 'soundId', ms.sound_id,
                          'title', coalesce(mt.title, s.title), 'artist', mt.artist, 'addedBy', ms.added_by, 'addedAt', ms.created_at)
                        ORDER BY ms.position, ms.id), '[]')
                 FROM mix_songs ms LEFT JOIN music_tracks mt ON mt.id = ms.track_id LEFT JOIN sounds s ON s.id = ms.sound_id
                 WHERE ms.mix_id = mx.id) AS songs,
                (SELECT coalesce(array_agg(mc.conversation_id), '{}') FROM mix_chats mc WHERE mc.mix_id = mx.id) AS shared_in_chats
         FROM mixes mx WHERE mx.owner_id = $1 AND mx.deleted_at IS NULL ORDER BY mx.created_at DESC`,
      ),
      mixSongsAdded: await q(
        `SELECT ms.mix_id, ms.track_id, ms.sound_id, coalesce(mt.title, s.title) AS title, ms.created_at
         FROM mix_songs ms JOIN mixes mx ON mx.id = ms.mix_id LEFT JOIN music_tracks mt ON mt.id = ms.track_id LEFT JOIN sounds s ON s.id = ms.sound_id
         WHERE ms.added_by = $1 AND mx.owner_id <> $1 ORDER BY ms.created_at DESC`,
      ),
      mixLikes: await q(`SELECT mix_id, created_at FROM mix_likes WHERE user_id = $1 ORDER BY created_at DESC`),
      mixSaves: await q(`SELECT mix_id, created_at FROM mix_saves WHERE user_id = $1 ORDER BY created_at DESC`),
      chatGames: await q(
        `SELECT conversation_id, kind, status, winner_id = $1 AS won, created_at, ended_at FROM chat_games WHERE $1 = ANY(players) ORDER BY created_at DESC`,
      ),
      ...(await exportSections(db, u.id)),
      // Together albums you're in, what you added to them (never where it was taken: that isn't kept),
      // your stars, reactions and comments there, and your requests to join.
      togetherAlbums: await q(
        `SELECT t.id, t.title, t.description, m.role, m.joined_at, t.status, t.closes_at, t.created_at
         FROM together_members m JOIN togethers t ON t.id = m.together_id WHERE m.user_id = $1 AND t.deleted_at IS NULL ORDER BY m.joined_at DESC`,
      ),
      togetherItems: await q(
        `SELECT together_id, media_id, caption, captured_at, taken_source, created_at, deleted_at FROM together_contributions WHERE user_id = $1 ORDER BY created_at DESC`,
      ),
      togetherStars: await q(`SELECT item_id, created_at FROM together_stars WHERE user_id = $1 ORDER BY created_at DESC`),
      togetherReactions: await q(`SELECT item_id, kind, created_at FROM together_reactions WHERE user_id = $1 ORDER BY created_at DESC`),
      togetherComments: await q(`SELECT item_id, body, created_at FROM together_comments WHERE author_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`),
      togetherRequests: await q(`SELECT together_id, status, created_at, decided_at FROM together_requests WHERE user_id = $1 ORDER BY created_at DESC`),
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
    let endedCampaigns: string[] = [];
    await tx(db, async (c) => {
      await c.query(
        `UPDATE users SET status = 'deleted', deleted_at = now(), email = 'deleted+' || id || '@deleted.invalid', password_hash = NULL, birth_date = NULL,
           phone_e164 = NULL, phone_verified_at = NULL, mfa_enabled = false, contact_email_hash = NULL, findable_by_contacts = false WHERE id = $1`,
        [u.id],
      );
      await c.query(
        `UPDATE profiles SET username = 'deleted_' || substr(replace(user_id::text, '-', ''), 1, 12), display_name = 'Deleted account', bio = '', avatar_url = NULL, cover_url = NULL, cover_media_id = NULL, cover_alt = NULL, cover_edit = NULL, cover_render_media_id = NULL, links = '[]', is_private = true,
           country = NULL, country_source = NULL, cdn_country = NULL, pinned_post_id = NULL, accent = NULL, header_style = 'cover', pronouns = NULL, city = NULL,
           tabs = NULL, featured_post_ids = '{}', song_sound_id = NULL, song_track_id = NULL, song_part = NULL, mode = 'personal', locale = 'en'
         WHERE user_id = $1`,
        [u.id],
      );
      await c.query(`DELETE FROM profile_statuses WHERE user_id = $1`, [u.id]);
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
      // Together albums they started go on for everyone else, hosted by their longest-standing
      // co-host (or member); an album with nobody else in it is deleted.
      const hosted = await c.query<{ id: string }>(`SELECT id FROM togethers WHERE creator_id = $1 AND deleted_at IS NULL`, [u.id]);
      for (const t of hosted.rows) {
        const next = await c.query<{ user_id: string }>(
          `SELECT m.user_id FROM together_members m JOIN users mu ON mu.id = m.user_id
           WHERE m.together_id = $1 AND m.user_id <> $2 AND mu.status = 'active' ORDER BY (m.role = 'cohost') DESC, m.joined_at LIMIT 1`,
          [t.id, u.id],
        );
        if (next.rows[0]) {
          await c.query(`UPDATE togethers SET creator_id = $2, updated_at = now() WHERE id = $1`, [t.id, next.rows[0].user_id]);
          await c.query(`UPDATE together_members SET role = 'creator' WHERE together_id = $1 AND user_id = $2`, [t.id, next.rows[0].user_id]);
        } else await c.query(`UPDATE togethers SET deleted_at = now(), invite_enabled = false WHERE id = $1`, [t.id]);
      }
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
        // Earlier usernames stop leading here, the devices seen for sign-in alerts are forgotten, and nothing scheduled goes out.
        `DELETE FROM username_history WHERE user_id = $1`,
        `DELETE FROM known_sign_ins WHERE user_id = $1`,
        `DELETE FROM scheduled_messages WHERE sender_id = $1`,
        // Their question box, the questions they asked (with the answers to them) and the ones they were asked.
        `DELETE FROM ask_questions WHERE asker_id = $1 OR recipient_id = $1`,
        `DELETE FROM ask_boxes WHERE user_id = $1`,
        `DELETE FROM ask_blocks WHERE recipient_id = $1 OR asker_id = $1`,
        // Collages go with their photos (and so does any half-made one).
        `DELETE FROM media_collages WHERE owner_id = $1`,
        // Echoes they made go with their videos. Echoes other people made of their reels stay with
        // their makers, hidden from everyone else now that the originals are gone (echoShownSql).
        `DELETE FROM echoes WHERE owner_id = $1`,
        `UPDATE echoes SET original_author_id = NULL WHERE original_author_id = $1`,
        // Their mixes go (with their songs, likes, saves and sharing). Songs they added to other people's
        // mixes stay there, "added by a former member"; their likes come off the counts.
        `DELETE FROM mixes WHERE owner_id = $1`,
        `UPDATE mix_songs SET added_by = NULL WHERE added_by = $1`,
        `WITH gone AS (DELETE FROM mix_likes WHERE user_id = $1 RETURNING mix_id)
         UPDATE mixes SET like_count = greatest(like_count - 1, 0) WHERE id IN (SELECT mix_id FROM gone)`,
        `DELETE FROM mix_saves WHERE user_id = $1`,
        // What they added to Together albums, their stars, reactions and comments there, their places in albums and requests to join.
        `UPDATE together_contributions SET deleted_at = coalesce(deleted_at, now()), caption = '' WHERE user_id = $1`,
        `DELETE FROM together_stars WHERE user_id = $1`,
        `DELETE FROM together_reactions WHERE user_id = $1`,
        `DELETE FROM together_comments WHERE author_id = $1`,
        `DELETE FROM together_requests WHERE user_id = $1`,
        `DELETE FROM together_members WHERE user_id = $1`,
        `DELETE FROM media WHERE owner_id = $1`,
        `DELETE FROM share_videos sv USING posts p WHERE p.id = sv.post_id AND p.author_id = $1`,
        `UPDATE recaps SET deleted_at = coalesce(deleted_at, now()) WHERE owner_id = $1`,
        // Weekly wraps are theirs alone; they stop watching together.
        `DELETE FROM weekly_wraps WHERE user_id = $1`,
        `UPDATE watch_participants SET left_at = now() WHERE user_id = $1 AND left_at IS NULL`,
        // Product analytics stay in the totals without being linked to them.
        `UPDATE analytics_events SET user_id = NULL WHERE user_id = $1`,
        `UPDATE conversation_members SET left_at = now() WHERE user_id = $1`,
        // Where they shared their location: points and records alike.
        `DELETE FROM location_shares WHERE user_id = $1`,
        `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
        // Sign-in material goes: devices, one-time links and challenges, two-step methods and codes,
        // download links. Apps they allowed lose access; their own apps, keys and webhooks stop.
        `DELETE FROM devices WHERE user_id = $1`,
        `DELETE FROM auth_tokens WHERE user_id = $1`,
        `DELETE FROM mfa_challenges WHERE user_id = $1`,
        `DELETE FROM mfa_factors WHERE user_id = $1`,
        `DELETE FROM mfa_recovery_codes WHERE user_id = $1`,
        `DELETE FROM webauthn_challenges WHERE user_id = $1`,
        `DELETE FROM oauth_codes WHERE user_id = $1`,
        `DELETE FROM download_links WHERE user_id = $1`,
        `UPDATE oauth_grants SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
        `UPDATE developer_apps SET deleted_at = now() WHERE owner_id = $1 AND deleted_at IS NULL`,
        `UPDATE api_keys SET revoked_at = now() WHERE owner_id = $1 AND revoked_at IS NULL`,
        `UPDATE webhook_subscriptions w SET active = false FROM developer_apps a WHERE a.id = w.app_id AND a.owner_id = $1`,
        // Unfinished uploads expire now, so the daily clean-up removes them with their pieces.
        `UPDATE upload_sessions SET expires_at = least(expires_at, now()) WHERE user_id = $1`,
        // Their inbox, and what they did in other people's (it would point at nothing).
        `DELETE FROM notifications WHERE user_id = $1 OR actor_id = $1`,
        // Who they are connected to or kept away, both ways.
        `DELETE FROM friend_requests WHERE from_user_id = $1 OR to_user_id = $1`,
        `DELETE FROM blocks WHERE blocker_id = $1 OR blocked_id = $1`,
        `DELETE FROM mutes WHERE muter_id = $1 OR muted_id = $1`,
        `DELETE FROM restrictions WHERE restrictor_id = $1 OR restricted_id = $1`,
        `UPDATE family_links SET status = 'ended', ended_at = now() WHERE (guardian_id = $1 OR teen_id = $1) AND status <> 'ended'`,
        `DELETE FROM teen_controls WHERE teen_id = $1`,
        `UPDATE teen_controls SET updated_by = NULL WHERE updated_by = $1`,
        `DELETE FROM invite_codes WHERE user_id = $1`,
        // What they made that is theirs alone: chapters, boards and memories (with what was in them),
        // rooms they started, and their places in other people's.
        `DELETE FROM chapters WHERE owner_id = $1`,
        `DELETE FROM chapter_members WHERE user_id = $1`,
        `DELETE FROM chapter_guestbook WHERE author_id = $1`,
        `DELETE FROM boards WHERE owner_id = $1`,
        `DELETE FROM board_members WHERE user_id = $1`,
        `DELETE FROM memories WHERE owner_id = $1`,
        `DELETE FROM memory_shares WHERE user_id = $1`,
        `DELETE FROM rooms WHERE created_by = $1`,
        `UPDATE room_participants SET left_at = now(), hand_raised_at = NULL WHERE user_id = $1 AND left_at IS NULL`,
        `DELETE FROM room_reminders WHERE user_id = $1`,
        `DELETE FROM together_members WHERE user_id = $1 AND role = 'member'`,
        `DELETE FROM together_contributions WHERE user_id = $1`,
        `UPDATE togethers SET status = 'closed' WHERE creator_id = $1`,
        `DELETE FROM event_attendees WHERE user_id = $1`,
        // Their tickets go (bought ones stay in the order's payment records), and so do their places as
        // co-hosts. Tickets they gave friends stay with the friends; the door's log forgets who scanned.
        `DELETE FROM event_tickets WHERE holder_id = $1`,
        `UPDATE event_tickets SET checked_in_by = NULL WHERE checked_in_by = $1`,
        `DELETE FROM event_cohosts WHERE user_id = $1`,
        `UPDATE event_cohosts SET added_by = NULL WHERE added_by = $1`,
        `UPDATE ticket_transfers SET from_id = NULL WHERE from_id = $1`,
        `UPDATE ticket_transfers SET to_id = NULL WHERE to_id = $1`,
        `UPDATE ticket_scans SET scanner_id = NULL WHERE scanner_id = $1`,
        // Lives: any still to come or on air end, and the titles and stream keys go. What they said in lives goes like comments.
        `UPDATE live_sessions SET status = 'ended', ended_at = coalesce(ended_at, now()) WHERE host_id = $1 AND status <> 'ended'`,
        `UPDATE live_sessions SET title = '', stream_key_hash = NULL WHERE host_id = $1`,
        `UPDATE live_chat SET deleted_at = now(), body = '' WHERE user_id = $1 AND deleted_at IS NULL`,
        `UPDATE live_participants SET left_at = now() WHERE user_id = $1 AND left_at IS NULL`,
        `UPDATE call_participants SET left_at = now() WHERE user_id = $1 AND left_at IS NULL`,
        // Their shop and listings come down. Orders, payments and bookings stay as payment records
        // (buyers keep their downloads), without the notes and tip messages they wrote.
        `UPDATE products SET status = 'archived', updated_at = now() WHERE seller_id = $1 AND status <> 'archived'`,
        `DELETE FROM drops WHERE seller_id = $1 AND status = 'draft'`,
        `UPDATE businesses SET deleted_at = now() WHERE owner_id = $1 AND deleted_at IS NULL`,
        `UPDATE places SET deleted_at = now() WHERE created_by = $1 AND deleted_at IS NULL`,
        `DELETE FROM place_reviews WHERE author_id = $1`,
        `UPDATE creator_plans SET active = false WHERE creator_id = $1`,
        `UPDATE creator_subscriptions SET status = 'cancelled', cancelled_at = now() WHERE (subscriber_id = $1 OR creator_id = $1) AND status IN ('pending', 'active')`,
        `UPDATE tips SET message = '' WHERE from_id = $1`,
        `UPDATE bookings SET note = '' WHERE user_id = $1`,
        `DELETE FROM drop_reminders WHERE user_id = $1`,
        // What they did: saves, views, votes, answers to stickers, reactions in chats, tags and collaborations,
        // feed feedback, minutes, reel positions, their settings, and what the assistant kept for them.
        `DELETE FROM saves WHERE user_id = $1`,
        `DELETE FROM post_views WHERE viewer_id = $1`,
        `DELETE FROM moment_views WHERE viewer_id = $1`,
        `DELETE FROM business_views WHERE viewer_id = $1`,
        `DELETE FROM story_responses WHERE user_id = $1`,
        `DELETE FROM poll_votes WHERE user_id = $1`,
        `DELETE FROM chat_poll_votes WHERE user_id = $1`,
        `DELETE FROM message_reactions WHERE user_id = $1`,
        `DELETE FROM message_hides WHERE user_id = $1`,
        `DELETE FROM chat_reminders WHERE user_id = $1`,
        `DELETE FROM photo_tags WHERE user_id = $1 OR tagged_by = $1`,
        `DELETE FROM post_collaborators WHERE user_id = $1`,
        `DELETE FROM post_audience WHERE user_id = $1`,
        `DELETE FROM music_saves WHERE user_id = $1`,
        `DELETE FROM feed_feedback WHERE user_id = $1`,
        `DELETE FROM usage_days WHERE user_id = $1`,
        `DELETE FROM pulse_visits WHERE user_id = $1`,
        `DELETE FROM reel_resume WHERE user_id = $1`,
        `DELETE FROM user_preferences WHERE user_id = $1`,
        `DELETE FROM ai_catchups WHERE user_id = $1`,
        `DELETE FROM ai_reply_suggestions WHERE user_id = $1`,
        `DELETE FROM ai_conversations WHERE user_id = $1`,
        // Automated flags only matter while the account exists.
        `DELETE FROM risk_signals WHERE user_id = $1`,
        // Logs stay in the totals without being linked to them.
        `UPDATE ai_tool_calls SET user_id = NULL WHERE user_id = $1`,
        `UPDATE ad_events SET user_id = NULL WHERE user_id = $1`,
        `UPDATE share_videos SET requested_by = NULL WHERE requested_by = $1`,
        `UPDATE watch_queue_items SET added_by = NULL WHERE added_by = $1`,
      ])
        await c.query(sql, [u.id]);
      // Their likes and reposts come off other people's posts, and they leave their communities.
      await c.query(
        `WITH gone AS (DELETE FROM reactions WHERE user_id = $1 RETURNING post_id)
         UPDATE posts SET like_count = greatest(like_count - 1, 0) WHERE id IN (SELECT post_id FROM gone)`,
        [u.id],
      );
      await c.query(
        `WITH gone AS (DELETE FROM post_reposts WHERE user_id = $1 RETURNING post_id)
         UPDATE posts SET repost_count = greatest(repost_count - 1, 0) WHERE id IN (SELECT post_id FROM gone)`,
        [u.id],
      );
      await c.query(
        `WITH gone AS (DELETE FROM community_members WHERE user_id = $1 RETURNING community_id, status)
         UPDATE communities SET member_count = greatest(member_count - 1, 0) WHERE id IN (SELECT community_id FROM gone WHERE status = 'active')`,
        [u.id],
      );
      // Their boosts stop (a review still waiting is closed); what they didn't spend is refunded below.
      const campaigns = await c.query<{ id: string }>(
        `UPDATE ad_campaigns SET status = 'ended' WHERE advertiser_id = $1 AND status IN ('draft', 'pending_review', 'active', 'paused') RETURNING id`,
        [u.id],
      );
      endedCampaigns = campaigns.rows.map((r) => r.id);
      await c.query(
        `UPDATE moderation_cases SET status = 'decided', decision = 'no_action', note = 'Withdrawn: the account was deleted', decided_at = now()
         WHERE target_type = 'ad_campaign' AND target_id = ANY($1) AND status = 'open'`,
        [endedCampaigns],
      );
      // Drops still to come or open are cancelled as the seller would: unpaid orders are cancelled and
      // their units released, paid ones stay paid, and everyone waiting is told.
      const drops = await c.query<{ id: string; title: string }>(
        `UPDATE drops SET status = 'cancelled', cancelled_at = now(), updated_at = now() WHERE seller_id = $1 AND status IN ('scheduled', 'open') RETURNING id, title`,
        [u.id],
      );
      for (const d of drops.rows) {
        const pending = await c.query<{ order_id: string }>(
          `SELECT o.id AS order_id FROM orders o
           WHERE o.status = 'pending' AND o.id IN (SELECT order_id FROM drop_orders WHERE drop_id = $1 AND status = 'held') FOR UPDATE`,
          [d.id],
        );
        for (const o of pending.rows) {
          await c.query(`UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = $1`, [o.order_id]);
          await releaseDropOrder(c, o.order_id);
        }
        const waiting = await c.query<{ user_id: string }>(`SELECT user_id FROM drop_reminders WHERE drop_id = $1`, [d.id]);
        for (const w of waiting.rows)
          await notify(c, ctx.realtime, {
            userId: w.user_id,
            category: 'commerce',
            type: 'drop_cancelled',
            actorId: u.id,
            entityType: 'drop',
            entityId: d.id,
            data: { title: d.title },
          });
      }
      await c.query(`INSERT INTO privacy_requests (user_id, kind, status, completed_at) VALUES ($1,'delete','completed',now())`, [u.id]);
      await securityEvent(c, u.id, 'account_deleted', req.ip);
      await audit(c, { actorId: u.id, action: 'account.delete', entityType: 'user', entityId: u.id, ip: req.ip, requestId: req.id });
    });
    // Unspent boost budgets go back to the payments that funded them, one campaign at a time; a refund
    // that fails is only logged (and recorded as failed, like any other refund).
    for (const id of endedCampaigns)
      await tx(db, (c) => refundUnspentBudget(c, ctx.paymentProviders, id, null)).catch((err: unknown) =>
        req.log.warn({ err, campaignId: id }, 'could not refund a deleted account’s unspent boost budget'),
      );
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
