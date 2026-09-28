import type { Pool, PoolClient } from 'pg';

type Q = Pool | PoolClient;

/**
 * Limits for the parts of "Download a copy of your data" that can grow without end. Views,
 * ads seen and product analytics are counted per day (UTC) or per event name instead of listed
 * one by one; the lists below keep the newest rows. docs/product/status.md repeats these.
 */
export const EXPORT_LIMITS = {
  /** Days of per-day counts (views, ads seen, view-once opens): about 13 months. */
  days: 400,
  notifications: 5000,
  feedFeedback: 5000,
  media: 20000,
  liveChat: 5000,
  gameMoves: 5000,
  reelResume: 1000,
  sessions: 500,
  assistantCalls: 1000,
  auditLog: 1000,
} as const;

/** Someone else, by username only. Qualify the column: a bare user_id would mean the profile's own. */
export const usernameOf = (col: string) => `(SELECT username FROM profiles WHERE user_id = ${col})`;
const un = usernameOf;
/** A stored file's address, only while it can still be opened (not deleted, not a private view-once file). */
const openUrl = (m: string, col = 'url') => `CASE WHEN ${m}.deleted_at IS NULL AND NOT ${m}.private THEN ${m}.${col} END`;

/**
 * Everything added to the data export beyond the original sections (see privacy.ts), grouped
 * by kind. Rules followed throughout:
 * - Other people appear by username only: never their email, phone, birth date or ids of their private things.
 * - No secrets or one-time material: no session, reset, sign-in, OAuth or download tokens, no
 *   password, key, code or token hashes, no two-step secrets, passkey keys, stream keys or
 *   webhook secrets, and nothing from unfinished uploads.
 * - Files are not included; their addresses are, while the person can still open them.
 * - Internal checks: the automated risk flags on the account are summarised as counts by status
 *   with dates, never what was detected or how (kinds, weights, details), so the export can't be
 *   used to learn how spam and abuse are spotted. The audit log lists the person's own actions
 *   (what and when), without IP address, request id or the details, which can name other people.
 * - Reports about the person show as the moderation decisions, enforcements and appeals, never who
 *   reported them. Open cases that haven't been decided are left out, as on the "Your moderation" page.
 */
