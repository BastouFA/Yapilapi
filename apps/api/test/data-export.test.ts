import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';

let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.close();
});

const adult = () => signUp(t.app, { birthDate: '1990-01-01' });

/** Values that must never leave the server in an export: planted in the tables that hold secrets. */
const PLANTED = [
  'PLANTED_STREAM_KEY',
  'PLANTED_MEDIA_KEY',
  'PLANTED_CAPTION_KEY',
  'PLANTED_SHARE_KEY',
  'PLANTED_STORAGE_KEY',
  'PLANTED_PROVIDER_REF',
  'PLANTED_CREDENTIAL',
  'PLANTED_RECOVERY_HASH',
  'PLANTED_MFA_CHALLENGE',
  'PLANTED_WEBAUTHN',
  'PLANTED_AUTH_TOKEN',
  'PLANTED_ENDPOINT',
  'PLANTED_PUSH_AUTH',
  'PLANTED_WEBHOOK_SECRET',
  'PLANTED_ACCESS',
  'PLANTED_REFRESH',
  'PLANTED_OAUTH_CODE',
  'PLANTED_PKCE',
  'PLANTED_DOWNLOAD',
  'PLANTED_UPLOAD',
  'PLANTED_EMAIL_KEY',
  'PLANTED_RISK_DETAIL',
  'signup_subnet_velocity',
  'PLANTED_REQUEST_ID',
  'PLANTED_AUDIT_META',
  'PLANTED_MOD_NOTE',
  'PLANTED_BOLA_REPORT',
  'PLANTED_BOLA_MESSAGE',
];

interface World {
  ada: TestUser;
  bola: TestUser;
  cat: TestUser;
  ids: Record<string, string> & { postA: string; postB: string; appA: string };
  secrets: string[];
}

/**
 * Ada, with something in nearly every kind of data the service keeps, next to Bola and Cat.
 * Posts, reactions, reposts, the developer key and two-step setup go through the API (so the real
 * tokens exist); the rest is inserted directly.
 */
