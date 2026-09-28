-- Indexes for lookups that scanned whole tables, found by timing the main flows against a bulk
-- development dataset (5,000 people, 100,000 posts, 500,000 messages) and by checking every
-- `column = $1` lookup in the API against the indexes that exist (docs/architecture/performance.md).
--
-- Migrations here run inside a transaction, where CREATE INDEX CONCURRENTLY is not allowed, so
-- this file uses plain CREATE INDEX, which blocks writes to each table while its index builds.
-- Every index is IF NOT EXISTS: on a production database with large tables (media, messages,
-- comments, notifications, posts, post_media) build them all CONCURRENTLY first, then deploy, and
-- this migration only records itself. The commands are under "Adding indexes in production" in
-- docs/architecture/performance.md. Keep semicolons out of these comments: that recipe splits
-- the file on them.

-- ── Known unindexed lookups (data export and account erasure) ────────────────────────────────
-- Your uploads, newest first: the studio and Together pickers, the export and erasure.
CREATE INDEX IF NOT EXISTS media_owner_idx ON media (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS message_views_user_idx ON message_views (user_id);
CREATE INDEX IF NOT EXISTS business_views_viewer_idx ON business_views (viewer_id);
CREATE INDEX IF NOT EXISTS live_chat_user_idx ON live_chat (user_id);
CREATE INDEX IF NOT EXISTS chat_game_moves_player_idx ON chat_game_moves (player_id) WHERE player_id IS NOT NULL;
-- Tips you sent and got (Me → Tips, newest first), the order a tip belongs to (paying and
-- announcing a live gift, deleting old orders), and the post or live it was for.
CREATE INDEX IF NOT EXISTS tips_from_idx ON tips (from_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tips_to_idx ON tips (to_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tips_order_idx ON tips (order_id);
CREATE INDEX IF NOT EXISTS tips_post_idx ON tips (post_id) WHERE post_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tips_live_idx ON tips (live_id) WHERE live_id IS NOT NULL;

-- ── Hot paths ─────────────────────────────────────────────────────────────────────────────────
-- The duplicate-comment check runs on every comment (your comments of the last hour).
CREATE INDEX IF NOT EXISTS comments_author_idx ON comments (author_id, created_at DESC);
-- Stories, chapters and reels leave out photos and videos marked blocked or sensitive. Few are,
-- so this stays tiny and turns a scan of every upload into a lookup.
CREATE INDEX IF NOT EXISTS media_flagged_idx ON media (id) WHERE moderation IN ('blocked', 'sensitive');
-- Market search matches words anywhere in the title, description or area (ILIKE '%…%').
CREATE INDEX IF NOT EXISTS market_listings_text_trgm_idx ON market_listings
  USING gin (title gin_trgm_ops, description gin_trgm_ops, area gin_trgm_ops) WHERE deleted_at IS NULL;
-- Market browsing without a country, and the "everywhere else" part after your country's
-- listings, newest first (the same listed-listing condition as market_listings_browse_idx).
CREATE INDEX IF NOT EXISTS market_listings_recent_idx ON market_listings (created_at DESC, id DESC)
  WHERE deleted_at IS NULL AND moderation_status = 'normal' AND status <> 'sold';
-- Deleting or hiding a comment unpins it: without this, every post was checked.
CREATE INDEX IF NOT EXISTS posts_pinned_comment_idx ON posts (pinned_comment_id) WHERE pinned_comment_id IS NOT NULL;
-- Requests people sent you, events you're going to, plans in a chat, and a creator's plans,
-- subscribers, sales and payouts.
CREATE INDEX IF NOT EXISTS friend_requests_to_idx ON friend_requests (to_user_id, status);
CREATE INDEX IF NOT EXISTS event_attendees_user_idx ON event_attendees (user_id);
CREATE INDEX IF NOT EXISTS plans_conversation_idx ON plans (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS creator_plans_creator_idx ON creator_plans (creator_id);
CREATE INDEX IF NOT EXISTS creator_subscriptions_creator_idx ON creator_subscriptions (creator_id, status);
CREATE INDEX IF NOT EXISTS creator_subscriptions_order_idx ON creator_subscriptions (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_payee_idx ON orders (payee_id, created_at DESC) WHERE payee_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payouts_user_idx ON payouts (user_id, created_at DESC);
-- Deleting a shared board clears its notifications.
CREATE INDEX IF NOT EXISTS notifications_board_idx ON notifications (entity_id) WHERE entity_type = 'board';

-- ── Per-person lookups for the export and erasure, on tables that grow with activity ──────────
CREATE INDEX IF NOT EXISTS notifications_actor_idx ON notifications (actor_id) WHERE actor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS message_reactions_user_idx ON message_reactions (user_id);
CREATE INDEX IF NOT EXISTS poll_votes_user_idx ON poll_votes (user_id);
CREATE INDEX IF NOT EXISTS chat_poll_votes_user_idx ON chat_poll_votes (user_id);
CREATE INDEX IF NOT EXISTS story_responses_user_idx ON story_responses (user_id);
CREATE INDEX IF NOT EXISTS post_audience_user_idx ON post_audience (user_id);
CREATE INDEX IF NOT EXISTS circle_members_user_idx ON circle_members (user_id);
CREATE INDEX IF NOT EXISTS live_participants_user_idx ON live_participants (user_id);
CREATE INDEX IF NOT EXISTS live_sessions_host_idx ON live_sessions (host_id, created_at DESC);
CREATE INDEX IF NOT EXISTS call_participants_user_idx ON call_participants (user_id);
CREATE INDEX IF NOT EXISTS togethers_creator_idx ON togethers (creator_id);
CREATE INDEX IF NOT EXISTS together_requests_user_idx ON together_requests (user_id);
CREATE INDEX IF NOT EXISTS room_reminders_user_idx ON room_reminders (user_id);
CREATE INDEX IF NOT EXISTS chapter_guestbook_author_idx ON chapter_guestbook (author_id);
CREATE INDEX IF NOT EXISTS place_reviews_author_idx ON place_reviews (author_id);
CREATE INDEX IF NOT EXISTS bookings_user_idx ON bookings (user_id);
CREATE INDEX IF NOT EXISTS photo_tags_tagged_by_idx ON photo_tags (tagged_by);
CREATE INDEX IF NOT EXISTS watch_queue_items_added_by_idx ON watch_queue_items (added_by) WHERE added_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS market_listings_reserved_for_idx ON market_listings (reserved_for) WHERE reserved_for IS NOT NULL;
CREATE INDEX IF NOT EXISTS market_listings_sold_to_idx ON market_listings (sold_to) WHERE sold_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS echoes_original_author_idx ON echoes (original_author_id) WHERE original_author_id IS NOT NULL;

-- ── Foreign keys to rows that really get deleted ─────────────────────────────────────────────
-- Deleting a row makes Postgres look for rows pointing at it. Without an index on the pointing
-- column that is a scan of the whole table for every deleted row. Messages are deleted when
-- disappearing messages expire (20 of them took 385 ms at 500,000 messages, all in the reply_to
-- check), media when uploads are cleaned up or an account is erased, listings and Together
-- photos when an account is erased, sounds and orders by retention.
CREATE INDEX IF NOT EXISTS messages_reply_to_idx ON messages (reply_to_id) WHERE reply_to_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS message_hides_message_idx ON message_hides (message_id);
CREATE INDEX IF NOT EXISTS conversation_pins_message_idx ON conversation_pins (message_id);
CREATE INDEX IF NOT EXISTS scheduled_messages_message_idx ON scheduled_messages (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS scheduled_messages_reply_to_idx ON scheduled_messages (reply_to_id) WHERE reply_to_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_reply_suggestions_message_idx ON ai_reply_suggestions (message_id);
CREATE INDEX IF NOT EXISTS market_chats_message_idx ON market_chats (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS post_media_media_idx ON post_media (media_id);
CREATE INDEX IF NOT EXISTS moments_media_idx ON moments (media_id) WHERE media_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS together_contributions_media_idx ON together_contributions (media_id) WHERE media_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS photo_tags_media_idx ON photo_tags (media_id);
CREATE INDEX IF NOT EXISTS live_sessions_recording_media_idx ON live_sessions (recording_media_id) WHERE recording_media_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS upload_sessions_media_idx ON upload_sessions (media_id) WHERE media_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS media_edits_result_media_idx ON media_edits (result_media_id) WHERE result_media_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS media_editor_renders_second_media_idx ON media_editor_renders (second_media_id) WHERE second_media_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sounds_media_idx ON sounds (media_id) WHERE media_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS drops_cover_media_idx ON drops (cover_media_id) WHERE cover_media_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS echoes_source_media_idx ON echoes (source_media_id) WHERE source_media_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS togethers_cover_item_idx ON togethers (cover_item_id) WHERE cover_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS market_saves_listing_idx ON market_saves (listing_id);
CREATE INDEX IF NOT EXISTS recaps_sound_idx ON recaps (sound_id) WHERE sound_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS music_saves_sound_idx ON music_saves (sound_id) WHERE sound_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mix_songs_sound_idx ON mix_songs (sound_id) WHERE sound_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS profiles_song_sound_idx ON profiles (song_sound_id) WHERE song_sound_id IS NOT NULL;