export async function exportSections(db: Q, userId: string) {
  const q = (sql: string) => db.query(sql, [userId]).then((r) => r.rows);
  const first = async (sql: string) => (await q(sql))[0] ?? null;
  const perDay = (table: string, userCol: string, timeCol: string, extra = '') =>
    q(
      `SELECT ${timeCol}::date AS day, count(*)::int AS count${extra} FROM ${table} WHERE ${userCol} = $1
       GROUP BY 1 ORDER BY 1 DESC LIMIT ${EXPORT_LIMITS.days}`,
    );

  const content = {
    // Stories: the photo or video address only while the story isn't deleted.
    stories: await q(
      `SELECT id, body, CASE WHEN deleted_at IS NULL THEN media_url END AS media_url, media_kind, visibility, location_text, stickers, tags, mentions,
              reshare_of, allow_reshare, sound_id, music, lang, created_at, expires_at, deleted_at
       FROM moments WHERE author_id = $1 ORDER BY created_at DESC`,
    ),
    storyResponses: await q(
      `SELECT moment_id, sticker_id, kind, choice, value, answer, remind_at, created_at FROM story_responses WHERE user_id = $1 ORDER BY created_at DESC`,
    ),
    chapters: await q(
      `SELECT c.id, c.title, c.description, c.audience, c.cover_moment_id, c.cover_gradient, c.cover_symbol, c.opens_at, c.sealed_at, c.created_at, c.deleted_at,
              coalesce((SELECT array_agg(i.moment_id ORDER BY i.added_at) FROM chapter_items i WHERE i.chapter_id = c.id), '{}') AS moment_ids,
              coalesce((SELECT json_agg(json_build_object('username', ${un('m.user_id')}, 'status', m.status)) FROM chapter_members m WHERE m.chapter_id = c.id), '[]') AS members
       FROM chapters c WHERE c.owner_id = $1 ORDER BY c.created_at DESC`,
    ),
    chaptersYouAreIn: await q(
      `SELECT m.chapter_id, c.title, ${un('c.owner_id')} AS owner, m.status, m.show_on_profile, m.invited_at, m.joined_at
       FROM chapter_members m JOIN chapters c ON c.id = m.chapter_id WHERE m.user_id = $1 ORDER BY m.invited_at DESC`,
    ),
    guestbookEntries: await q(
      `SELECT chapter_id, body, status, hidden_at, created_at, updated_at FROM chapter_guestbook WHERE author_id = $1 ORDER BY created_at DESC`,
    ),
    boards: await q(
      `SELECT b.id, b.name, b.description, b.visibility, b.cover_post_id, b.created_at, b.updated_at,
              coalesce((SELECT json_agg(json_build_object('post_id', i.post_id, 'added_by', ${un('i.added_by')}, 'added_at', i.added_at) ORDER BY i.position)
                        FROM board_items i WHERE i.board_id = b.id), '[]') AS items,
              coalesce((SELECT json_agg(json_build_object('username', ${un('m.user_id')}, 'status', m.status)) FROM board_members m WHERE m.board_id = b.id), '[]') AS members
       FROM boards b WHERE b.owner_id = $1 ORDER BY b.created_at DESC`,
    ),
    boardsYouAreIn: await q(
      `SELECT m.board_id, b.name, ${un('b.owner_id')} AS owner, m.status, m.invited_at, m.joined_at,
              coalesce((SELECT json_agg(json_build_object('post_id', i.post_id, 'added_at', i.added_at)) FROM board_items i WHERE i.board_id = b.id AND i.added_by = $1), '[]') AS your_items
       FROM board_members m JOIN boards b ON b.id = m.board_id WHERE m.user_id = $1 ORDER BY m.invited_at DESC`,
    ),
    saves: await q(`SELECT post_id, note, created_at, note_updated_at FROM saves WHERE user_id = $1 ORDER BY created_at DESC`),
    memories: await q(
      `SELECT mem.id, mem.title, mem.kind, mem.description, mem.recap, mem.starts_at, mem.ends_at, mem.visibility, mem.source_type, mem.source_id, mem.created_at, mem.updated_at,
              coalesce((SELECT json_agg(json_build_object('type', i.item_type, 'id', i.item_id, 'note', i.note, 'added_at', i.added_at)) FROM memory_items i WHERE i.memory_id = mem.id), '[]') AS items,
              coalesce((SELECT array_agg(${un('s.user_id')}) FROM memory_shares s WHERE s.memory_id = mem.id), '{}') AS shared_with
       FROM memories mem WHERE mem.owner_id = $1 ORDER BY mem.created_at DESC`,
    ),
    memoriesSharedWithYou: await q(
      `SELECT s.memory_id, mem.title, ${un('mem.owner_id')} AS owner FROM memory_shares s JOIN memories mem ON mem.id = s.memory_id WHERE s.user_id = $1`,
    ),
    recaps: await q(
      `SELECT r.id, r.source_type, r.source_id, r.title, r.style, r.aspect, r.length_seconds, r.status, r.created_at, r.finished_at, r.deleted_at,
              CASE WHEN r.deleted_at IS NULL THEN ${openUrl('m')} END AS video_url
       FROM recaps r LEFT JOIN media m ON m.id = r.media_id WHERE r.owner_id = $1 ORDER BY r.created_at DESC`,
    ),
    lives: await q(
      `SELECT l.id, l.title, l.status, l.visibility, l.scheduled_for, l.started_at, l.ended_at, l.peak_viewers, l.recording_status, l.created_at,
              ${openUrl('m')} AS recording_url
       FROM live_sessions l LEFT JOIN media m ON m.id = l.recording_media_id WHERE l.host_id = $1 ORDER BY l.created_at DESC`,
    ),
    livesJoined: await q(`SELECT session_id, role, joined_at, left_at, banned FROM live_participants WHERE user_id = $1 ORDER BY joined_at DESC`),
    liveChat: await q(
      `SELECT session_id, kind, body, answered, amount_cents, currency, created_at FROM live_chat WHERE user_id = $1 AND deleted_at IS NULL
       ORDER BY created_at DESC LIMIT ${EXPORT_LIMITS.liveChat}`,
    ),
    rooms: await q(
      `SELECT r.id, r.title, r.status, c.slug AS community, r.scheduled_for, r.started_at, r.ended_at, r.peak_listeners, r.created_at
       FROM rooms r JOIN communities c ON c.id = r.community_id WHERE r.created_by = $1 ORDER BY r.created_at DESC`,
    ),
    roomsJoined: await q(
      `SELECT room_id, role, is_host, joined_at, left_at, removed_at FROM room_participants WHERE user_id = $1 ORDER BY coalesce(joined_at, invited_at) DESC`,
    ),
    roomReminders: await q(`SELECT room_id, created_at FROM room_reminders WHERE user_id = $1`),
    products: await q(
      `SELECT p.id, p.kind, p.title, p.description, p.price_cents, p.currency, p.inventory, p.status, p.business_id, p.event_id, p.created_at, p.updated_at, p.deleted_at,
              (SELECT json_build_object('filename', f.filename, 'mime', f.mime, 'size_bytes', f.size_bytes, 'uploaded_at', f.uploaded_at)
               FROM product_files f WHERE f.product_id = p.id) AS file
       FROM products p WHERE p.seller_id = $1 ORDER BY p.created_at DESC`,
    ),
    drops: await q(
      `SELECT d.id, d.title, d.description, CASE WHEN d.deleted_at IS NULL THEN d.cover_url END AS cover_url, d.cover_alt, d.starts_at, d.ends_at, d.status,
              d.end_reason, d.published_at, d.opened_at, d.ended_at, d.cancelled_at, d.created_at, d.deleted_at,
              coalesce((SELECT json_agg(json_build_object('product_id', i.product_id, 'quantity', i.quantity, 'per_buyer_limit', i.per_buyer_limit, 'taken', i.taken) ORDER BY i.position)
                        FROM drop_items i WHERE i.drop_id = d.id), '[]') AS products
       FROM drops d WHERE d.seller_id = $1 ORDER BY d.created_at DESC`,
    ),
    businesses: await q(
      `SELECT id, slug, name, description, category, website, verified_at, created_at, updated_at, deleted_at FROM businesses WHERE owner_id = $1 ORDER BY created_at`,
    ),
    places: await q(
      `SELECT id, name, category, description, address, city, country, lat, lng, hours, business_id, booking_capacity, created_at, deleted_at
       FROM places WHERE created_by = $1 ORDER BY created_at`,
    ),
    placeReviews: await q(
      `SELECT r.place_id, p.name AS place, r.rating, r.body, r.moderation_status, r.created_at, r.updated_at
       FROM place_reviews r JOIN places p ON p.id = r.place_id WHERE r.author_id = $1 ORDER BY r.created_at DESC`,
    ),
    eventsHosted: await q(
      `SELECT id, title, description, starts_at, ends_at, timezone, location_text, online, capacity, visibility, created_at, deleted_at FROM events WHERE host_id = $1 ORDER BY starts_at DESC`,
    ),
    communitiesOwned: await q(
      `SELECT slug, name, description, visibility, topics, rules, created_at, deleted_at FROM communities WHERE owner_id = $1 ORDER BY created_at`,
    ),
    communityFaqsWritten: await q(
      `SELECT c.slug AS community, f.question, f.answer, f.created_at, f.updated_at FROM community_faqs f JOIN communities c ON c.id = f.community_id WHERE f.created_by = $1`,
    ),
    togethers: await q(`SELECT id, title, status, closes_at, event_id, created_at FROM togethers WHERE creator_id = $1 ORDER BY created_at DESC`),
    togethersYouAreIn: await q(
      `SELECT m.together_id, t.title, ${un('t.creator_id')} AS creator, m.role, m.joined_at FROM together_members m JOIN togethers t ON t.id = m.together_id WHERE m.user_id = $1`,
    ),
    togetherPhotos: await q(
      `SELECT c.together_id, c.caption, c.captured_at, c.created_at, c.deleted_at, CASE WHEN c.deleted_at IS NULL THEN ${openUrl('m')} END AS url
       FROM together_contributions c LEFT JOIN media m ON m.id = c.media_id WHERE c.user_id = $1 ORDER BY c.created_at DESC`,
    ),
    // Who you chose for posts shared with selected people, and posts you made with others.
    postAudiences: await q(
      `SELECT a.post_id, array_agg(${un('a.user_id')}) AS people FROM post_audience a JOIN posts p ON p.id = a.post_id WHERE p.author_id = $1 GROUP BY a.post_id`,
    ),
    collaborations: await q(
      `SELECT c.post_id, CASE WHEN c.user_id = $1 THEN 'invited' ELSE 'you invited' END AS role,
              ${un('CASE WHEN c.user_id = $1 THEN c.invited_by ELSE c.user_id END')} AS with, c.status, c.created_at, c.responded_at
       FROM post_collaborators c WHERE c.user_id = $1 OR c.invited_by = $1 ORDER BY c.created_at DESC`,
    ),
    photoTags: await q(
      `SELECT t.post_id, CASE WHEN t.user_id = $1 THEN 'you were tagged' ELSE 'you tagged' END AS role,
              ${un('CASE WHEN t.user_id = $1 THEN t.tagged_by ELSE t.user_id END')} AS with, t.created_at
       FROM photo_tags t WHERE t.user_id = $1 OR t.tagged_by = $1 ORDER BY t.created_at DESC`,
    ),
    // Details of your uploads; the address only while you can still open the file.
    media: await q(
      `SELECT m.id, m.kind, m.mime, m.width, m.height, m.duration_ms, m.size_bytes, m.alt_text, m.status, m.moderation, m.private, m.created_at, m.deleted_at,
              ${openUrl('m')} AS url, ${openUrl('m', 'poster_url')} AS poster_url, ${openUrl('m', 'hls_url')} AS hls_url
       FROM media m WHERE m.owner_id = $1 ORDER BY m.created_at DESC LIMIT ${EXPORT_LIMITS.media}`,
    ),
    captions: await q(
      `SELECT t.media_id, t.lang, t.label, t.source, t.status, t.cue_count, CASE WHEN t.status = 'ready' THEN t.url END AS url, t.created_at
       FROM caption_tracks t JOIN media m ON m.id = t.media_id WHERE m.owner_id = $1 OR t.created_by = $1`,
    ),
    mediaEdits: await q(
      `SELECT source_media_id, result_media_id, kind, start_ms, end_ms, auto, status, created_at, finished_at FROM media_edits WHERE owner_id = $1 ORDER BY created_at DESC`,
    ),
    editorRenders: await q(
      `SELECT source_media_id, result_media_id, kind, params, status, created_at, finished_at FROM media_editor_renders WHERE owner_id = $1 ORDER BY created_at DESC`,
    ),
    shareVideos: await q(
      `SELECT v.post_id, v.status, CASE WHEN v.status = 'ready' THEN v.url END AS url, v.created_at FROM share_videos v JOIN posts p ON p.id = v.post_id WHERE p.author_id = $1`,
    ),
    musicSaves: await q(
      `SELECT s.track_id, t.title AS track, t.artist, s.sound_id, s.created_at FROM music_saves s LEFT JOIN music_tracks t ON t.id = s.track_id WHERE s.user_id = $1 ORDER BY s.created_at DESC`,
    ),
    adCampaigns: await q(
      `SELECT id, name, status, post_id, business_id, topics, locales, countries, boost_days, cpm_cents, currency, budget_millicents, spent_millicents, refunded_millicents,
              impressions, clicks, starts_at, ends_at, submitted_at, approved_at, review_note, created_at
       FROM ad_campaigns WHERE advertiser_id = $1 ORDER BY created_at DESC`,
    ),
  };

  const chats = {
    // Chats you are or were in. Other people's messages are never included.
    conversations: await q(
      `SELECT c.id, c.kind, c.title, c.created_by = $1 AS you_started_it, m.role, m.joined_at, m.left_at, m.last_read_at, m.yaps_out_loud, m.smart_replies
       FROM conversation_members m JOIN conversations c ON c.id = m.conversation_id WHERE m.user_id = $1 ORDER BY m.joined_at DESC`,
    ),
    // Earlier versions of messages you edited.
    messageEdits: await q(
      `SELECT e.message_id, e.body, e.edited_at FROM message_edits e JOIN messages m ON m.id = e.message_id WHERE m.sender_id = $1 AND m.deleted_at IS NULL`,
    ),
    messageReactions: await q(`SELECT message_id, emoji FROM message_reactions WHERE user_id = $1`),
    messagesHidden: await q(`SELECT message_id, hidden_at FROM message_hides WHERE user_id = $1`),
    messagesPinned: await q(`SELECT conversation_id, message_id, pinned_at FROM conversation_pins WHERE pinned_by = $1`),
    reminders: await q(
      `SELECT conversation_id, message_id, scope, remind_at, sent_at, created_at FROM chat_reminders WHERE user_id = $1 ORDER BY remind_at DESC`,
    ),
    polls: await q(
      `SELECT p.message_id, p.conversation_id, p.question, p.multiple, p.anonymous, p.ends_at, p.ended_at, p.created_at,
              coalesce((SELECT array_agg(o.text ORDER BY o.position) FROM chat_poll_options o WHERE o.message_id = p.message_id), '{}') AS options
       FROM chat_polls p WHERE p.created_by = $1 ORDER BY p.created_at DESC`,
    ),
    pollOptionsAdded: await q(
      `SELECT o.message_id, o.text, o.created_at FROM chat_poll_options o JOIN chat_polls p ON p.message_id = o.message_id WHERE o.added_by = $1 AND p.created_by <> $1`,
    ),
    pollVotes: await q(
      `SELECT v.message_id, o.text AS option, v.voted_at FROM chat_poll_votes v JOIN chat_poll_options o ON o.id = v.option_id WHERE v.user_id = $1 ORDER BY v.voted_at DESC`,
    ),
    lists: await q(
      `SELECT l.message_id, l.conversation_id, l.title, l.created_at,
              coalesce((SELECT json_agg(json_build_object('text', i.text, 'done', i.done_at IS NOT NULL) ORDER BY i.position) FROM chat_list_items i WHERE i.message_id = l.message_id), '[]') AS items
       FROM chat_lists l WHERE l.created_by = $1 ORDER BY l.created_at DESC`,
    ),
    listItemsAdded: await q(
      `SELECT i.message_id, i.text, i.done_at, i.created_at FROM chat_list_items i JOIN chat_lists l ON l.message_id = i.message_id WHERE i.added_by = $1 AND l.created_by <> $1`,
    ),
    plans: await q(`SELECT id, conversation_id, title, details, status, created_at FROM plans WHERE created_by = $1 ORDER BY created_at DESC`),
    gameMoves: await q(
      `SELECT game_id, number, move, created_at FROM chat_game_moves WHERE player_id = $1 ORDER BY created_at DESC LIMIT ${EXPORT_LIMITS.gameMoves}`,
    ),
    calls: await q(
      `SELECT c.id, c.conversation_id, c.kind, c.status, c.caller_id = $1 AS you_called, c.created_at, c.answered_at, c.ended_at, p.joined_at, p.left_at
       FROM calls c LEFT JOIN call_participants p ON p.call_id = c.id AND p.user_id = $1
       WHERE c.caller_id = $1 OR p.user_id = $1 ORDER BY c.created_at DESC`,
    ),
    watchTogether: await q(
      `SELECT s.id AS session_id, s.conversation_id, s.started_by = $1 AS you_started_it, s.created_at, s.ended_at, p.joined_at, p.left_at,
              coalesce((SELECT json_agg(json_build_object('post_id', i.post_id, 'added_at', i.created_at)) FROM watch_queue_items i WHERE i.session_id = s.id AND i.added_by = $1), '[]') AS you_added
       FROM watch_sessions s LEFT JOIN watch_participants p ON p.session_id = s.id AND p.user_id = $1
       WHERE s.started_by = $1 OR p.user_id = $1 ORDER BY s.created_at DESC`,
    ),
  };

  const activity = {
    reposts: await q(`SELECT post_id, created_at FROM post_reposts WHERE user_id = $1 ORDER BY created_at DESC`),
    pollVotes: await q(`SELECT v.post_id, o.label AS option FROM poll_votes v JOIN poll_options o ON o.id = v.option_id WHERE v.user_id = $1`),
    // Counted per day (UTC), not listed one by one.
    postsViewedPerDay: await perDay('post_views', 'viewer_id', 'viewed_at'),
    storiesViewedPerDay: await perDay('moment_views', 'viewer_id', 'viewed_at', ', count(*) FILTER (WHERE liked)::int AS liked'),
    businessPagesViewedPerDay: await perDay('business_views', 'viewer_id', 'day'),
    viewOnceOpenedPerDay: await perDay('message_views', 'user_id', 'opened_at'),
    sponsoredPostsPerDay: await perDay(
      'ad_events',
      'user_id',
      'created_at',
      `, count(*) FILTER (WHERE kind = 'impression')::int AS seen, count(*) FILTER (WHERE kind = 'click')::int AS opened`,
    ),
    reelsResumeAt: await q(
      `SELECT post_id, position_ms, updated_at FROM reel_resume WHERE user_id = $1 ORDER BY updated_at DESC LIMIT ${EXPORT_LIMITS.reelResume}`,
    ),
    feedFeedback: await q(
      `SELECT signal, post_id, ${un('feed_feedback.author_id')} AS author, topic, created_at FROM feed_feedback WHERE user_id = $1 ORDER BY created_at DESC LIMIT ${EXPORT_LIMITS.feedFeedback}`,
    ),
    minutesPerDay: await q(`SELECT day, minutes FROM usage_days WHERE user_id = $1 ORDER BY day DESC`),
    lastVisit: await first(`SELECT last_seen_at, away_since, back_at, dismissed FROM pulse_visits WHERE user_id = $1`),
    notifications: await q(
      `SELECT category, type, ${un('actor_id')} AS actor, entity_type, entity_id, data, read_at, created_at FROM notifications WHERE user_id = $1
       ORDER BY created_at DESC LIMIT ${EXPORT_LIMITS.notifications}`,
    ),
    // Product analytics linked to you (none while Analytics is off): how often each event happened.
    productAnalytics: await q(
      `SELECT name, count(*)::int AS count, min(created_at) AS first_at, max(created_at) AS last_at FROM analytics_events WHERE user_id = $1 GROUP BY name ORDER BY name`,
    ),
    dropReminders: await q(
      `SELECT r.drop_id, d.title, r.created_at, r.notified_at FROM drop_reminders r JOIN drops d ON d.id = r.drop_id WHERE r.user_id = $1 ORDER BY r.created_at DESC`,
    ),
  };

  const relationships = {
    friends: await q(
      `SELECT ${un('CASE WHEN f.user_a = $1 THEN f.user_b ELSE f.user_a END')} AS username, f.created_at FROM friendships f WHERE f.user_a = $1 OR f.user_b = $1 ORDER BY f.created_at`,
    ),
    friendRequests: await q(
      `SELECT CASE WHEN from_user_id = $1 THEN 'sent' ELSE 'received' END AS direction, ${un('CASE WHEN from_user_id = $1 THEN to_user_id ELSE from_user_id END')} AS username,
              status, created_at, responded_at
       FROM friend_requests WHERE from_user_id = $1 OR to_user_id = $1 ORDER BY created_at DESC`,
    ),
    blocked: await q(`SELECT ${un('blocked_id')} AS username, created_at FROM blocks WHERE blocker_id = $1 ORDER BY created_at`),
    muted: await q(`SELECT ${un('muted_id')} AS username, created_at FROM mutes WHERE muter_id = $1 ORDER BY created_at`),
    restricted: await q(`SELECT ${un('restricted_id')} AS username, created_at FROM restrictions WHERE restrictor_id = $1 ORDER BY created_at`),
    family: await q(
      `SELECT CASE WHEN guardian_id = $1 THEN 'you are the parent or guardian' ELSE 'you are the teen' END AS role,
              ${un('CASE WHEN guardian_id = $1 THEN teen_id ELSE guardian_id END')} AS username, status, created_at, accepted_at, ended_at
       FROM family_links WHERE guardian_id = $1 OR teen_id = $1 ORDER BY created_at`,
    ),
  };

  // Orders where you are the seller or the one paid (tips, subscriptions, bookings): buyers by username,
  // and only your own products in each order.
  const sales = await q(
    `SELECT o.id, o.purpose, o.status, o.currency, o.created_at, ${un('o.buyer_id')} AS buyer,
            CASE WHEN o.payee_id = $1 THEN o.total_cents END AS total_cents, CASE WHEN o.payee_id = $1 THEN o.platform_fee_cents END AS platform_fee_cents,
            coalesce((SELECT json_agg(json_build_object('product_id', p.id, 'title', p.title, 'quantity', i.quantity, 'unit_cents', i.unit_cents))
                      FROM order_items i JOIN products p ON p.id = i.product_id WHERE i.order_id = o.id AND p.seller_id = $1), '[]') AS items
     FROM orders o
     WHERE o.payee_id = $1 OR EXISTS (SELECT 1 FROM order_items i JOIN products p ON p.id = i.product_id WHERE i.order_id = o.id AND p.seller_id = $1)
     ORDER BY o.created_at DESC`,
  );
  const money = {
    sales,
    payments: await q(
      `SELECT pay.order_id, pay.provider, pay.status, pay.amount_cents, pay.currency, pay.created_at FROM payments pay JOIN orders o ON o.id = pay.order_id WHERE o.buyer_id = $1
       ORDER BY pay.created_at DESC`,
    ),
    refunds: await q(
      `SELECT pay.order_id, CASE WHEN o.buyer_id = $1 THEN 'to you' ELSE 'from you' END AS direction, r.amount_cents, pay.currency, r.reason, r.status, r.created_at
       FROM refunds r JOIN payments pay ON pay.id = r.payment_id JOIN orders o ON o.id = pay.order_id
       WHERE o.buyer_id = $1 OR o.payee_id = $1
          OR EXISTS (SELECT 1 FROM order_items i JOIN products p ON p.id = i.product_id WHERE i.order_id = o.id AND p.seller_id = $1)
       ORDER BY r.created_at DESC`,
    ),
    tipsGiven: await q(
      `SELECT ${un('t.to_id')} AS to, t.post_id, t.live_id, t.message, o.total_cents AS amount_cents, o.currency, o.status, t.created_at
       FROM tips t JOIN orders o ON o.id = t.order_id WHERE t.from_id = $1 ORDER BY t.created_at DESC`,
    ),
    tipsReceived: await q(
      `SELECT ${un('t.from_id')} AS from, t.post_id, t.live_id, t.message, o.total_cents AS amount_cents, o.currency, o.status, t.created_at
       FROM tips t JOIN orders o ON o.id = t.order_id WHERE t.to_id = $1 ORDER BY t.created_at DESC`,
    ),
    subscriptionPlans: await q(`SELECT id, name, description, price_cents, currency, active, created_at FROM creator_plans WHERE creator_id = $1`),
    subscriptions: await q(
      `SELECT ${un('s.creator_id')} AS creator, p.name AS plan, s.status, s.current_period_end, s.created_at, s.cancelled_at
       FROM creator_subscriptions s JOIN creator_plans p ON p.id = s.plan_id WHERE s.subscriber_id = $1 ORDER BY s.created_at DESC`,
    ),
    subscribers: await q(
      `SELECT ${un('s.subscriber_id')} AS subscriber, p.name AS plan, s.status, s.current_period_end, s.created_at, s.cancelled_at
       FROM creator_subscriptions s JOIN creator_plans p ON p.id = s.plan_id WHERE s.creator_id = $1 ORDER BY s.created_at DESC`,
    ),
    payouts: await q(`SELECT amount_cents, currency, status, created_at FROM payouts WHERE user_id = $1 ORDER BY created_at DESC`),
    bookings: await q(
      `SELECT b.id, coalesce(pl.name, pd.title) AS at, b.party_size, b.starts_at, b.status, b.note, b.created_at, b.decided_at
       FROM bookings b LEFT JOIN places pl ON pl.id = b.place_id LEFT JOIN products pd ON pd.id = b.product_id WHERE b.user_id = $1 ORDER BY b.starts_at DESC`,
    ),
    bookingsReceived: await q(
      `SELECT b.id, coalesce(pl.name, pd.title) AS at, ${un('b.user_id')} AS customer, b.party_size, b.starts_at, b.status, b.note, b.created_at, b.decided_at
       FROM bookings b LEFT JOIN places pl ON pl.id = b.place_id LEFT JOIN businesses bz ON bz.id = pl.business_id LEFT JOIN products pd ON pd.id = b.product_id
       WHERE (pl.created_by = $1 OR bz.owner_id = $1 OR pd.seller_id = $1) AND b.user_id <> $1 ORDER BY b.starts_at DESC`,
    ),
    dropPurchases: await q(
      `SELECT o.drop_id, d.title AS drop, p.title AS product, o.quantity, o.status, o.created_at
       FROM drop_orders o JOIN drops d ON d.id = o.drop_id JOIN products p ON p.id = o.product_id WHERE o.buyer_id = $1 ORDER BY o.created_at DESC`,
    ),
    plusGrants: await q(`SELECT source, days, starts_at, ends_at, revoked_at, created_at FROM plus_grants WHERE user_id = $1 ORDER BY created_at DESC`),
  };

  const safety = {
    // Reports you made: what kind of thing, why, and what happened.
    reportsMade: await q(`SELECT target_type, reason, details, status, created_at FROM reports WHERE reporter_id = $1 ORDER BY created_at DESC`),
    // Decisions about your posts and account (never who reported them), what was applied, and your appeals.
    moderationDecisions: await q(
      `SELECT id, target_type, target_id, status, decision, created_at, decided_at FROM moderation_cases
       WHERE subject_user_id = $1 AND decision IS NOT NULL AND decision <> 'no_action' AND target_type <> 'ad_campaign' ORDER BY decided_at DESC`,
    ),
    enforcements: await q(`SELECT case_id, action, expires_at, created_at FROM enforcements WHERE user_id = $1 ORDER BY created_at DESC`),
    appeals: await q(`SELECT case_id, statement, status, created_at FROM appeals WHERE user_id = $1 ORDER BY created_at DESC`),
    // Automated checks on the account, as counts only (see the note at the top of this file).
    accountReview: {
      limitedSince: (await first(`SELECT restricted_at FROM users WHERE id = $1`))?.restricted_at ?? null,
      automatedFlags: await q(
        `SELECT status, count(*)::int AS count, min(created_at) AS first_at, max(created_at) AS last_at FROM risk_signals WHERE user_id = $1 GROUP BY status ORDER BY status`,
      ),
    },
    // Actions of yours recorded for security and accountability: what and when.
    auditLog: await q(`SELECT action, entity_type, created_at FROM audit_logs WHERE actor_id = $1 ORDER BY created_at DESC LIMIT ${EXPORT_LIMITS.auditLog}`),
    // For team members: how much review work is recorded under your name.
    staffWork: await first(
      `SELECT (SELECT count(*) FROM moderation_cases WHERE reviewer_id = $1)::int AS cases_reviewed,
              (SELECT count(*) FROM risk_signals WHERE reviewed_by = $1)::int AS flags_reviewed,
              (SELECT count(*) FROM regional_rules WHERE created_by = $1)::int AS regional_rules_added`,
    ),
  };

  const ai = {
    catchUps: await q(`SELECT away_since, back_at, output, created_at FROM ai_catchups WHERE user_id = $1 ORDER BY created_at DESC`),
    replySuggestions: await q(`SELECT message_id, suggestions, lang, created_at FROM ai_reply_suggestions WHERE user_id = $1 ORDER BY created_at DESC`),
    assistantConversations: await q(`SELECT id, agent, created_at FROM ai_conversations WHERE user_id = $1 ORDER BY created_at DESC`),
    // The log of assistant and translation calls made for you (no content is logged).
    assistantCalls: await q(
      `SELECT task, provider, model, context_scopes, status, created_at FROM ai_tool_calls WHERE user_id = $1 ORDER BY created_at DESC LIMIT ${EXPORT_LIMITS.assistantCalls}`,
    ),
  };

  const security = {
    devices: await q(`SELECT name, platform, created_at, last_seen_at FROM devices WHERE user_id = $1 ORDER BY last_seen_at DESC`),
    sessions: await q(
      `SELECT d.name AS device, s.user_agent, host(s.ip) AS ip, s.created_at, s.last_seen_at, s.expires_at, s.revoked_at
       FROM sessions s LEFT JOIN devices d ON d.id = s.device_id WHERE s.user_id = $1 ORDER BY s.created_at DESC LIMIT ${EXPORT_LIMITS.sessions}`,
    ),
    twoStep: {
      enabled: (await first(`SELECT mfa_enabled FROM users WHERE id = $1`))?.mfa_enabled ?? false,
      methods: await q(`SELECT kind, label, created_at, confirmed_at, last_used_at FROM mfa_factors WHERE user_id = $1 ORDER BY created_at`),
      recoveryCodes: await first(`SELECT count(*)::int AS total, count(used_at)::int AS used FROM mfa_recovery_codes WHERE user_id = $1`),
    },
    passkeys: await q(`SELECT label, device_type, backed_up, transports, created_at, last_used_at FROM passkeys WHERE user_id = $1 ORDER BY created_at`),
    phoneChecks: await q(
      `SELECT phone_e164, host(ip) AS ip, provider, created_at, verified_at FROM phone_verifications WHERE user_id = $1 ORDER BY created_at DESC`,
    ),
    notificationDevices: await q(`SELECT kind, created_at, last_ok_at FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at`),
    connectedApps: await q(
      `SELECT a.name AS app, g.scopes, g.created_at, g.last_used_at, g.revoked_at FROM oauth_grants g JOIN developer_apps a ON a.id = g.app_id WHERE g.user_id = $1
       ORDER BY g.created_at DESC`,
    ),
  };

  const developer = {
    apps: await q(
      `SELECT a.id, a.name, a.description, a.website, a.redirect_uris, a.created_at, a.deleted_at,
              coalesce((SELECT json_agg(json_build_object('name', k.name, 'scopes', k.scopes, 'created_at', k.created_at, 'last_used_at', k.last_used_at,
                                                          'expires_at', k.expires_at, 'revoked_at', k.revoked_at) ORDER BY k.created_at)
                        FROM api_keys k WHERE k.app_id = a.id), '[]') AS keys,
              coalesce((SELECT json_agg(json_build_object('url', w.url, 'events', w.events, 'active', w.active, 'created_at', w.created_at))
                        FROM webhook_subscriptions w WHERE w.app_id = a.id), '[]') AS webhooks,
              coalesce((SELECT json_agg(json_build_object('name', m.name, 'description', m.description, 'entry_url', m.entry_url, 'status', m.status, 'created_at', m.created_at))
                        FROM mini_apps m WHERE m.app_id = a.id), '[]') AS mini_apps
       FROM developer_apps a WHERE a.owner_id = $1 ORDER BY a.created_at`,
    ),
    miniAppsAdded: await q(
      `SELECT m.name AS mini_app, i.surface, i.surface_id, i.created_at FROM mini_app_installs i JOIN mini_apps m ON m.id = i.mini_app_id WHERE i.installed_by = $1`,
    ),
  };

  const invites = {
    code: await first(`SELECT code, created_at FROM invite_codes WHERE user_id = $1`),
    peopleYouInvited: await q(`SELECT ${un('invitee_id')} AS username, created_at, qualified_at FROM referrals WHERE inviter_id = $1 ORDER BY created_at`),
    invitedBy: await first(`SELECT ${un('inviter_id')} AS username, created_at, qualified_at FROM referrals WHERE invitee_id = $1`),
  };

  const settings = {
    preferences: await first(
      `SELECT notification_categories, focus_mode, quiet_mode, friends_only, reduced_recommendations, daily_time_budget_minutes, notifications_paused_until, yaps_paused,
              data_saver, languages, auto_translate, messages_from, comments_from, mentions_from, quiet_start, quiet_end, quiet_timezone, sensitive_media,
              sign_in_email_alerts, smart_replies, catch_up, weekly_wrap, weekly_wrap_notify, timezone, updated_at
       FROM user_preferences WHERE user_id = $1`,
    ),
    teenControls: await first(
      `SELECT messages_from, daily_limit_minutes, quiet_start, quiet_end, timezone, ${un('updated_by')} AS updated_by, updated_at FROM teen_controls WHERE teen_id = $1`,
    ),
  };

  return { content, chats, activity, relationships, money, safety, ai, security, developer, invites, settings };
}