async function world(): Promise<World> {
  const [ada, bola, cat] = [await adult(), await adult(), await adult()];
  const A = ada.id;
  const B = bola.id;
  const C = cat.id;
  const postA = (await as(t.app, ada).post('/v1/posts', { body: 'Ada’s first post', visibility: 'public' })).body.post.id as string;
  const postB = (await as(t.app, bola).post('/v1/posts', { body: 'Bola’s post', visibility: 'public' })).body.post.id as string;
  expect((await as(t.app, ada).put(`/v1/posts/${postB}/reaction`, {})).status).toBe(200);
  expect((await as(t.app, ada).put(`/v1/posts/${postB}/repost`)).status).toBe(200);
  const appA = (await as(t.app, ada).post('/v1/developer/apps', { name: 'Ada tools' })).body.app.id as string;
  const key = await as(t.app, ada).post(`/v1/developer/apps/${appA}/keys`, { name: 'Laptop script' });
  expect(key.status).toBe(201);
  const totp = await as(t.app, ada).post('/v1/auth/mfa/totp/setup');
  expect(totp.status).toBe(200);
  const hashes = (
    await t.ctx.db.query(
      `SELECT (SELECT password_hash FROM users WHERE id = $1) AS pw, (SELECT key_hash FROM api_keys WHERE owner_id = $1) AS key,
              (SELECT prefix FROM api_keys WHERE owner_id = $1) AS prefix, (SELECT string_agg(token_hash, ',') FROM sessions WHERE user_id = $1) AS sessions`,
      [A],
    )
  ).rows[0];
  const secrets = [
    ...PLANTED,
    ada.token,
    key.body.secret,
    key.body.key.prefix,
    hashes.key,
    hashes.pw,
    ...hashes.sessions.split(','),
    totp.body.secret,
    bola.email,
    cat.email,
  ];

  const keys = [
    'conv',
    'msgA',
    'msgB',
    'msgPoll',
    'msgList',
    'msgGame',
    'opt1',
    'opt2',
    'game',
    'call',
    'watch',
    'mediaA',
    'mediaPriv',
    'momentA',
    'momentB',
    'chapter',
    'chapterB',
    'board',
    'memory',
    'memoryB',
    'live',
    'community',
    'room',
    'product',
    'productB',
    'orderBuy',
    'orderSale',
    'orderTip',
    'orderTipIn',
    'orderAd',
    'payment',
    'plan',
    'planB',
    'business',
    'place',
    'placeB',
    'drop',
    'dropB',
    'campaign',
    'event',
    'eventB',
    'together',
    'togetherB',
    'miniApp',
    'track',
    'pollOpt',
    'caseId',
  ] as const;
  const ids = Object.fromEntries(keys.map((k) => [k, randomUUID()])) as Record<(typeof keys)[number], string>;
  const i = ids;
  const [fa, fb] = [A, B].sort();
  const statements = [
    // Chats
    `INSERT INTO conversations (id, kind, created_by, title) VALUES ('${i.conv}', 'group', '${A}', 'Weekend plans')`,
    `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ('${i.conv}', '${A}', 'admin'), ('${i.conv}', '${B}', 'member')`,
    `INSERT INTO messages (id, conversation_id, sender_id, body) VALUES ('${i.msgA}', '${i.conv}', '${A}', 'Ada says hi'), ('${i.msgB}', '${i.conv}', '${B}', 'PLANTED_BOLA_MESSAGE'),
       ('${i.msgPoll}', '${i.conv}', '${A}', ''), ('${i.msgList}', '${i.conv}', '${A}', ''), ('${i.msgGame}', '${i.conv}', '${A}', '')`,
    `INSERT INTO message_edits (message_id, body) VALUES ('${i.msgA}', 'Ada said hello first')`,
    `INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ('${i.msgB}', '${A}', 'ok')`,
    `INSERT INTO message_hides (message_id, user_id) VALUES ('${i.msgB}', '${A}')`,
    `INSERT INTO message_views (message_id, user_id) VALUES ('${i.msgB}', '${A}')`,
    `INSERT INTO conversation_pins (conversation_id, message_id, pinned_by) VALUES ('${i.conv}', '${i.msgB}', '${A}')`,
    `INSERT INTO chat_reminders (message_id, conversation_id, user_id, scope, remind_at) VALUES ('${i.msgB}', '${i.conv}', '${A}', 'me', now() + interval '1 day')`,
    `INSERT INTO chat_polls (message_id, conversation_id, created_by, question) VALUES ('${i.msgPoll}', '${i.conv}', '${A}', 'Pizza or rice?')`,
    `INSERT INTO chat_poll_options (id, message_id, text, position, added_by) VALUES ('${i.opt1}', '${i.msgPoll}', 'Pizza', 0, '${A}'), ('${i.opt2}', '${i.msgPoll}', 'Rice', 1, '${B}')`,
    `INSERT INTO chat_poll_votes (option_id, message_id, user_id) VALUES ('${i.opt1}', '${i.msgPoll}', '${A}'), ('${i.opt2}', '${i.msgPoll}', '${B}')`,
    `INSERT INTO chat_lists (message_id, conversation_id, created_by, title) VALUES ('${i.msgList}', '${i.conv}', '${A}', 'Groceries')`,
    `INSERT INTO chat_list_items (message_id, text, position, added_by) VALUES ('${i.msgList}', 'Milk', 0, '${A}'), ('${i.msgList}', 'Bread', 1, '${B}')`,
    `INSERT INTO chat_games (id, message_id, conversation_id, kind, created_by, players, state) VALUES ('${i.game}', '${i.msgGame}', '${i.conv}', 'noughts', '${A}', ARRAY['${A}', '${B}']::uuid[], '{}')`,
    `INSERT INTO chat_game_moves (game_id, number, player_id, move) VALUES ('${i.game}', 1, '${A}', '{"cell": 4}')`,
    `INSERT INTO plans (conversation_id, created_by, title) VALUES ('${i.conv}', '${A}', 'Picnic on Saturday')`,
    `INSERT INTO calls (id, conversation_id, caller_id, kind, status) VALUES ('${i.call}', '${i.conv}', '${A}', 'audio', 'ended')`,
    `INSERT INTO call_participants (call_id, user_id) VALUES ('${i.call}', '${A}')`,
    `INSERT INTO watch_sessions (id, conversation_id, started_by, host_id) VALUES ('${i.watch}', '${i.conv}', '${A}', '${A}')`,
    `INSERT INTO watch_participants (session_id, user_id) VALUES ('${i.watch}', '${A}')`,
    `INSERT INTO watch_queue_items (session_id, post_id, added_by, position) VALUES ('${i.watch}', '${postB}', '${A}', 1)`,
    // Media, stories, chapters, boards, memories, recaps
    `INSERT INTO media (id, owner_id, kind, url, storage_key, status) VALUES ('${i.mediaA}', '${A}', 'image', 'https://cdn.example.test/ada.jpg', 'PLANTED_MEDIA_KEY_${A}', 'ready')`,
    `INSERT INTO media (id, owner_id, kind, url, private) VALUES ('${i.mediaPriv}', '${A}', 'image', 'https://cdn.example.test/view-once.jpg', true)`,
    `INSERT INTO caption_tracks (media_id, lang, label, status, url, storage_key, created_by) VALUES ('${i.mediaA}', 'en', 'English', 'ready', 'https://cdn.example.test/ada.vtt', 'PLANTED_CAPTION_KEY_${A}', '${A}')`,
    `INSERT INTO moments (id, author_id, visibility, body) VALUES ('${i.momentA}', '${A}', 'public', 'Ada’s story'), ('${i.momentB}', '${B}', 'public', 'Bola’s story')`,
    `INSERT INTO moment_views (moment_id, viewer_id, liked) VALUES ('${i.momentB}', '${A}', true)`,
    `INSERT INTO story_responses (moment_id, sticker_id, user_id, kind, choice) VALUES ('${i.momentB}', 's1', '${A}', 'poll', 0)`,
    `INSERT INTO chapters (id, owner_id, title) VALUES ('${i.chapter}', '${A}', 'Summer'), ('${i.chapterB}', '${B}', 'Bola’s trip')`,
    `INSERT INTO chapter_items (chapter_id, moment_id) VALUES ('${i.chapter}', '${i.momentA}')`,
    `INSERT INTO chapter_members (chapter_id, user_id, status) VALUES ('${i.chapter}', '${B}', 'invited'), ('${i.chapterB}', '${A}', 'accepted')`,
    `INSERT INTO chapter_guestbook (chapter_id, author_id, body) VALUES ('${i.chapterB}', '${A}', 'Lovely trip')`,
    `INSERT INTO boards (id, owner_id, name) VALUES ('${i.board}', '${A}', 'Ideas')`,
    `INSERT INTO board_items (board_id, post_id, added_by, position) VALUES ('${i.board}', '${postB}', '${A}', 0)`,
    `INSERT INTO board_members (board_id, user_id, invited_by) VALUES ('${i.board}', '${B}', '${A}')`,
    `INSERT INTO saves (post_id, user_id, note) VALUES ('${postB}', '${A}', 'Read later')`,
    `INSERT INTO memories (id, owner_id, title) VALUES ('${i.memory}', '${A}', 'Beach day'), ('${i.memoryB}', '${B}', 'Bola’s memory')`,
    `INSERT INTO memory_items (memory_id, item_type, item_id) VALUES ('${i.memory}', 'post', '${postA}')`,
    `INSERT INTO memory_shares (memory_id, user_id) VALUES ('${i.memory}', '${B}'), ('${i.memoryB}', '${A}')`,
    `INSERT INTO recaps (owner_id, source_type, source_id, title, style, aspect, items) VALUES ('${A}', 'memory', '${i.memory}', 'Beach recap', 'calm', '9:16', '[]')`,
    // Lives, communities, rooms, events, togethers
    `INSERT INTO live_sessions (id, host_id, title, stream_key_hash) VALUES ('${i.live}', '${A}', 'Ada live', 'PLANTED_STREAM_KEY_${A}')`,
    `INSERT INTO live_chat (session_id, user_id, body) VALUES ('${i.live}', '${A}', 'Hello, live')`,
    `INSERT INTO live_participants (session_id, user_id, role) VALUES ('${i.live}', '${A}', 'host')`,
    `INSERT INTO communities (id, slug, name, owner_id, member_count) VALUES ('${i.community}', 'readers-${i.community.slice(0, 8)}', 'Readers', '${B}', 2)`,
    `INSERT INTO community_members (community_id, user_id, role) VALUES ('${i.community}', '${B}', 'owner'), ('${i.community}', '${A}', 'member')`,
    `INSERT INTO community_faqs (community_id, question, answer, created_by) VALUES ('${i.community}', 'When do we meet?', 'Sundays', '${A}')`,
    `INSERT INTO rooms (id, community_id, created_by, title, status) VALUES ('${i.room}', '${i.community}', '${A}', 'Book talk', 'scheduled')`,
    `INSERT INTO room_participants (room_id, user_id) VALUES ('${i.room}', '${A}')`,
    `INSERT INTO room_reminders (room_id, user_id) VALUES ('${i.room}', '${A}')`,
    `INSERT INTO events (id, host_id, title, starts_at) VALUES ('${i.event}', '${A}', 'Ada’s meetup', now() + interval '2 days'), ('${i.eventB}', '${B}', 'Bola’s party', now() + interval '3 days')`,
    `INSERT INTO event_attendees (event_id, user_id, status) VALUES ('${i.eventB}', '${A}', 'going')`,
    `INSERT INTO togethers (id, creator_id, title) VALUES ('${i.together}', '${A}', 'Party pictures'), ('${i.togetherB}', '${B}', 'Bola’s album')`,
    `INSERT INTO together_members (together_id, user_id, role) VALUES ('${i.together}', '${A}', 'creator'), ('${i.togetherB}', '${B}', 'creator'), ('${i.togetherB}', '${A}', 'member')`,
    `INSERT INTO together_contributions (together_id, user_id, media_id, caption) VALUES ('${i.togetherB}', '${A}', '${i.mediaA}', 'Me at the party')`,
    // Posts and what Ada did with Bola's
    `INSERT INTO poll_options (id, post_id, label, position) VALUES ('${i.pollOpt}', '${postB}', 'Yes', 0)`,
    `INSERT INTO poll_votes (post_id, option_id, user_id) VALUES ('${postB}', '${i.pollOpt}', '${A}')`,
    `INSERT INTO post_views (post_id, viewer_id) VALUES ('${postB}', '${A}')`,
    `INSERT INTO reel_resume (user_id, post_id, position_ms) VALUES ('${A}', '${postB}', 1234)`,
    `INSERT INTO feed_feedback (user_id, signal, post_id, author_id) VALUES ('${A}', 'less_like_this', '${postB}', '${B}')`,
    `INSERT INTO post_audience (post_id, user_id) VALUES ('${postA}', '${B}'), ('${postB}', '${A}')`,
    `INSERT INTO post_collaborators (post_id, user_id, invited_by, status) VALUES ('${postB}', '${A}', '${B}', 'accepted')`,
    `INSERT INTO photo_tags (post_id, media_id, user_id, tagged_by, x, y) VALUES ('${postB}', '${i.mediaA}', '${A}', '${B}', 0.5, 0.5)`,
    `INSERT INTO share_videos (post_id, status, username, url, storage_key, requested_by) VALUES ('${postA}', 'ready', 'ada', 'https://cdn.example.test/share.mp4', 'PLANTED_SHARE_KEY_${A}', '${A}')`,
    `INSERT INTO music_tracks (id, provider, external_id, title, artist, licence) VALUES ('${i.track}', 'jamendo', '${i.track}', 'Morning song', 'Artist', '{}')`,
    `INSERT INTO music_saves (user_id, track_id) VALUES ('${A}', '${i.track}')`,
    // Shop, money, drops, places
    `INSERT INTO products (id, seller_id, kind, title, price_cents, currency, status) VALUES ('${i.product}', '${A}', 'digital', 'Ada’s zine', 500, 'USD', 'active'),
       ('${i.productB}', '${B}', 'product', 'Bola’s print', 1000, 'USD', 'active')`,
    `INSERT INTO product_files (product_id, storage_key, filename, mime, size_bytes) VALUES ('${i.product}', 'private/PLANTED_STORAGE_KEY', 'zine.pdf', 'application/pdf', 1000)`,
    `INSERT INTO orders (id, buyer_id, status, total_cents, currency, idempotency_key, purpose) VALUES
       ('${i.orderBuy}', '${A}', 'paid', 1000, 'USD', 'k1', 'products'), ('${i.orderSale}', '${B}', 'paid', 500, 'USD', 'k2', 'products')`,
    `INSERT INTO orders (id, buyer_id, payee_id, status, total_cents, currency, idempotency_key, purpose) VALUES
       ('${i.orderTip}', '${A}', '${B}', 'paid', 300, 'USD', 'k3', 'tip'), ('${i.orderTipIn}', '${B}', '${A}', 'paid', 400, 'USD', 'k4', 'tip')`,
    `INSERT INTO order_items (order_id, product_id, quantity, unit_cents) VALUES ('${i.orderBuy}', '${i.productB}', 1, 1000), ('${i.orderSale}', '${i.product}', 1, 500)`,
    `INSERT INTO payments (id, order_id, provider, provider_ref, status, amount_cents, currency) VALUES ('${i.payment}', '${i.orderBuy}', 'dev', 'PLANTED_PROVIDER_REF_${i.payment}', 'succeeded', 1000, 'USD')`,
    `INSERT INTO refunds (payment_id, amount_cents, reason, status) VALUES ('${i.payment}', 200, 'Damaged in the post', 'succeeded')`,
    `INSERT INTO tips (from_id, to_id, order_id, message) VALUES ('${A}', '${B}', '${i.orderTip}', 'Thanks for the song'), ('${B}', '${A}', '${i.orderTipIn}', 'Great live')`,
    `INSERT INTO creator_plans (id, creator_id, name, price_cents, currency) VALUES ('${i.plan}', '${A}', 'Supporters', 500, 'USD'), ('${i.planB}', '${B}', 'Bola’s club', 300, 'USD')`,
    `INSERT INTO creator_subscriptions (plan_id, subscriber_id, creator_id, status) VALUES ('${i.plan}', '${B}', '${A}', 'active'), ('${i.planB}', '${A}', '${B}', 'active')`,
    `INSERT INTO payouts (user_id, amount_cents, currency) VALUES ('${A}', 1000, 'USD')`,
    `INSERT INTO businesses (id, owner_id, slug, name) VALUES ('${i.business}', '${A}', 'ada-${i.business.slice(0, 8)}', 'Ada’s shop')`,
    `INSERT INTO places (id, created_by, business_id, name, category) VALUES ('${i.place}', '${A}', '${i.business}', 'Ada’s cafe', 'restaurant'), ('${i.placeB}', '${B}', NULL, 'Bola’s bar', 'restaurant')`,
    `INSERT INTO place_reviews (place_id, author_id, rating, body) VALUES ('${i.placeB}', '${A}', 5, 'Great bar')`,
    `INSERT INTO bookings (place_id, user_id, party_size, starts_at, status, note) VALUES ('${i.placeB}', '${A}', 2, now() + interval '1 day', 'requested', 'Window seat please'),
       ('${i.place}', '${B}', 3, now() + interval '2 days', 'requested', 'A birthday')`,
    `INSERT INTO business_views (business_id, kind, target_id, viewer_id) VALUES ('${i.business}', 'business', '${i.business}', '${A}')`,
    `INSERT INTO drops (id, seller_id, title, starts_at, status) VALUES ('${i.drop}', '${A}', 'Ada’s drop', now() + interval '1 day', 'scheduled'),
       ('${i.dropB}', '${B}', 'Bola’s drop', now() + interval '1 day', 'scheduled')`,
    `INSERT INTO drop_items (drop_id, product_id) VALUES ('${i.drop}', '${i.product}'), ('${i.dropB}', '${i.productB}')`,
    `INSERT INTO drop_reminders (drop_id, user_id) VALUES ('${i.drop}', '${B}'), ('${i.dropB}', '${A}')`,
    `INSERT INTO drop_orders (order_id, product_id, drop_id, buyer_id, quantity, status, hold_until) VALUES ('${i.orderBuy}', '${i.productB}', '${i.dropB}', '${A}', 1, 'paid', now())`,
    `INSERT INTO plus_grants (user_id, source, days, referral_batch, starts_at, ends_at) VALUES ('${A}', 'referral', 7, 1, now(), now() + interval '7 days')`,
    `INSERT INTO ad_campaigns (id, advertiser_id, post_id, name, status, currency, budget_millicents, spent_millicents) VALUES ('${i.campaign}', '${A}', '${postA}', 'Boost: first post', 'paused', 'USD', 100000, 20000)`,
    `INSERT INTO ad_events (campaign_id, user_id, kind) VALUES ('${i.campaign}', '${A}', 'impression')`,
    `INSERT INTO orders (id, buyer_id, status, total_cents, currency, idempotency_key, purpose, campaign_id) VALUES ('${i.orderAd}', '${A}', 'paid', 100, 'USD', 'k5', 'ad_budget', '${i.campaign}')`,
    `INSERT INTO payments (order_id, provider, provider_ref, status, amount_cents, currency) VALUES ('${i.orderAd}', 'dev', 'PLANTED_PROVIDER_REF_${i.orderAd}', 'succeeded', 100, 'USD')`,
    // Relationships
    `INSERT INTO friendships (user_a, user_b) VALUES ('${fa}', '${fb}')`,
    `INSERT INTO friend_requests (from_user_id, to_user_id) VALUES ('${A}', '${C}')`,
    `INSERT INTO blocks (blocker_id, blocked_id) VALUES ('${A}', '${C}')`,
    `INSERT INTO mutes (muter_id, muted_id) VALUES ('${A}', '${B}')`,
    `INSERT INTO restrictions (restrictor_id, restricted_id) VALUES ('${A}', '${C}')`,
    `INSERT INTO family_links (guardian_id, teen_id) VALUES ('${A}', '${C}')`,
    `INSERT INTO teen_controls (teen_id, messages_from, updated_by) VALUES ('${A}', 'friends', '${B}')`,
    // Security, devices, developer
    `INSERT INTO devices (user_id, name, platform) VALUES ('${A}', 'Ada’s phone', 'ios')`,
    `INSERT INTO passkeys (user_id, credential_id, public_key, label) VALUES ('${A}', 'PLANTED_CREDENTIAL_${A}', '\\x00', 'Ada’s laptop')`,
    `INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ('${A}', 'PLANTED_RECOVERY_HASH_${A}')`,
    `INSERT INTO mfa_challenges (user_id, token_hash, expires_at) VALUES ('${A}', 'PLANTED_MFA_CHALLENGE_${A}', now() + interval '5 minutes')`,
    `INSERT INTO webauthn_challenges (user_id, purpose, challenge, expires_at) VALUES ('${A}', 'login', 'PLANTED_WEBAUTHN_${A}', now() + interval '5 minutes')`,
    `INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at) VALUES ('${A}', 'reset_password', 'PLANTED_AUTH_TOKEN_${A}', now() + interval '1 hour')`,
    `INSERT INTO phone_verifications (user_id, phone_e164, provider, expires_at) VALUES ('${A}', '+15550001111', 'twilio', now() + interval '10 minutes')`,
    `INSERT INTO push_subscriptions (user_id, kind, endpoint, keys) VALUES ('${A}', 'webpush', 'https://push.example.test/PLANTED_ENDPOINT_${A}', '{"auth": "PLANTED_PUSH_AUTH"}')`,
    `INSERT INTO webhook_subscriptions (app_id, url, events, secret) VALUES ('${appA}', 'https://hooks.example.test/in', '{post.created}', 'PLANTED_WEBHOOK_SECRET_${A}')`,
    `INSERT INTO mini_apps (id, app_id, name, entry_url, surfaces) VALUES ('${i.miniApp}', '${appA}', 'Ada’s poll app', 'https://mini.example.test', '{conversation}')`,
    `INSERT INTO mini_app_installs (mini_app_id, surface, surface_id, installed_by) VALUES ('${i.miniApp}', 'conversation', '${i.conv}', '${A}')`,
    `INSERT INTO oauth_grants (app_id, user_id, scopes, access_hash, refresh_hash, access_expires_at, refresh_expires_at)
       VALUES ('${appA}', '${A}', '{read}', 'PLANTED_ACCESS_${A}', 'PLANTED_REFRESH_${A}', now() + interval '1 hour', now() + interval '30 days')`,
    `INSERT INTO oauth_codes (app_id, user_id, code_hash, redirect_uri, scopes, code_challenge, expires_at)
       VALUES ('${appA}', '${A}', 'PLANTED_OAUTH_CODE_${A}', 'https://x.example.test/cb', '{read}', 'PLANTED_PKCE_${A}', now() + interval '5 minutes')`,
    `INSERT INTO download_links (token_hash, product_id, user_id, expires_at) VALUES ('PLANTED_DOWNLOAD_${A}', '${i.productB}', '${A}', now() + interval '5 minutes')`,
    `INSERT INTO upload_sessions (user_id, filename, mime, size, chunk_size, total_chunks) VALUES ('${A}', 'PLANTED_UPLOAD.mov', 'video/quicktime', 100, 10, 10)`,
    // Invites, activity, assistant, settings
    `INSERT INTO invite_codes (user_id, code) VALUES ('${A}', 'ada${i.conv.slice(0, 5)}') ON CONFLICT DO NOTHING`,
    `INSERT INTO referrals (invitee_id, inviter_id, email_key) VALUES ('${C}', '${A}', 'PLANTED_EMAIL_KEY_${A}')`,
    `INSERT INTO usage_days (user_id, day, minutes) VALUES ('${A}', current_date, 12)`,
    `INSERT INTO pulse_visits (user_id) VALUES ('${A}')`,
    `INSERT INTO notifications (user_id, category, type, actor_id) VALUES ('${A}', 'social', 'follow', '${B}'), ('${B}', 'social', 'follow', '${A}')`,
    `INSERT INTO analytics_events (user_id, name) VALUES ('${A}', 'app_open'), ('${A}', 'app_open')`,
    `INSERT INTO ai_catchups (user_id, away_since, back_at, output, provider, model) VALUES ('${A}', now() - interval '1 day', now(), '{"summary": "Two new messages"}', 'dev', 'dev')`,
    `INSERT INTO ai_reply_suggestions (user_id, message_id, suggestions, provider, model) VALUES ('${A}', '${i.msgB}', '["Sounds good"]', 'dev', 'dev')`,
    `INSERT INTO ai_conversations (user_id, agent) VALUES ('${A}', 'helper')`,
    `INSERT INTO ai_tool_calls (user_id, task, provider, model, status) VALUES ('${A}', 'catch_up', 'dev', 'dev', 'ok')`,
    `INSERT INTO user_preferences (user_id, focus_mode) VALUES ('${A}', true) ON CONFLICT (user_id) DO UPDATE SET focus_mode = true`,
    // Safety
    `INSERT INTO reports (reporter_id, target_type, target_id, reason, details) VALUES ('${A}', 'post', '${postB}', 'spam', 'Looks like spam'),
       ('${B}', 'post', '${postA}', 'harassment', 'PLANTED_BOLA_REPORT')`,
    `INSERT INTO moderation_cases (id, target_type, target_id, subject_user_id, source, risk, signals, status, decision, note, decided_at)
       VALUES ('${i.caseId}', 'post', '${postA}', '${A}', 'report', 'review', '{"reports": 1}', 'appealed', 'remove', 'PLANTED_MOD_NOTE', now())`,
    `INSERT INTO enforcements (case_id, user_id, action) VALUES ('${i.caseId}', '${A}', 'remove_content')`,
    `INSERT INTO appeals (case_id, user_id, statement) VALUES ('${i.caseId}', '${A}', 'Please look again')`,
    `INSERT INTO risk_signals (user_id, kind, weight, detail) VALUES ('${A}', 'signup_subnet_velocity', 3, '{"PLANTED_RISK_DETAIL": 1}')`,
    `INSERT INTO audit_logs (actor_id, action, entity_type, ip, request_id, metadata) VALUES ('${A}', 'consent.update', 'consent', '10.1.2.3', 'PLANTED_REQUEST_ID_${A}', '{"PLANTED_AUDIT_META": 1}')`,
  ];
  for (const sql of statements) await t.ctx.db.query(sql);
  return { ada, bola, cat, ids: { ...ids, postA, postB, appA }, secrets };
}

