import { registerExportSection } from './registry.js';

const CAP = 20_000;

/**
 * Built-in export sections for the core modules. Notes on what is deliberately NOT here:
 *  - messages RECEIVED from others (other people's private data); only messages the user SENT
 *  - other users' profiles beyond public username handles the user chose to connect with
 *  - session tokens, password hashes, MFA secrets, API key secrets, OAuth tokens (secrets never leave the system)
 *  - moderation staff notes and other users' reports about the user (safety investigations)
 */
export function registerCoreExportSections(): void {
  registerExportSection({
    key: 'account',
    description: 'Your account record',
    collect: async (_c, db, u) =>
      (
        await db.query(
          `SELECT id, email, email_verified_at, status, age_band, birth_date, locale, timezone, country_code, mfa_enabled, created_at, last_login_at, deletion_scheduled_for
           FROM users WHERE id = $1`,
          [u],
        )
      ).rows[0] ?? null,
  });

  registerExportSection({
    key: 'profile',
    description: 'Your profile',
    collect: async (_c, db, u) =>
      (
        await db.query(
          `SELECT username, display_name, bio, avatar_url, cover_url, mode, links, location_text, is_private, follower_count, following_count, friend_count, created_at FROM profiles WHERE user_id = $1`,
          [u],
        )
      ).rows[0] ?? null,
  });

  registerExportSection({
    key: 'preferences',
    description: 'Preferences, notification settings and advertising settings',
    collect: async (_c, db, u) => ({
      general:
        (await db.query('SELECT * FROM user_preferences WHERE user_id = $1', [u])).rows[0] ?? null,
      notifications: (
        await db.query(
          'SELECT kind, channel, enabled FROM notification_preferences WHERE user_id = $1 ORDER BY kind, channel',
          [u],
        )
      ).rows,
      advertising:
        (
          await db.query(
            'SELECT hidden_topics, limit_sensitive, updated_at FROM ad_preferences WHERE user_id = $1',
            [u],
          )
        ).rows[0] ?? null,
      interests: (
        await db.query(
          `SELECT t.slug, ui.weight, ui.source FROM user_interests ui JOIN topics t ON t.id = ui.topic_id WHERE ui.user_id = $1 ORDER BY t.slug`,
          [u],
        )
      ).rows,
      mutedTopics: (
        await db.query(
          `SELECT t.slug FROM topic_mutes tm JOIN topics t ON t.id = tm.topic_id WHERE tm.user_id = $1`,
          [u],
        )
      ).rows.map((r) => r.slug),
    }),
  });

  registerExportSection({
    key: 'posts',
    description: 'Posts you wrote',
    collect: async (_c, db, u) =>
      (
        await db.query(
          `SELECT id, kind, body, visibility, language, link_url, latitude, longitude, community_id, event_id, place_id, like_count, comment_count, created_at, edited_at
           FROM posts WHERE author_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ${CAP}`,
          [u],
        )
      ).rows,
  });

  registerExportSection({
    key: 'comments',
    description: 'Comments you wrote',
    collect: async (_c, db, u) =>
      (
        await db.query(
          `SELECT id, post_id, parent_id, body, created_at, edited_at FROM comments WHERE author_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ${CAP}`,
          [u],
        )
      ).rows,
  });

  registerExportSection({
    key: 'reactions_and_saves',
    description: 'Your reactions and saved items',
    collect: async (_c, db, u) => ({
      reactions: (
        await db.query(
          `SELECT target_type, target_id, kind, created_at FROM reactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT ${CAP}`,
          [u],
        )
      ).rows,
      saves: (
        await db.query(
          `SELECT target_type, target_id, collection, created_at FROM saves WHERE user_id = $1 ORDER BY created_at DESC LIMIT ${CAP}`,
          [u],
        )
      ).rows,
      pollVotes: (
        await db.query(
          `SELECT post_id, option_id, created_at FROM poll_votes WHERE user_id = $1 LIMIT ${CAP}`,
          [u],
        )
      ).rows,
    }),
  });

  registerExportSection({
    key: 'connections',
    description: 'People you follow, friends, circles, blocks and mutes',
    collect: async (_c, db, u) => ({
      following: (
        await db.query(
          `SELECT p.username, f.status, f.created_at FROM follows f JOIN profiles p ON p.user_id = f.followee_id WHERE f.follower_id = $1 ORDER BY f.created_at DESC LIMIT ${CAP}`,
          [u],
        )
      ).rows,
      // Only a count of followers: their identities are their own data.
      followerCount: (
        await db.query(
          `SELECT count(*)::int AS n FROM follows WHERE followee_id = $1 AND status = 'active'`,
          [u],
        )
      ).rows[0]!.n,
      friends: (
        await db.query(
          `SELECT p.username, fr.status, fr.created_at, fr.accepted_at FROM friendships fr JOIN profiles p ON p.user_id = CASE WHEN fr.user_low = $1 THEN fr.user_high ELSE fr.user_low END
          WHERE fr.user_low = $1 OR fr.user_high = $1 ORDER BY fr.created_at DESC LIMIT ${CAP}`,
          [u],
        )
      ).rows,
      circles: (
        await db.query(
          `SELECT c.id, c.kind, c.name, c.created_at, COALESCE(json_agg(p.username ORDER BY p.username) FILTER (WHERE p.username IS NOT NULL), '[]') AS members
           FROM circles c LEFT JOIN circle_members cm ON cm.circle_id = c.id LEFT JOIN profiles p ON p.user_id = cm.user_id WHERE c.owner_id = $1 GROUP BY c.id ORDER BY c.created_at`,
          [u],
        )
      ).rows,
      blocked: (
        await db.query(
          `SELECT p.username, b.created_at FROM user_blocks b JOIN profiles p ON p.user_id = b.blocked_id WHERE b.blocker_id = $1`,
          [u],
        )
      ).rows,
      muted: (
        await db.query(
          `SELECT p.username, m.created_at FROM user_mutes m JOIN profiles p ON p.user_id = m.muted_id WHERE m.muter_id = $1`,
          [u],
        )
      ).rows,
      restricted: (
        await db.query(
          `SELECT p.username, r.created_at FROM user_restrictions r JOIN profiles p ON p.user_id = r.restricted_id WHERE r.restrictor_id = $1`,
          [u],
        )
      ).rows,
    }),
  });

  registerExportSection({
    key: 'messages_sent',
    description: 'Messages you sent (not messages you received)',
    collect: async (_c, db, u) => ({
      messages: (
        await db.query(
          `SELECT m.id, m.conversation_id, m.kind, m.body, m.reply_to_id, m.created_at, m.edited_at FROM messages m
          WHERE m.sender_id = $1 AND m.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT ${CAP}`,
          [u],
        )
      ).rows,
      conversations: (
        await db.query(
          `SELECT c.id, c.kind, c.title, cm.role, cm.joined_at, cm.left_at FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id WHERE cm.user_id = $1 ORDER BY cm.joined_at DESC LIMIT 5000`,
          [u],
        )
      ).rows,
    }),
  });

  registerExportSection({
    key: 'moments_and_captures',
    description: 'Moments, Real captures and memories you created',
    collect: async (_c, db, u) => ({
      moments: (
        await db.query(
          `SELECT id, kind, body, visibility, expiry, expires_at, latitude, longitude, created_at FROM moments WHERE author_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ${CAP}`,
          [u],
        )
      ).rows,
      realCaptures: (
        await db.query(
          `SELECT id, caption, latitude, longitude, captured_at, visibility FROM real_captures WHERE author_id = $1 AND deleted_at IS NULL ORDER BY captured_at DESC LIMIT ${CAP}`,
          [u],
        )
      ).rows,
      memories: (
        await db.query(
          `SELECT id, kind, title, summary, date_start, date_end, privacy, created_at FROM memories WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ${CAP}`,
          [u],
        )
      ).rows,
    }),
  });

  registerExportSection({
    key: 'media',
    description:
      'Metadata of files you uploaded (the files themselves are downloadable from their own links)',
    collect: async (_c, db, u) =>
      (
        await db.query(
          `SELECT id, kind, mime_type, size_bytes, width, height, duration_ms, alt_text, status, created_at FROM media WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ${CAP}`,
          [u],
        )
      ).rows,
  });

  registerExportSection({
    key: 'commerce',
    description: 'Orders, payments (no card data), bookings, tickets and creator support',
    collect: async (_c, db, u) => ({
      orders: (
        await db.query(
          `SELECT o.id, o.status, o.currency, o.subtotal_cents, o.shipping_cents, o.total_cents, o.created_at,
                COALESCE((SELECT json_agg(json_build_object('title', i.title_snapshot, 'quantity', i.quantity, 'unitPriceCents', i.unit_price_cents)) FROM order_items i WHERE i.order_id = o.id), '[]') AS items
           FROM orders o WHERE o.buyer_id = $1 ORDER BY o.created_at DESC LIMIT ${CAP}`,
          [u],
        )
      ).rows,
      payments: (
        await db.query(
          `SELECT id, purpose, amount_cents, currency, status, created_at FROM payments WHERE payer_id = $1 ORDER BY created_at DESC LIMIT ${CAP}`,
          [u],
        )
      ).rows,
      bookings: (
        await db.query(
          `SELECT id, starts_at, ends_at, party_size, status, notes, created_at FROM bookings WHERE customer_id = $1 ORDER BY starts_at DESC LIMIT ${CAP}`,
          [u],
        )
      ).rows,
      tickets: (
        await db.query(
          `SELECT id, event_id, status, checked_in_at, created_at FROM tickets WHERE owner_id = $1 ORDER BY created_at DESC LIMIT ${CAP}`,
          [u],
        )
      ).rows,
      tips: (
        await db.query(
          `SELECT id, creator_id, amount_cents, currency, created_at FROM tips WHERE from_user_id = $1 ORDER BY created_at DESC LIMIT ${CAP}`,
          [u],
        )
      ).rows,
      subscriptions: (
        await db.query(
          `SELECT id, creator_id, status, current_period_end, created_at FROM subscriptions WHERE subscriber_id = $1 ORDER BY created_at DESC`,
          [u],
        )
      ).rows,
      reviews: (
        await db.query(
          `SELECT id, target_type, target_id, rating, body, created_at FROM reviews WHERE author_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ${CAP}`,
          [u],
        )
      ).rows,
    }),
  });

  registerExportSection({
    key: 'events_and_memberships',
    description: 'Events you host or attend, community and business memberships',
    collect: async (_c, db, u) => ({
      hosted: (
        await db.query(
          `SELECT id, title, starts_at, status, visibility FROM events WHERE host_id = $1 AND deleted_at IS NULL ORDER BY starts_at DESC LIMIT ${CAP}`,
          [u],
        )
      ).rows,
      attendance: (
        await db.query(
          `SELECT ea.event_id, e.title, ea.status, ea.created_at FROM event_attendees ea JOIN events e ON e.id = ea.event_id WHERE ea.user_id = $1 ORDER BY ea.created_at DESC LIMIT ${CAP}`,
          [u],
        )
      ).rows,
      communities: (
        await db.query(
          `SELECT c.id, c.name, c.slug, m.role_key, m.status, m.joined_at FROM community_members m JOIN communities c ON c.id = m.community_id WHERE m.user_id = $1`,
          [u],
        )
      ).rows,
      businesses: (
        await db.query(
          `SELECT b.id, b.name, bm.role FROM business_members bm JOIN businesses b ON b.id = bm.business_id WHERE bm.user_id = $1`,
          [u],
        )
      ).rows,
    }),
  });

  registerExportSection({
    key: 'notifications',
    description: 'Your notifications',
    collect: async (_c, db, u) =>
      (
        await db.query(
          `SELECT id, kind, target_type, target_id, data, read_at, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT ${CAP}`,
          [u],
        )
      ).rows,
  });

  registerExportSection({
    key: 'consents_and_requests',
    description: 'Your consent history and privacy requests',
    collect: async (_c, db, u) => ({
      consents: (
        await db.query(
          `SELECT purpose, granted, source, created_at FROM consents WHERE user_id = $1 ORDER BY created_at`,
          [u],
        )
      ).rows,
      privacyRequests: (
        await db.query(
          `SELECT id, kind, status, created_at, completed_at FROM privacy_requests WHERE user_id = $1 ORDER BY created_at`,
          [u],
        )
      ).rows,
    }),
  });

  registerExportSection({
    key: 'security',
    description: 'Sessions, devices and security events (never tokens or secrets)',
    collect: async (_c, db, u) => ({
      sessions: (
        await db.query(
          `SELECT id, created_at, last_seen_at, expires_at, revoked_at, ip::text AS ip, user_agent, mfa_verified FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 500`,
          [u],
        )
      ).rows,
      devices: (
        await db.query(
          `SELECT id, label, platform, trusted, first_seen_at, last_seen_at, revoked_at FROM devices WHERE user_id = $1`,
          [u],
        )
      ).rows,
      securityEvents: (
        await db.query(
          `SELECT type, ip::text AS ip, user_agent, created_at FROM security_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 2000`,
          [u],
        )
      ).rows,
      mfaEnabled:
        (await db.query(`SELECT mfa_enabled FROM users WHERE id = $1`, [u])).rows[0]?.mfa_enabled ??
        false,
    }),
  });

  registerExportSection({
    key: 'safety',
    description: 'Enforcement actions taken on your account and your own reports and appeals',
    collect: async (_c, db, u) => ({
      enforcements: (
        await db.query(
          `SELECT id, kind, reason, starts_at, ends_at, revoked_at, strike_points FROM enforcements WHERE user_id = $1 ORDER BY starts_at DESC`,
          [u],
        )
      ).rows,
      appeals: (
        await db.query(
          `SELECT id, case_id, statement, status, created_at, decided_at FROM appeals WHERE user_id = $1 ORDER BY created_at DESC`,
          [u],
        )
      ).rows,
      reportsMade: (
        await db.query(
          `SELECT target_type, target_id, reason, status, created_at FROM reports WHERE reporter_id = $1 ORDER BY created_at DESC LIMIT ${CAP}`,
          [u],
        )
      ).rows,
      guardianLinks: (
        await db.query(
          `SELECT gl.status, gl.created_at, CASE WHEN gl.minor_id = $1 THEN 'minor' ELSE 'guardian' END AS your_role FROM guardian_links gl WHERE gl.minor_id = $1 OR gl.guardian_id = $1`,
          [u],
        )
      ).rows,
    }),
  });

  registerExportSection({
    key: 'ai',
    description: 'AI conversations, memories, drafts and tool-call log',
    collect: async (_c, db, u) => ({
      memories: (
        await db.query(
          `SELECT id, content, source_type, created_at FROM ai_memories WHERE user_id = $1 ORDER BY created_at DESC LIMIT ${CAP}`,
          [u],
        )
      ).rows,
      conversations: (
        await db.query(
          `SELECT c.id, c.scope, c.title, c.created_at,
                COALESCE((SELECT json_agg(json_build_object('role', m.role, 'content', m.content, 'at', m.created_at) ORDER BY m.created_at) FROM ai_messages m WHERE m.conversation_id = c.id), '[]') AS messages
           FROM ai_conversations c WHERE c.user_id = $1 ORDER BY c.created_at DESC LIMIT 1000`,
          [u],
        )
      ).rows,
      artifacts: (
        await db.query(
          `SELECT id, kind, payload, status, created_at FROM ai_artifacts WHERE user_id = $1 ORDER BY created_at DESC LIMIT 2000`,
          [u],
        )
      ).rows,
      toolCalls: (
        await db.query(
          `SELECT tool, outcome, denial_reason, created_at FROM ai_tool_calls WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5000`,
          [u],
        )
      ).rows,
    }),
  });

  registerExportSection({
    key: 'developer',
    description: 'Developer apps you own and applications you authorised (no secrets)',
    collect: async (_c, db, u) => ({
      ownedApps: (
        await db.query(
          `SELECT id, name, description, redirect_uris, status, created_at FROM developer_apps WHERE owner_id = $1`,
          [u],
        )
      ).rows,
      authorizedApps: (
        await db.query(
          `SELECT a.name, g.scopes, g.created_at, g.revoked_at FROM oauth_grants g JOIN developer_apps a ON a.id = g.app_id WHERE g.user_id = $1`,
          [u],
        )
      ).rows,
      miniAppInstalls: (
        await db.query(
          `SELECT m.slug, i.granted_permissions, i.installed_at FROM mini_app_installs i JOIN mini_apps m ON m.id = i.mini_app_id WHERE i.user_id = $1`,
          [u],
        )
      ).rows,
    }),
  });

  registerExportSection({
    key: 'analytics',
    description: 'Pseudonymous analytics events attributed to you (only exist if you consented)',
    collect: async (_c, db, u) =>
      (
        await db.query(
          `SELECT name, properties, platform, created_at FROM analytics_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT ${CAP}`,
          [u],
        )
      ).rows,
  });
}