/** A short guide at the top of the file: what each part holds, the limits, and what is left out. */
export const EXPORT_README = {
  about:
    'Everything YAPILAPI keeps about you, as of exportedAt. Other people appear by username only. Files are not included; their addresses are, while you can still open them.',
  sections: {
    account: 'Your sign-in details, birth date and account status.',
    profile: 'Your profile as others see it, and its settings.',
    'posts, comments, messagesSent': 'What you shared. Messages include only the ones you sent.',
    content: 'Stories, chapters, boards, saves, memories, recaps, lives, rooms, products, drops, places, businesses, photos and videos, and more you made.',
    chats: 'Chats you are in, and the polls, lists, plans, games, calls and watch together sessions you took part in (your side only).',
    activity: 'Reposts, votes, notifications, feed feedback, daily minutes, and views counted per day.',
    relationships: 'Friends, friend requests, blocks, mutes, restrictions and family links.',
    money: 'Orders (bought and sold), payments, refunds, tips, subscriptions, payouts, bookings and Plus.',
    safety: 'Reports you made, decisions about your content and account, and your appeals.',
    ai: 'Catch-ups, suggested replies and assistant use.',
    security: 'Devices, sessions, two-step verification, passkeys, phone checks and connected apps.',
    developer: 'Your developer apps, key names and webhooks.',
    invites: 'Your invite code, who joined with it, and who invited you.',
    settings: 'Your preferences and, for teens, the controls a parent or guardian set.',
  },
  limits: {
    'activity.*PerDay': `Counts per day (UTC) for the last ${EXPORT_LIMITS.days} days with any, not every view.`,
    'activity.productAnalytics': 'How many times each event happened, with the first and last time.',
    'activity.notifications': `The newest ${EXPORT_LIMITS.notifications}.`,
    'activity.feedFeedback': `The newest ${EXPORT_LIMITS.feedFeedback}.`,
    'activity.reelsResumeAt': `The newest ${EXPORT_LIMITS.reelResume}.`,
    'content.media': `The newest ${EXPORT_LIMITS.media}.`,
    'content.liveChat': `The newest ${EXPORT_LIMITS.liveChat}.`,
    'chats.gameMoves': `The newest ${EXPORT_LIMITS.gameMoves}.`,
    'security.sessions': `The newest ${EXPORT_LIMITS.sessions}.`,
    securityEvents: 'The newest 500.',
    'ai.assistantCalls': `The newest ${EXPORT_LIMITS.assistantCalls}.`,
    'safety.auditLog': `The newest ${EXPORT_LIMITS.auditLog}.`,
  },
  leftOut: [
    'Passwords, sign-in and reset links, session and API key tokens, two-step secrets and codes, passkey keys, stream keys and webhook secrets (and their hashes).',
    'Other people’s messages, email addresses and private details.',
    'Who reported you, and cases still being reviewed.',
    'How automated spam and abuse checks work: the flags on your account are counted, not described.',
  ],
} as const;