describe('download a copy of your data', () => {
  it('covers every kind of data about the person, grouped, with no secrets and nobody else’s email', async () => {
    const w = await world();
    const { ada, bola } = w;
    const r = await as(t.app, ada).get('/v1/me/export');
    expect(r.status).toBe(200);
    const d = r.body;
    const text = JSON.stringify(d);

    for (const secret of w.secrets) expect(text, `the export must not contain ${secret}`).not.toContain(secret);

    expect(d.readme.sections.content).toBeTruthy();
    expect(d.account).toMatchObject({ email: ada.email, mfa_enabled: false });

    // Content
    const c = d.content;
    expect(c.stories.map((s: any) => s.body)).toContain('Ada’s story');
    expect(c.storyResponses).toMatchObject([{ kind: 'poll', choice: 0 }]);
    expect(c.chapters[0]).toMatchObject({ title: 'Summer', moment_ids: [w.ids.momentA], members: [{ username: bola.username, status: 'invited' }] });
    expect(c.chaptersYouAreIn).toMatchObject([{ title: 'Bola’s trip', owner: bola.username, status: 'accepted' }]);
    expect(c.guestbookEntries).toMatchObject([{ body: 'Lovely trip' }]);
    expect(c.boards[0]).toMatchObject({ name: 'Ideas', items: [{ post_id: w.ids.postB, added_by: ada.username }], members: [{ username: bola.username }] });
    expect(c.saves).toMatchObject([{ post_id: w.ids.postB, note: 'Read later' }]);
    expect(c.memories[0]).toMatchObject({ title: 'Beach day', shared_with: [bola.username] });
    expect(c.memoriesSharedWithYou).toMatchObject([{ title: 'Bola’s memory', owner: bola.username }]);
    expect(c.recaps).toMatchObject([{ title: 'Beach recap' }]);
    expect(c.lives).toMatchObject([{ title: 'Ada live' }]);
    expect(c.liveChat).toMatchObject([{ body: 'Hello, live' }]);
    expect(c.rooms).toMatchObject([{ title: 'Book talk' }]);
    expect(c.roomReminders).toHaveLength(1);
    expect(c.products.find((p: any) => p.id === w.ids.product)).toMatchObject({ title: 'Ada’s zine', file: { filename: 'zine.pdf' } });
    expect(c.drops).toMatchObject([{ title: 'Ada’s drop', products: [{ product_id: w.ids.product }] }]);
    expect(c.businesses).toMatchObject([{ name: 'Ada’s shop' }]);
    expect(c.places).toMatchObject([{ name: 'Ada’s cafe' }]);
    expect(c.placeReviews).toMatchObject([{ place: 'Bola’s bar', rating: 5, body: 'Great bar' }]);
    expect(c.eventsHosted).toMatchObject([{ title: 'Ada’s meetup' }]);
    expect(c.communityFaqsWritten).toMatchObject([{ question: 'When do we meet?' }]);
    expect(c.togethers).toMatchObject([{ title: 'Party pictures' }]);
    expect(c.togethersYouAreIn.map((x: any) => x.title)).toContain('Bola’s album');
    expect(c.togetherPhotos).toMatchObject([{ caption: 'Me at the party', url: 'https://cdn.example.test/ada.jpg' }]);
    expect(c.postAudiences).toMatchObject([{ post_id: w.ids.postA, people: [bola.username] }]);
    expect(c.collaborations).toMatchObject([{ post_id: w.ids.postB, role: 'invited', with: bola.username }]);
    expect(c.photoTags).toMatchObject([{ role: 'you were tagged', with: bola.username }]);
    // A file's address only while it can be opened: never for a private view-once file.
    const media = new Map(c.media.map((m: any) => [m.id, m]));
    expect(media.get(w.ids.mediaA)).toMatchObject({ url: 'https://cdn.example.test/ada.jpg' });
    expect(media.get(w.ids.mediaPriv)).toMatchObject({ private: true, url: null });
    expect(c.captions).toMatchObject([{ lang: 'en', url: 'https://cdn.example.test/ada.vtt' }]);
    expect(c.shareVideos).toMatchObject([{ post_id: w.ids.postA, url: 'https://cdn.example.test/share.mp4' }]);
    expect(c.musicSaves).toMatchObject([{ track: 'Morning song' }]);
    expect(c.adCampaigns).toMatchObject([{ name: 'Boost: first post', status: 'paused' }]);

    // Chats: Ada's side only.
    const ch = d.chats;
    expect(ch.conversations).toMatchObject([{ title: 'Weekend plans', you_started_it: true, role: 'admin' }]);
    expect(ch.messageEdits).toMatchObject([{ body: 'Ada said hello first' }]);
    expect(ch.messageReactions).toMatchObject([{ emoji: 'ok' }]);
    expect(ch.messagesHidden).toHaveLength(1);
    expect(ch.messagesPinned).toHaveLength(1);
    expect(ch.reminders).toMatchObject([{ scope: 'me' }]);
    expect(ch.polls).toMatchObject([{ question: 'Pizza or rice?', options: ['Pizza', 'Rice'] }]);
    expect(ch.pollVotes).toMatchObject([{ option: 'Pizza' }]);
    expect(ch.lists).toMatchObject([{ title: 'Groceries' }]);
    expect(ch.plans).toMatchObject([{ title: 'Picnic on Saturday' }]);
    expect(ch.gameMoves).toMatchObject([{ number: 1, move: { cell: 4 } }]);
    expect(ch.calls).toMatchObject([{ kind: 'audio', you_called: true }]);
    expect(ch.watchTogether).toMatchObject([{ you_started_it: true, you_added: [{ post_id: w.ids.postB }] }]);
    expect(d.messagesSent.map((m: any) => m.body)).toContain('Ada says hi');

    // Activity, summarised where it can grow without end.
    const a = d.activity;
    expect(a.reposts).toMatchObject([{ post_id: w.ids.postB }]);
    expect(a.pollVotes).toMatchObject([{ option: 'Yes' }]);
    expect(a.postsViewedPerDay).toMatchObject([{ count: 1 }]);
    expect(a.storiesViewedPerDay).toMatchObject([{ count: 1, liked: 1 }]);
    expect(a.businessPagesViewedPerDay).toMatchObject([{ count: 1 }]);
    expect(a.viewOnceOpenedPerDay).toMatchObject([{ count: 1 }]);
    expect(a.sponsoredPostsPerDay).toMatchObject([{ count: 1, seen: 1, opened: 0 }]);
    expect(a.reelsResumeAt).toMatchObject([{ position_ms: 1234 }]);
    expect(a.feedFeedback).toMatchObject([{ signal: 'less_like_this', author: bola.username }]);
    expect(a.minutesPerDay).toMatchObject([{ minutes: 12 }]);
    expect(a.lastVisit).toBeTruthy();
    expect(a.notifications.find((n: any) => n.type === 'follow')).toMatchObject({ actor: bola.username });
    expect(a.productAnalytics.find((e: any) => e.name === 'app_open')).toMatchObject({ count: 2 });
    expect(a.dropReminders).toMatchObject([{ title: 'Bola’s drop' }]);
    expect(d.reactions).toMatchObject([{ post_id: w.ids.postB }]);

    // Relationships, by username.
    const rel = d.relationships;
    expect(rel.friends).toEqual([expect.objectContaining({ username: bola.username })]);
    expect(rel.friendRequests).toMatchObject([{ direction: 'sent', username: w.cat.username, status: 'pending' }]);
    expect(rel.blocked).toMatchObject([{ username: w.cat.username }]);
    expect(rel.muted).toMatchObject([{ username: bola.username }]);
    expect(rel.restricted).toMatchObject([{ username: w.cat.username }]);
    expect(rel.family).toMatchObject([{ role: 'you are the parent or guardian', username: w.cat.username, status: 'pending' }]);

    // Money: bought and sold, buyers by username only.
    const m = d.money;
    expect(d.orders.find((o: any) => o.id === w.ids.orderBuy)).toMatchObject({
      purpose: 'products',
      items: [{ title: 'Bola’s print', seller: bola.username }],
    });
    expect(m.sales.find((o: any) => o.id === w.ids.orderSale)).toMatchObject({ buyer: bola.username, items: [{ title: 'Ada’s zine', quantity: 1 }] });
    expect(m.sales.find((o: any) => o.id === w.ids.orderTipIn)).toMatchObject({ purpose: 'tip', buyer: bola.username, total_cents: 400 });
    expect(m.payments.find((p: any) => p.order_id === w.ids.orderBuy)).toMatchObject({ provider: 'dev', status: 'succeeded' });
    expect(m.refunds).toMatchObject([{ direction: 'to you', amount_cents: 200, reason: 'Damaged in the post' }]);
    expect(m.tipsGiven).toMatchObject([{ to: bola.username, message: 'Thanks for the song', amount_cents: 300 }]);
    expect(m.tipsReceived).toMatchObject([{ from: bola.username, message: 'Great live' }]);
    expect(m.subscriptionPlans).toMatchObject([{ name: 'Supporters' }]);
    expect(m.subscriptions).toMatchObject([{ creator: bola.username, plan: 'Bola’s club' }]);
    expect(m.subscribers).toMatchObject([{ subscriber: bola.username, plan: 'Supporters' }]);
    expect(m.payouts).toMatchObject([{ amount_cents: 1000 }]);
    expect(m.bookings).toMatchObject([{ at: 'Bola’s bar', note: 'Window seat please' }]);
    expect(m.bookingsReceived).toMatchObject([{ at: 'Ada’s cafe', customer: bola.username, note: 'A birthday' }]);
    expect(m.dropPurchases).toMatchObject([{ drop: 'Bola’s drop', product: 'Bola’s print' }]);
    expect(m.plusGrants).toMatchObject([{ source: 'referral', days: 7 }]);

    // Safety: reports Ada made; decisions about her, never who reported her; automated flags only counted.
    const s = d.safety;
    expect(s.reportsMade).toEqual([expect.objectContaining({ target_type: 'post', reason: 'spam', details: 'Looks like spam' })]);
    expect(s.reportsMade[0]).not.toHaveProperty('target_id');
    expect(s.moderationDecisions).toMatchObject([{ id: w.ids.caseId, decision: 'remove' }]);
    expect(s.moderationDecisions[0]).not.toHaveProperty('note');
    expect(s.enforcements).toMatchObject([{ action: 'remove_content' }]);
    expect(s.appeals).toMatchObject([{ statement: 'Please look again' }]);
    expect(s.accountReview.automatedFlags).toMatchObject([{ status: 'open', count: 1 }]);
    expect(s.auditLog.find((l: any) => l.action === 'consent.update')).toEqual({
      action: 'consent.update',
      entity_type: 'consent',
      created_at: expect.any(String),
    });
    expect(s.staffWork).toEqual({ cases_reviewed: 0, flags_reviewed: 0, regional_rules_added: 0 });

    // Assistant.
    expect(d.ai.catchUps).toMatchObject([{ output: { summary: 'Two new messages' } }]);
    expect(d.ai.replySuggestions).toMatchObject([{ suggestions: ['Sounds good'] }]);
    expect(d.ai.assistantConversations).toMatchObject([{ agent: 'helper' }]);
    expect(d.ai.assistantCalls).toMatchObject([{ task: 'catch_up' }]);

    // Security: what there is, never the secrets.
    const sec = d.security;
    expect(sec.devices.find((x: any) => x.name === 'Ada’s phone')).toMatchObject({ platform: 'ios' });
    expect(sec.sessions.length).toBeGreaterThan(0);
    expect(sec.twoStep).toMatchObject({ enabled: false, methods: [{ kind: 'totp', confirmed_at: null }], recoveryCodes: { total: 1, used: 0 } });
    expect(sec.passkeys).toMatchObject([{ label: 'Ada’s laptop' }]);
    expect(sec.phoneChecks).toMatchObject([{ phone_e164: '+15550001111' }]);
    expect(sec.notificationDevices).toEqual([expect.objectContaining({ kind: 'webpush' })]);
    expect(sec.connectedApps).toMatchObject([{ app: 'Ada tools', scopes: ['read'] }]);

    // Developer: names, scopes and dates only.
    expect(d.developer.apps[0]).toMatchObject({
      name: 'Ada tools',
      keys: [{ name: 'Laptop script', scopes: ['read'] }],
      webhooks: [{ url: 'https://hooks.example.test/in', active: true }],
      mini_apps: [{ name: 'Ada’s poll app' }],
    });
    expect(d.developer.miniAppsAdded).toMatchObject([{ mini_app: 'Ada’s poll app', surface: 'conversation' }]);

    // Invites and settings.
    expect(d.invites.code.code).toMatch(/^[a-z0-9]{8}$/);
    expect(d.invites.peopleYouInvited).toMatchObject([{ username: w.cat.username }]);
    expect(d.settings.preferences).toMatchObject({ focus_mode: true });
    expect(d.settings.teenControls).toMatchObject({ messages_from: 'friends', updated_by: bola.username });

    // Bola's export has Bola's side, and none of Ada's private things.
    const theirs = JSON.stringify((await as(t.app, bola).get('/v1/me/export')).body);
    expect(theirs).not.toContain(ada.email);
    expect(theirs).not.toContain('Ada said hello first');
    expect(theirs).not.toContain('Read later');
    // The note Ada left with her booking reached Bola, whose place it is.
    expect(theirs).toContain('Window seat please');
    expect(theirs).toContain('PLANTED_BOLA_MESSAGE');
  });
});

describe('deleting the account', () => {
  it('removes or anonymises each kind of data the export covers', async () => {
    const w = await world();
    const { ada, bola } = w;
    const A = ada.id;
    const db = t.ctx.db;
    const likesBefore = (await db.query(`SELECT like_count, repost_count FROM posts WHERE id = $1`, [w.ids.postB])).rows[0];
    expect(likesBefore).toEqual({ like_count: 1, repost_count: 1 });

    const del = await as(t.app, ada).del('/v1/me', { password: ada.password });
    expect(del.status).toBe(200);

    // Gone.
    const gone: [string, string][] = [
      ['devices', 'user_id'],
      ['auth_tokens', 'user_id'],
      ['mfa_factors', 'user_id'],
      ['mfa_recovery_codes', 'user_id'],
      ['mfa_challenges', 'user_id'],
      ['webauthn_challenges', 'user_id'],
      ['oauth_codes', 'user_id'],
      ['download_links', 'user_id'],
      ['notifications', 'user_id'],
      ['friend_requests', 'from_user_id'],
      ['blocks', 'blocker_id'],
      ['mutes', 'muter_id'],
      ['restrictions', 'restrictor_id'],
      ['teen_controls', 'teen_id'],
      ['invite_codes', 'user_id'],
      ['chapters', 'owner_id'],
      ['chapter_members', 'user_id'],
      ['chapter_guestbook', 'author_id'],
      ['boards', 'owner_id'],
      ['board_members', 'user_id'],
      ['memories', 'owner_id'],
      ['memory_shares', 'user_id'],
      ['rooms', 'created_by'],
      ['room_reminders', 'user_id'],
      ['together_contributions', 'user_id'],
      ['event_attendees', 'user_id'],
      ['place_reviews', 'author_id'],
      ['drop_reminders', 'user_id'],
      ['saves', 'user_id'],
      ['post_views', 'viewer_id'],
      ['moment_views', 'viewer_id'],
      ['business_views', 'viewer_id'],
      ['story_responses', 'user_id'],
      ['poll_votes', 'user_id'],
      ['chat_poll_votes', 'user_id'],
      ['message_reactions', 'user_id'],
      ['message_hides', 'user_id'],
      ['chat_reminders', 'user_id'],
      ['photo_tags', 'user_id'],
      ['post_collaborators', 'user_id'],
      ['post_audience', 'user_id'],
      ['music_saves', 'user_id'],
      ['feed_feedback', 'user_id'],
      ['usage_days', 'user_id'],
      ['pulse_visits', 'user_id'],
      ['reel_resume', 'user_id'],
      ['user_preferences', 'user_id'],
      ['ai_catchups', 'user_id'],
      ['ai_reply_suggestions', 'user_id'],
      ['ai_conversations', 'user_id'],
      ['risk_signals', 'user_id'],
      ['reactions', 'user_id'],
      ['post_reposts', 'user_id'],
      ['community_members', 'user_id'],
      ['ai_tool_calls', 'user_id'],
      ['ad_events', 'user_id'],
      ['share_videos', 'requested_by'],
      ['watch_queue_items', 'added_by'],
    ];
    for (const [table, col] of gone) {
      const n = (await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${col} = $1`, [A])).rows[0].n;
      expect(n, `${table}.${col}`).toBe(0);
    }

    // Anonymised, stopped or kept as records others rely on.
    const one = async (sql: string, params: unknown[] = [A]) => (await db.query(sql, params)).rows[0];
    expect(await one(`SELECT mfa_enabled, contact_email_hash, findable_by_contacts FROM users WHERE id = $1`)).toEqual({
      mfa_enabled: false,
      contact_email_hash: null,
      findable_by_contacts: false,
    });
    expect(await one(`SELECT count(*) FILTER (WHERE revoked_at IS NULL)::int AS open FROM oauth_grants WHERE user_id = $1`)).toEqual({ open: 0 });
    expect(await one(`SELECT count(*) FILTER (WHERE revoked_at IS NULL)::int AS open FROM api_keys WHERE owner_id = $1`)).toEqual({ open: 0 });
    expect(await one(`SELECT deleted_at IS NOT NULL AS deleted FROM developer_apps WHERE id = $1`, [w.ids.appA])).toEqual({ deleted: true });
    expect(await one(`SELECT active FROM webhook_subscriptions WHERE app_id = $1`, [w.ids.appA])).toEqual({ active: false });
    expect(await one(`SELECT expires_at <= now() AS expired FROM upload_sessions WHERE user_id = $1`)).toEqual({ expired: true });
    expect(await one(`SELECT status, title, stream_key_hash FROM live_sessions WHERE id = $1`, [w.ids.live])).toEqual({
      status: 'ended',
      title: '',
      stream_key_hash: null,
    });
    expect(await one(`SELECT body, deleted_at IS NOT NULL AS deleted FROM live_chat WHERE user_id = $1`)).toEqual({ body: '', deleted: true });
    expect(await one(`SELECT status FROM products WHERE id = $1`, [w.ids.product])).toEqual({ status: 'archived' });
    expect(await one(`SELECT deleted_at IS NOT NULL AS deleted FROM businesses WHERE id = $1`, [w.ids.business])).toEqual({ deleted: true });
    expect(await one(`SELECT deleted_at IS NOT NULL AS deleted FROM places WHERE id = $1`, [w.ids.place])).toEqual({ deleted: true });
    expect(await one(`SELECT active FROM creator_plans WHERE id = $1`, [w.ids.plan])).toEqual({ active: false });
    expect(
      await one(`SELECT count(*) FILTER (WHERE status = 'active')::int AS active FROM creator_subscriptions WHERE subscriber_id = $1 OR creator_id = $1`),
    ).toEqual({
      active: 0,
    });
    expect(await one(`SELECT message FROM tips WHERE from_id = $1`)).toEqual({ message: '' });
    expect(await one(`SELECT note FROM bookings WHERE user_id = $1`)).toEqual({ note: '' });
    expect(await one(`SELECT status FROM family_links WHERE guardian_id = $1`)).toEqual({ status: 'ended' });
    expect(await one(`SELECT status FROM togethers WHERE id = $1`, [w.ids.together])).toEqual({ status: 'closed' });
    expect(await one(`SELECT count(*)::int AS n FROM together_members WHERE user_id = $1 AND role = 'member'`)).toEqual({ n: 0 });
    // Payment records stay.
    expect(await one(`SELECT count(*)::int AS n FROM orders WHERE buyer_id = $1`)).toEqual({ n: 3 });
    // Counts on other people's things come down.
    expect(await one(`SELECT like_count, repost_count FROM posts WHERE id = $1`, [w.ids.postB])).toEqual({ like_count: 0, repost_count: 0 });
    expect(await one(`SELECT member_count FROM communities WHERE id = $1`, [w.ids.community])).toEqual({ member_count: 1 });
    // The boost stops and its unspent budget goes back.
    expect(await one(`SELECT status FROM ad_campaigns WHERE id = $1`, [w.ids.campaign])).toEqual({ status: 'ended' });
    expect(
      await one(
        `SELECT r.amount_cents, r.status FROM refunds r JOIN payments p ON p.id = r.payment_id JOIN orders o ON o.id = p.order_id WHERE o.campaign_id = $1`,
        [w.ids.campaign],
      ),
    ).toEqual({ amount_cents: 80, status: 'succeeded' });
    // The drop is cancelled and the people waiting hear about it from "Deleted account".
    expect(await one(`SELECT status FROM drops WHERE id = $1`, [w.ids.drop])).toEqual({ status: 'cancelled' });
    // What Ada did in other people's inboxes is gone; only the notice about the cancelled drop is new.
    expect(await one(`SELECT count(*)::int AS n FROM notifications WHERE actor_id = $1 AND type <> 'drop_cancelled'`)).toEqual({ n: 0 });
    const told = await one(`SELECT type, actor_id FROM notifications WHERE user_id = $1 AND type = 'drop_cancelled'`, [bola.id]);
    expect(told).toEqual({ type: 'drop_cancelled', actor_id: A });
    // Bola's own things stay: the chapter Ada was in, the board item Ada's gone from, messages in the chat.
    expect(await one(`SELECT count(*)::int AS n FROM chapters WHERE id = $1`, [w.ids.chapterB])).toEqual({ n: 1 });
    expect(await one(`SELECT body FROM messages WHERE id = $1`, [w.ids.msgB])).toEqual({ body: 'PLANTED_BOLA_MESSAGE' });
  });
});
