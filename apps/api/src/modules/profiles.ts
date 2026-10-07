import type { FastifyInstance } from 'fastify';
import { tx } from '@yapilapi/database';
import {
  circleMembersSchema,
  circleSchema,
  circleUpdateSchema,
  MAX_CIRCLE_MEMBERS,
  MAX_CIRCLES,
  NOW_STATUS_HOURS,
  nowStatusSchema,
  onboardingCompleteSchema,
  setCoverSchema,
  pageQuerySchema,
  setInterestsSchema,
  updateProfileSchema,
  usernameSchema,
  profileAccent,
  profileTabs,
  type CoverEditState,
  type CoverPhoto,
  type CoverRecipe,
  type PostMusic,
  type Profile,
  type ProfileLink,
  type ProfileTab,
  suggestionReasonText,
  type PeopleSuggestion,
} from '@yapilapi/shared';
import { z } from 'zod';
import { AppError, badRequest, conflict, forbidden, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { decodeCursor, encodeCursor } from '../lib/cursor.ts';
import { notify, personalizationAllowed, track } from '../lib/services.ts';
import { learn, learnQuietly } from '../lib/affinity.ts';
import { emitWebhook } from '../lib/webhooks.ts';
import { ageOf, areFriends, blockUser, isBlockedEitherWay, PUBLIC_USER_COLS, toPublicUser, usernameMatchSql, type PublicUserRow } from '../lib/users.ts';
import { notBlockedSql, postVisibleSql } from '../lib/visibility.ts';
import { hostsWithIcons, iconHost, queueLinkIcons } from '../lib/link-icons.ts';
import { ENGLISH_REASONS, hydratePosts } from '../lib/posts.ts';
import { soundVisibleSql } from '../lib/sounds.ts';
import { trackMusic, tracksByIds, viewerCountries, type StoredPart } from '../lib/music/view.ts';
import { messagesAllowedSql } from '../lib/interactions.ts';
import { byOrWithSql, canInviteSql, canTagSql } from '../lib/collabs.ts';
import { MEDIA_BLOCKED_MESSAGE } from '../lib/media-moderation.ts';
import { clearCovers, retireCoverRender } from '../lib/covers.ts';
import { coverRecipeProblem, editSize, renderCover } from '../lib/cover-render.ts';
import { nowStatusesFor, ownNowStatus } from '../lib/now-status.ts';
import { hasAnswersTab, profileAskBox } from '../lib/ask.ts';
import { hasMixesTab } from '../lib/mixes.ts';
import { hasMarketTab } from '../lib/market.ts';
import { publishShares } from '../lib/location.ts';
import { me, requireAuth } from '../plugins/auth.ts';

const idParam = z.object({ id: z.string().uuid() });

/** The storage key in a stored file's address (…/media/<key>), or null for any other address. */
function mediaKeyOf(url: string): string | null {
  try {
    const m = /\/media\/(.+)$/.exec(new URL(url, 'http://localhost').pathname);
    return m ? decodeURIComponent(m[1]!) : null;
  } catch {
    return null;
  }
}

export default async function profilesModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;

  /**
   * People to add to a conversation, as you type. With no query: friends, people
   * you follow and recent chat partners. With a query: name or username prefix
   * matches, friends first, then people you follow, then everyone else. Blocked
   * people never appear; `canMessage` is false where minor protection or family
   * settings would refuse the conversation, so the app can say so up front.
   * `scope=followers` narrows to people who follow you (for picking close
   * friends); with no query it then lists all of them. `scope=mutuals` narrows
   * to people you can invite to co-author a post: you follow each other and
   * minor protection allows it; with no query it lists all of them.
   * `canTag` says whether you may tag them in a photo.
   */
  app.get('/v1/people/suggest', { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { q, limit, scope } = parse(
      z.object({
        q: z.string().trim().max(60).default(''),
        limit: z.coerce.number().int().min(1).max(20).default(8),
        scope: z.enum(['all', 'followers', 'mutuals']).default('all'),
      }),
      req.query,
    );
    // Literal match: %, _ and backslash are escaped rather than dropped (usernames often contain _).
    const term = q.replace(/^@/, '').replace(/[\\%_]/g, (c) => `\\${c}`);
    const { rows } = await ctx.db.query(
      `WITH me AS (SELECT birth_date FROM users WHERE id = $1),
       rel AS (
         SELECT pr.user_id,
                EXISTS (SELECT 1 FROM friendships fr WHERE (fr.user_a = $1 AND fr.user_b = pr.user_id) OR (fr.user_b = $1 AND fr.user_a = pr.user_id)) AS friend,
                EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followee_id = pr.user_id) AS following,
                (SELECT max(m.created_at) FROM messages m JOIN conversation_members a ON a.conversation_id = m.conversation_id AND a.user_id = $1
                   JOIN conversation_members b ON b.conversation_id = m.conversation_id AND b.user_id = pr.user_id) AS last_chat
         FROM profiles pr JOIN users u2 ON u2.id = pr.user_id
         WHERE pr.user_id <> $1 AND u2.status = 'active' AND u2.deleted_at IS NULL AND ${notBlockedSql('pr.user_id', '$1')}
           AND ($4 = 'all' OR EXISTS (SELECT 1 FROM follows fb WHERE fb.follower_id = pr.user_id AND fb.followee_id = $1))
           AND ($4 <> 'mutuals' OR ${canInviteSql('$1', 'pr.user_id')})
           AND (
             ($2 = '' AND $4 IN ('followers', 'mutuals'))
             OR ($2 = '' AND (EXISTS (SELECT 1 FROM friendships fr WHERE (fr.user_a = $1 AND fr.user_b = pr.user_id) OR (fr.user_b = $1 AND fr.user_a = pr.user_id))
                           OR EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followee_id = pr.user_id)
                           OR EXISTS (SELECT 1 FROM conversation_members a JOIN conversation_members b ON b.conversation_id = a.conversation_id
                                      WHERE a.user_id = $1 AND b.user_id = pr.user_id)))
             OR ($2 <> '' AND (pr.username ILIKE $2 || '%' OR pr.display_name ILIKE $2 || '%' OR pr.display_name ILIKE '% ' || $2 || '%'))
           )
       )
       SELECT ${PUBLIC_USER_COLS}, rel.friend, rel.following,
              -- Minor protection: an adult and a minor can only message once they're friends.
              (rel.friend OR NOT (
                 (coalesce(u2.birth_date > current_date - interval '18 years', false)) <>
                 (coalesce((SELECT birth_date FROM me) > current_date - interval '18 years', false))))
                AND ${messagesAllowedSql('$1', 'pr.user_id')} AS can_message,
              ${canTagSql('$1', 'pr.user_id')} AS can_tag
       FROM rel JOIN profiles pr ON pr.user_id = rel.user_id JOIN users u2 ON u2.id = rel.user_id
       ORDER BY rel.friend DESC, rel.following DESC, rel.last_chat DESC NULLS LAST,
                (pr.username ILIKE $2 || '%') DESC, pr.display_name
       LIMIT $3`,
      [u.id, term, limit, scope],
    );
    return {
      items: rows.map((r) => ({
        user: toPublicUser(r as PublicUserRow),
        relation: r.friend ? 'friend' : r.following ? 'following' : null,
        canMessage: !!r.can_message,
        canTag: !!r.can_tag,
      })),
    };
  });

  async function userIdByUsername(username: string, viewer: string | null, { blockedByViewer = false } = {}): Promise<string> {
    const { rows } = await db.query<{ user_id: string }>(
      // A username changed in the last 14 days still finds the profile; the page then moves to the new address.
      // Someone who blocked you never finds you; someone you blocked can be found (shown bare, to unblock) when asked for.
      `SELECT pr.user_id FROM profiles pr JOIN users u ON u.id = pr.user_id
       WHERE ${usernameMatchSql('pr', '$1')} AND u.status = 'active'
         AND ${
           blockedByViewer ? `NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = pr.user_id AND b.blocked_id = $2)` : notBlockedSql('pr.user_id', '$2')
         }`,
      [username, viewer],
    );
    if (!rows[0]) throw notFound('That profile');
    return rows[0].user_id;
  }

  /** A profile's links, each with its site icon when the server has one. */
  async function linksOut(raw: unknown): Promise<ProfileLink[]> {
    // Web links only: anything saved before links had to be http(s) is left out rather than shown as a link.
    const links = ((raw ?? []) as { label: string; url: string }[]).filter((l) => typeof l?.url === 'string' && /^https?:\/\//i.test(l.url));
    const withIcon = await hostsWithIcons(
      db,
      links.map((l) => iconHost(l.url)).filter((h): h is string => !!h),
    );
    return links.map((l) => {
      const host = iconHost(l.url);
      return {
        label: l.label,
        url: l.url,
        iconUrl: host && withIcon.has(host) ? `${ctx.config.PUBLIC_API_URL}/v1/link-icons/${encodeURIComponent(host)}` : null,
      };
    });
  }

  /** Featured posts in the order chosen, only those this viewer can see (and never from a community). */
  async function featuredOut(userId: string, ids: string[], viewer: string | null) {
    if (!ids.length) return [];
    const { rows } = await db.query<{ id: string }>(
      `SELECT p.id FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
       WHERE p.id = ANY($2::uuid[]) AND p.author_id = $3 AND p.community_id IS NULL AND ${postVisibleSql('$1')}`,
      [viewer, ids, userId],
    );
    const visible = new Set(rows.map((r) => r.id));
    return hydratePosts(
      db,
      ids.filter((id) => visible.has(id)),
      viewer,
    );
  }

  /** The profile song for this viewer: a sound they can see, or a catalogue song checked against its licence where they are. */
  async function songOut(r: Record<string, any>, viewer: string | null): Promise<PostMusic | null> {
    const part = r.song_part as StoredPart | null;
    if (!part) return null;
    if (r.song_track_id) {
      const row = (await tracksByIds(db, [r.song_track_id])).get(r.song_track_id);
      if (!row) return null;
      return trackMusic(row, part, { countries: await viewerCountries(db, viewer), commercial: r.mode === 'business' });
    }
    if (!r.song_sound_id) return null;
    const { rows } = await db.query(
      `SELECT s.id, s.title, coalesce(sm.variants->>'mp4', sm.url) AS audio, so.display_name AS artist, sm.poster_url AS cover,
              (s.owner_id IS NOT DISTINCT FROM $2 OR ${soundVisibleSql('$2')}) AS visible
       FROM sounds s LEFT JOIN media sm ON sm.id = s.media_id LEFT JOIN profiles so ON so.user_id = s.owner_id WHERE s.id = $1`,
      [r.song_sound_id, viewer],
    );
    const s = rows[0];
    if (!s?.visible) return null;
    return {
      source: 'library',
      id: s.id,
      title: s.title,
      artist: s.artist ?? '',
      coverUrl: s.cover ?? null,
      audioUrl: s.audio ?? null,
      startMs: part.startMs,
      durationMs: part.durationMs,
      style: 'compact',
      licenceName: null,
      licenceUrl: null,
      attribution: null,
    };
  }

  /**
   * The tabs they chose; Answers only while their question box is on or has answers, Mixes only
   * while the viewer may see one of their mixes, Market only while they have something listed the
   * viewer may see or Market ratings (never leaving none).
   */
  async function tabsOf(userId: string, saved: string[] | null, viewer: string | null): Promise<ProfileTab[]> {
    let tabs = profileTabs(saved);
    if (tabs.includes('answers') && !(await hasAnswersTab(db, userId))) tabs = tabs.filter((t) => t !== 'answers');
    if (tabs.includes('mixes') && !(await hasMixesTab(db, userId, viewer))) tabs = tabs.filter((t) => t !== 'mixes');
    if (tabs.includes('market') && !(await hasMarketTab(db, userId, viewer))) tabs = tabs.filter((t) => t !== 'market');
    return tabs.length ? tabs : ['posts'];
  }

  /** The original behind your cover, as a processed size to edit on, and the recipe; null when it can't be edited again. */
  async function coverEditOf(mediaId: string | null, recipe: CoverRecipe | null, ownerId: string): Promise<CoverEditState | null> {
    if (!mediaId) return null;
    const { rows } = await db.query(
      `SELECT id, url, variants, width, height, alt_text FROM media
       WHERE id = $1 AND owner_id = $2 AND kind = 'image' AND NOT private AND deleted_at IS NULL AND storage_key IS NOT NULL`,
      [mediaId, ownerId],
    );
    const m = rows[0];
    if (!m) return null;
    const variants = (m.variants ?? {}) as Record<string, string>;
    const url = variants.large ?? variants.medium;
    if (!url) return null;
    return { mediaId: m.id, url, width: m.width, height: m.height, altText: m.alt_text, recipe: recipe ?? null };
  }

  async function loadProfile(userId: string, viewer: string | null): Promise<Profile> {
    const { rows } = await db.query(
      `SELECT ${PUBLIC_USER_COLS}, pr.bio, pr.cover_url, pr.cover_alt, pr.cover_media_id, pr.cover_edit, pr.links, pr.is_private,
        pr.accent, pr.header_style, pr.pronouns, pr.city, pr.tabs, pr.featured_post_ids, pr.song_sound_id, pr.song_track_id, pr.song_part,
        coalesce(u.created_at, pr.created_at) AS joined_at,
        coalesce(u.birth_date > current_date - interval '18 years', false) AS is_minor,
        (SELECT count(*) FROM follows WHERE followee_id = pr.user_id) AS followers,
        (SELECT count(*) FROM follows WHERE follower_id = pr.user_id) AS following,
        (SELECT count(*) FROM friendships WHERE user_a = pr.user_id OR user_b = pr.user_id) AS friends,
        (SELECT count(*) FROM posts p WHERE ${byOrWithSql('pr.user_id')} AND p.deleted_at IS NULL AND p.status = 'published' AND p.community_id IS NULL) AS posts,
        (SELECT coalesce(array_agg(t.slug ORDER BY t.slug), '{}') FROM user_interests ui JOIN topics t ON t.id = ui.topic_id WHERE ui.user_id = pr.user_id) AS interests,
        EXISTS (SELECT 1 FROM follows WHERE follower_id = $2 AND followee_id = pr.user_id) AS following_them,
        EXISTS (SELECT 1 FROM follows WHERE follower_id = pr.user_id AND followee_id = $2) AS followed_by,
        EXISTS (SELECT 1 FROM friendships WHERE (user_a = $2 AND user_b = pr.user_id) OR (user_b = $2 AND user_a = pr.user_id)) AS is_friend,
        (SELECT CASE WHEN from_user_id = $2 THEN 'sent' ELSE 'received' END FROM friend_requests
          WHERE status = 'pending' AND ((from_user_id = $2 AND to_user_id = pr.user_id) OR (from_user_id = pr.user_id AND to_user_id = $2)) LIMIT 1) AS friend_request,
        (SELECT CASE WHEN follower_id = $2 THEN 'sent' ELSE 'received' END FROM follow_requests
          WHERE (follower_id = $2 AND followee_id = pr.user_id) OR (follower_id = pr.user_id AND followee_id = $2) ORDER BY follower_id = $2 DESC LIMIT 1) AS follow_request,
        EXISTS (SELECT 1 FROM blocks WHERE blocker_id = $2 AND blocked_id = pr.user_id) AS blocked,
        EXISTS (SELECT 1 FROM mutes WHERE muter_id = $2 AND muted_id = pr.user_id) AS muted
       FROM profiles pr JOIN users u ON u.id = pr.user_id WHERE pr.user_id = $1`,
      [userId, viewer],
    );
    const r = rows[0];
    if (!r) throw notFound('That profile');
    const status = (await nowStatusesFor(db, [userId], viewer)).get(userId) ?? null;
    const isSelf = viewer === userId;
    return {
      ...toPublicUser(r as PublicUserRow),
      bio: r.bio,
      coverUrl: r.cover_url,
      coverAlt: r.cover_url ? (r.cover_alt ?? null) : null,
      // The original and the recipe are for editing: only you get them.
      ...(isSelf ? { coverEdit: r.cover_url ? await coverEditOf(r.cover_media_id, r.cover_edit, userId) : null } : {}),
      nowStatus: status,
      links: await linksOut(r.links),
      isPrivate: r.is_private,
      interests: r.interests,
      counts: { followers: r.followers, following: r.following, friends: r.friends, posts: r.posts },
      style: { accent: profileAccent(r.accent), header: r.header_style },
      pronouns: r.pronouns || null,
      // A city on an under-18's account is only ever shown to them.
      city: r.city && (isSelf || !r.is_minor) ? r.city : null,
      joinedAt: new Date(r.joined_at).toISOString(),
      tabs: await tabsOf(userId, r.tabs, viewer),
      featured: await featuredOut(userId, r.featured_post_ids ?? [], viewer),
      song: await songOut(r, viewer),
      ask: await profileAskBox(db, userId, viewer),
      relationship: {
        isSelf: viewer === userId,
        following: r.following_them,
        followedBy: r.followed_by,
        friends: r.is_friend,
        friendRequest: r.friend_request ?? 'none',
        followRequest: r.follow_request ?? 'none',
        blocked: r.blocked,
        muted: r.muted,
      },
    };
  }

  // ── Profile ───────────────────────────────────────────────────────────
  app.get('/v1/users/:username', async (req) => {
    const { username } = parse(z.object({ username: usernameSchema }), req.params);
    const viewer = req.user?.id ?? null;
    const id = await userIdByUsername(username, viewer, { blockedByViewer: !!viewer });
    if (!viewer) {
      // People without an account never see accounts of under-18s, and see only the name and picture of private ones.
      const minor = await db.query(`SELECT 1 FROM users WHERE id = $1 AND birth_date > current_date - interval '18 years'`, [id]);
      if (minor.rowCount) throw notFound('That person');
    }
    const profile = await loadProfile(id, viewer);
    // Someone you blocked: their name and picture only, so the page can say so and offer Unblock.
    if (profile.relationship.blocked)
      return {
        profile: {
          ...profile,
          bio: '',
          links: [],
          interests: [],
          coverUrl: null,
          coverAlt: null,
          nowStatus: null,
          pronouns: null,
          city: null,
          featured: [],
          song: null,
          ask: null,
          tabs: [],
          counts: { followers: 0, following: 0, friends: 0, posts: 0 },
        },
      };
    if (!viewer && profile.isPrivate)
      return {
        profile: {
          ...profile,
          bio: '',
          links: [],
          interests: [],
          coverUrl: null,
          coverAlt: null,
          nowStatus: null,
          pronouns: null,
          city: null,
          featured: [],
          song: null,
          ask: null,
        },
      };
    return { profile };
  });

  /** The address of one of your own photos that `url` points at (the upload or a processed size of it). */
  async function ownAvatar(userId: string, url: string): Promise<string> {
    const key = mediaKeyOf(url);
    const refused = () => badRequest('Upload a photo first.', { fields: { avatarUrl: 'Upload a photo first.' } });
    if (!key) throw refused();
    const { rows } = await db.query(
      `SELECT m.url, m.variants, m.moderation FROM media m
       WHERE m.owner_id = $1 AND m.kind = 'image' AND NOT m.private AND m.deleted_at IS NULL
         AND (m.url LIKE '%/media/' || $2 OR EXISTS (SELECT 1 FROM jsonb_each_text(coalesce(m.variants, '{}'::jsonb)) v WHERE v.value LIKE '%/media/' || $2))
       LIMIT 1`,
      [userId, key.replace(/[\\%_]/g, (c) => `\\${c}`)],
    );
    const m = rows[0];
    if (!m) throw refused();
    if (m.moderation === 'blocked') throw new AppError(422, 'media_blocked', MEDIA_BLOCKED_MESSAGE);
    if (m.moderation === 'sensitive')
      throw new AppError(422, 'media_sensitive', 'This photo may be sensitive, so it can’t be your profile photo. Choose another one.');
    return ((m.variants ?? {}) as Record<string, string>).medium ?? m.url;
  }

  app.patch('/v1/me/profile', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const input = parse(updateProfileSchema, req.body);
    const map: Record<string, string> = {
      displayName: 'display_name',
      bio: 'bio',
      avatarUrl: 'avatar_url',
      coverAlt: 'cover_alt',
      links: 'links',
      mode: 'mode',
      locale: 'locale',
      isPrivate: 'is_private',
      country: 'country',
      pronouns: 'pronouns',
      city: 'city',
      accent: 'accent',
      headerStyle: 'header_style',
      tabs: 'tabs',
      featuredPostIds: 'featured_post_ids',
    };
    // A profile photo is one of your own uploads, never an address elsewhere (it would reach every
    // viewer's device without the checks uploads get). The stored address is the upload's own.
    if (input.avatarUrl) input.avatarUrl = await ownAvatar(u.id, input.avatarUrl);
    const sets: string[] = [];
    const vals: unknown[] = [u.id];
    for (const [k, col] of Object.entries(map)) {
      const v = (input as Record<string, unknown>)[k];
      if (v === undefined || (k === 'coverAlt' && input.coverUrl === null)) continue;
      vals.push(k === 'links' ? JSON.stringify(v) : v);
      sets.push(`${col} = $${vals.length}`);
    }
    // Featured: only your own published posts and reels that other people can see (not in a community, not held by moderation).
    if (input.featuredPostIds?.length) {
      const own = await db.query(
        `SELECT id FROM posts WHERE id = ANY($1::uuid[]) AND author_id = $2 AND deleted_at IS NULL AND status = 'published'
           AND community_id IS NULL AND moderation_status = 'normal' AND visibility <> 'private'`,
        [input.featuredPostIds, u.id],
      );
      if (own.rowCount !== input.featuredPostIds.length)
        throw new AppError(400, 'validation_failed', 'Check the highlighted fields.', {
          fields: { featuredPostIds: 'Choose from your own posts and reels that people can see.' },
        });
    }
    // The song is checked like music on a post: a sound you may use, or a catalogue song its licence lets you use here.
    if (input.song === null) sets.push(`song_sound_id = NULL, song_track_id = NULL, song_part = NULL`);
    else if (input.song) {
      const prepared = await ctx.music.prepareUse(u.id, input.song, 'posts');
      vals.push(prepared.soundId, prepared.trackId, JSON.stringify(prepared.stored));
      sets.push(`song_sound_id = $${vals.length - 2}, song_track_id = $${vals.length - 1}, song_part = $${vals.length}`);
    }
    // Minors can't make their account public.
    if (input.isPrivate === false) {
      const age = ageOf(u.birthDate);
      if (age !== null && age < 18) throw forbidden('Accounts for people under 18 stay private.');
    }
    if (input.country !== undefined) sets.push(input.country === null ? `country_source = NULL` : `country_source = 'user'`);
    // A cover photo is set from your own uploads (PUT /v1/me/cover); here it can only be removed.
    if (input.coverUrl) throw badRequest('Choose a cover photo from your own uploads.', { fields: { coverUrl: 'Upload a photo first.' } });
    if (sets.length) await db.query(`UPDATE profiles SET ${sets.join(', ')} WHERE user_id = $1`, vals);
    // A public account has nothing to approve: everyone still waiting follows it now (quietly, as they asked).
    if (input.isPrivate === false)
      await db.query(
        `WITH gone AS (DELETE FROM follow_requests WHERE followee_id = $1 RETURNING follower_id)
         INSERT INTO follows (follower_id, followee_id) SELECT follower_id, $1 FROM gone ON CONFLICT DO NOTHING`,
        [u.id],
      );
    if (input.isPrivate === false) await db.query(`UPDATE notifications SET type = 'follow' WHERE user_id = $1 AND type = 'follow_request'`, [u.id]);
    if (input.coverUrl === null) await clearCovers(db, `user_id = $1`, [u.id]);
    // Site icons for the links are fetched in the background, never while you wait.
    if (input.links?.length)
      await queueLinkIcons(
        db,
        input.links.map((l) => l.url),
      );
    return { profile: await loadProfile(u.id, u.id) };
  });

  /**
   * A profile link's site icon, as fetched and checked by the server (lib/link-icons.ts). Only
   * recognised image types are served, with a type taken from the bytes and nothing that runs.
   */
  app.get('/v1/link-icons/:host', async (req, reply) => {
    const { host } = parse(
      z.object({
        host: z
          .string()
          .max(253)
          .regex(/^[a-z0-9.-]+$/),
      }),
      req.params,
    );
    const { rows } = await db.query(`SELECT image, mime FROM link_icons WHERE host = $1 AND image IS NOT NULL`, [host]);
    if (!rows[0]) throw notFound('That icon');
    return reply
      .header('content-type', rows[0].mime)
      .header('cache-control', 'public, max-age=86400')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .send(rows[0].image);
  });

  // ── Cover photo ───────────────────────────────────────────────────────
  const coverSensitive = () => new AppError(422, 'media_sensitive', 'This photo may be sensitive, so it can’t be a cover. Choose another one.');

  /**
   * Set your cover photo from one of your own uploads (POST /v1/media or
   * /v1/uploads). It must be a photo that finished processing, not marked
   * sensitive or blocked by the automated check. The profile shows a
   * processed size, never the original file.
   *
   * With `edit` (framing in the cover shape, straighten, a look and its
   * strength, adjustments), the server renders a new copy from the original
   * (lib/cover-render.ts) and keeps the recipe, so you can edit it again from
   * the original later. Sending the same photo and edit again changes nothing
   * but the description.
   */
  app.put('/v1/me/cover', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req) => {
    const u = me(req);
    const input = parse(setCoverSchema, req.body);
    const { rows } = await db.query(
      `SELECT m.kind, m.status, m.moderation, m.variants, m.url, m.alt_text, m.mime, m.storage_key,
              EXISTS (SELECT 1 FROM profiles pr WHERE pr.cover_render_media_id = m.id) AS is_render
       FROM media m WHERE m.id = $1 AND m.owner_id = $2 AND NOT m.private AND m.deleted_at IS NULL`,
      [input.mediaId, u.id],
    );
    const m = rows[0];
    if (!m) throw notFound('That photo');
    if (m.kind !== 'image') throw badRequest('Choose a photo for your cover.');
    // A cover is always made from an original, never from an earlier edited copy.
    if (m.is_render) throw badRequest('Edit your cover from its original photo.');
    if (m.moderation === 'blocked') throw new AppError(422, 'media_blocked', MEDIA_BLOCKED_MESSAGE);
    if (m.moderation === 'sensitive') throw coverSensitive();
    if (input.edit && m.mime === 'image/gif') throw new AppError(415, 'unsupported_media', 'Animated GIFs cannot be edited.');
    const variants = (m.variants ?? {}) as Record<string, string>;
    const url = variants.large ?? variants.medium;
    if (m.status !== 'ready' || !url) throw new AppError(409, 'media_processing', 'Your photo is still being prepared. Try again in a moment.');
    const alt = input.altText || m.alt_text || null;

    let cover: { url: string; renderId: string | null; recipe: CoverRecipe | null } = { url, renderId: null, recipe: null };
    if (input.edit) {
      const recipe = input.edit as CoverRecipe;
      if (!m.storage_key) throw badRequest('This photo was not uploaded here, so it cannot be edited.');
      // The same photo with the same edit: nothing to render again.
      const same = await db.query(
        `UPDATE profiles SET cover_alt = $4 WHERE user_id = $1 AND cover_media_id = $2 AND cover_edit = $3::jsonb AND cover_render_media_id IS NOT NULL RETURNING 1`,
        [u.id, input.mediaId, JSON.stringify(recipe), alt],
      );
      if (same.rowCount) return { profile: await loadProfile(u.id, u.id) };
      const original = await ctx.storage.read(m.storage_key);
      const size = await editSize(original);
      if (!size) throw badRequest("We couldn't read this photo. Choose another one.");
      const problem = coverRecipeProblem(recipe, size.width, size.height);
      if (problem) throw new AppError(400, 'validation_failed', 'Check the highlighted fields.', { fields: { 'edit.crop': problem } });
      const rendered = await renderCover({ db, storage: ctx.storage }, u.id, original, recipe, m.moderation).catch((err) => {
        req.log.warn({ err }, 'cover render failed');
        throw new AppError(422, 'edit_failed', 'We couldn’t apply your edits to this photo. Try again, or choose another photo.');
      });
      cover = { url: rendered.url, renderId: rendered.mediaId, recipe };
    }

    const refused = await tx(db, async (c) => {
      const prev = await c.query(`SELECT cover_render_media_id FROM profiles WHERE user_id = $1 FOR UPDATE`, [u.id]);
      // The automated check may have finished while the cover was rendering.
      const verdict = (await c.query(`SELECT moderation FROM media WHERE id = $1 FOR SHARE`, [input.mediaId])).rows[0]?.moderation as string | undefined;
      if (verdict === 'blocked' || verdict === 'sensitive') return verdict;
      await retireCoverRender(c, prev.rows[0]?.cover_render_media_id, cover.renderId);
      await c.query(`UPDATE profiles SET cover_url = $2, cover_media_id = $3, cover_alt = $4, cover_edit = $5, cover_render_media_id = $6 WHERE user_id = $1`, [
        u.id,
        cover.url,
        input.mediaId,
        alt,
        cover.recipe ? JSON.stringify(cover.recipe) : null,
        cover.renderId,
      ]);
      await c.query(`UPDATE media SET used_at = coalesce(used_at, now()) WHERE id = $1`, [input.mediaId]);
      return null;
    }).catch(async (err) => {
      await retireCoverRender(db, cover.renderId);
      throw err;
    });
    if (refused) {
      await retireCoverRender(db, cover.renderId);
      throw refused === 'blocked' ? new AppError(422, 'media_blocked', MEDIA_BLOCKED_MESSAGE) : coverSensitive();
    }
    return { profile: await loadProfile(u.id, u.id) };
  });

  /**
   * Your recent photos that can be a cover: your own, finished, not marked sensitive or blocked,
   * not view-once and not an earlier cover's edited copy. Newest first.
   */
  app.get('/v1/me/cover/photos', { preHandler: requireAuth }, async (req) => {
    const { rows } = await db.query(
      `SELECT m.id, m.url, m.variants, m.width, m.height, m.alt_text, m.created_at FROM media m
       WHERE m.owner_id = $1 AND m.kind = 'image' AND m.status = 'ready' AND NOT m.private AND m.deleted_at IS NULL
         AND m.moderation IN ('pending', 'ok') AND m.storage_key IS NOT NULL AND m.mime <> 'image/gif'
         AND NOT EXISTS (SELECT 1 FROM profiles pr WHERE pr.cover_render_media_id = m.id)
       ORDER BY m.created_at DESC LIMIT 30`,
      [me(req).id],
    );
    const items: CoverPhoto[] = [];
    for (const r of rows) {
      const v = (r.variants ?? {}) as Record<string, string>;
      const url = v.large ?? v.medium;
      if (!url) continue;
      items.push({
        id: r.id,
        thumbUrl: v.thumb ?? v.medium ?? url,
        url,
        width: r.width,
        height: r.height,
        altText: r.alt_text,
        createdAt: new Date(r.created_at).toISOString(),
      });
    }
    return { items };
  });

  app.delete('/v1/me/cover', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    await clearCovers(db, `user_id = $1`, [u.id]);
    return { profile: await loadProfile(u.id, u.id) };
  });

  // ── "Now" status ──────────────────────────────────────────────────────
  /** Your status, if you have one that hasn't ended, with who it's for. */
  app.get('/v1/me/status', { preHandler: requireAuth }, async (req) => ({ status: await ownNowStatus(db, me(req).id) }));

  /** Set your status. It ends 24 hours from now; setting it again starts a new 24 hours. */
  app.put('/v1/me/status', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 hour' } } }, async (req) => {
    const u = me(req);
    const input = parse(nowStatusSchema, req.body);
    await db.query(
      `INSERT INTO profile_statuses (user_id, text, icon, audience, expires_at) VALUES ($1,$2,$3,$4, now() + make_interval(hours => $5))
       ON CONFLICT (user_id) DO UPDATE SET text = EXCLUDED.text, icon = EXCLUDED.icon, audience = EXCLUDED.audience,
         created_at = now(), expires_at = EXCLUDED.expires_at`,
      [u.id, input.text, input.icon, input.audience, NOW_STATUS_HOURS],
    );
    return { status: await ownNowStatus(db, u.id) };
  });

  app.delete('/v1/me/status', { preHandler: requireAuth }, async (req) => {
    await db.query(`DELETE FROM profile_statuses WHERE user_id = $1`, [me(req).id]);
    return { status: null };
  });

  app.get('/v1/topics', async () => {
    const { rows } = await db.query(`SELECT slug, name FROM topics ORDER BY name`);
    return { items: rows };
  });

  app.put('/v1/me/interests', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { topics } = parse(setInterestsSchema, req.body);
    const slugs = [...new Set(topics.map((t) => t.toLowerCase().trim().replace(/\s+/g, '-')))];
    await tx(db, async (c) => {
      for (const s of slugs) await c.query(`INSERT INTO topics (slug, name) VALUES ($1, initcap(replace($1, '-', ' '))) ON CONFLICT (slug) DO NOTHING`, [s]);
      await c.query(`DELETE FROM user_interests WHERE user_id = $1`, [u.id]);
      await c.query(`INSERT INTO user_interests (user_id, topic_id) SELECT $1, id FROM topics WHERE slug = ANY($2)`, [u.id, slugs]);
    });
    return { interests: slugs };
  });

  /**
   * Finish onboarding. The first time, an `onboarding_completed` analytics event records
   * what each step did (counts only: how many interests, follows and friends found).
   */
  app.post('/v1/me/onboarding/complete', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const input = parse(onboardingCompleteSchema, req.body);
    const first = await db.query(`UPDATE users SET onboarded_at = now() WHERE id = $1 AND onboarded_at IS NULL RETURNING id`, [u.id]);
    if (first.rowCount) {
      const following = Number((await db.query(`SELECT count(*) AS n FROM follows WHERE follower_id = $1`, [u.id])).rows[0].n);
      track(db, u.id, 'onboarding_completed', {
        platform: input.platform ?? null,
        steps: input.steps,
        completedSteps: input.steps.filter((s) => !s.skipped).map((s) => s.step),
        following,
      });
    }
    return { ok: true };
  });

  /**
   * People to follow: shared interests, friends-of-follows, then popular. Excludes blocked and
   * already-followed. `kind=creators` (onboarding) only suggests people who posted publicly in
   * the last 30 days, favouring reels, so following them fills Home right away.
   */
  app.get('/v1/me/suggestions', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const q = parse(z.object({ kind: z.enum(['people', 'creators']).default('people'), limit: z.coerce.number().int().min(1).max(30).default(12) }), req.query);
    const creators = q.kind === 'creators';
    const recent = `(SELECT count(*) FROM posts rp WHERE rp.author_id = pr.user_id AND rp.deleted_at IS NULL AND rp.status = 'published' AND rp.visibility = 'public'
                       AND rp.moderation_status = 'normal' AND rp.created_at > now() - interval '30 days')`;
    const recentReels = `(SELECT count(*) FROM posts rp WHERE rp.author_id = pr.user_id AND rp.deleted_at IS NULL AND rp.status = 'published' AND rp.visibility = 'public'
                       AND rp.moderation_status = 'normal' AND rp.format = 'reel' AND rp.created_at > now() - interval '30 days')`;
    // Recent public posts on the topics the person picked (onboarding saves interests first).
    const topical = `(SELECT count(*) FROM posts rp WHERE rp.author_id = pr.user_id AND rp.deleted_at IS NULL AND rp.status = 'published' AND rp.visibility = 'public'
                       AND rp.moderation_status = 'normal' AND rp.created_at > now() - interval '30 days'
                       AND $3 AND rp.topics && coalesce((SELECT array_agg(t.slug) FROM user_interests ui JOIN topics t ON t.id = ui.topic_id WHERE ui.user_id = $1), '{}'))`;
    const { rows } = await db.query(
      `SELECT * FROM (
         SELECT ${PUBLIC_USER_COLS}, pr.bio, pr.created_at,
          (SELECT count(*) FROM user_interests a JOIN user_interests b ON a.topic_id = b.topic_id WHERE $3 AND a.user_id = $1 AND b.user_id = pr.user_id) AS shared,
          (SELECT count(*) FROM follows f1 JOIN follows f2 ON f2.follower_id = f1.followee_id WHERE $3 AND f1.follower_id = $1 AND f2.followee_id = pr.user_id) AS mutual,
          (SELECT count(*) FROM follows WHERE followee_id = pr.user_id) AS followers
          ${creators ? `, ${recent} AS recent, ${recentReels} AS reels, ${topical} AS topical` : ''}
         FROM profiles pr JOIN users us ON us.id = pr.user_id
         WHERE pr.user_id <> $1 AND us.status = 'active' AND NOT pr.is_private
           AND NOT EXISTS (SELECT 1 FROM follows WHERE follower_id = $1 AND followee_id = pr.user_id)
           AND ${notBlockedSql('pr.user_id', '$1')}
       ) s
       ${creators ? 'WHERE s.recent > 0' : ''}
       ORDER BY ${creators ? '(s.topical > 0) DESC, s.shared DESC, (s.reels > 0) DESC, s.mutual DESC, s.followers DESC, s.topical DESC, s.recent DESC' : 's.shared DESC, s.mutual DESC, s.followers DESC'}, s.created_at DESC
       LIMIT $2`,
      // $3: Personalization. Off, shared interests, people you follow and your topics are left out: popular people come first.
      [u.id, q.limit, await personalizationAllowed(db, u.id)],
    );
    const reasonOf = (r: Record<string, any>): Pick<PeopleSuggestion, 'reasonCode' | 'reasonParams'> =>
      Number(r.mutual) > 0
        ? { reasonCode: 'mutual', reasonParams: { count: Number(r.mutual) } }
        : Number(r.shared) > 0
          ? { reasonCode: 'shared_interests', reasonParams: { count: Number(r.shared) } }
          : creators && Number(r.topical) > 0
            ? { reasonCode: 'topical', reasonParams: {} }
            : creators && Number(r.reels) > 0
              ? { reasonCode: 'reels', reasonParams: {} }
              : { reasonCode: 'popular', reasonParams: {} };
    return {
      items: rows.map((r): PeopleSuggestion => {
        const why = reasonOf(r);
        // The apps put the code into words; the English stays for older apps.
        return { user: toPublicUser(r as PublicUserRow), bio: r.bio, reason: suggestionReasonText(why, ENGLISH_REASONS), ...why };
      }),
    };
  });

  // ── Follow ────────────────────────────────────────────────────────────
  /**
   * Follow someone. A private account is asked first: the request waits in follow_requests until
   * they accept or decline (`requested: true`), and nothing of theirs opens up until then.
   */
  app.post('/v1/users/:id/follow', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    if (id === u.id) throw badRequest("You can't follow yourself.");
    if (await isBlockedEitherWay(db, u.id, id)) throw notFound('That profile');
    const target = await db.query<{ is_private: boolean }>(
      `SELECT pr.is_private FROM profiles pr JOIN users x ON x.id = pr.user_id WHERE pr.user_id = $1 AND x.status = 'active' AND x.deleted_at IS NULL`,
      [id],
    );
    if (!target.rows[0]) throw notFound('That profile');
    const already = await db.query(`SELECT 1 FROM follows WHERE follower_id = $1 AND followee_id = $2`, [u.id, id]);
    if (already.rowCount) return { following: true, requested: false };
    if (target.rows[0].is_private) {
      const asked = await db.query(`INSERT INTO follow_requests (follower_id, followee_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [u.id, id]);
      if (asked.rowCount)
        await notify(db, ctx.realtime, { userId: id, category: 'friends', type: 'follow_request', actorId: u.id, entityType: 'user', entityId: u.id });
      return { following: false, requested: true };
    }
    const r = await db.query(`INSERT INTO follows (follower_id, followee_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [u.id, id]);
    if (r.rowCount) await followed(u.id, id);
    return { following: true, requested: false };
  });

  /** What follows a new follow: their notification, the event and the webhook. */
  async function followed(follower: string, followee: string, type: 'follow' | 'follow_accepted' = 'follow') {
    if (type === 'follow')
      await notify(db, ctx.realtime, { userId: followee, category: 'friends', type: 'follow', actorId: follower, entityType: 'user', entityId: follower });
    else
      await notify(db, ctx.realtime, {
        userId: follower,
        category: 'friends',
        type: 'follow_accepted',
        actorId: followee,
        entityType: 'user',
        entityId: followee,
      });
    track(db, follower, 'follow', { followee });
    // Following someone, from anywhere, tells the recommender you like their posts (with Personalization on).
    await learnQuietly(learn(db, follower, [{ signal: 'follow', authorId: followee }]), app.log);
    await emitWebhook(db, followee, 'follower.new', { followerId: follower });
  }

  /** Unfollow, or take back a request you sent (the notification about it goes too). */
  app.delete('/v1/users/:id/follow', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const unfollowed = await db.query(`DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2`, [u.id, id]);
    if (unfollowed.rowCount) await learnQuietly(learn(db, u.id, [{ signal: 'unfollow', authorId: id }]), req.log);
    const took = await db.query(`DELETE FROM follow_requests WHERE follower_id = $1 AND followee_id = $2`, [u.id, id]);
    if (took.rowCount) await db.query(`DELETE FROM notifications WHERE user_id = $1 AND actor_id = $2 AND type = 'follow_request'`, [id, u.id]);
    return { following: false, requested: false };
  });

  /** People asking to follow you (your account is private), newest first. */
  app.get('/v1/me/follow-requests', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { rows } = await db.query(
      `SELECT fr.created_at AS requested_at, ${PUBLIC_USER_COLS} FROM follow_requests fr JOIN profiles pr ON pr.user_id = fr.follower_id
       JOIN users ux ON ux.id = fr.follower_id
       WHERE fr.followee_id = $1 AND ux.status = 'active' AND ux.deleted_at IS NULL AND ${notBlockedSql('fr.follower_id', '$1')}
       ORDER BY fr.created_at DESC LIMIT 500`,
      [u.id],
    );
    return { items: rows.map((r) => ({ user: toPublicUser(r as PublicUserRow), createdAt: new Date(r.requested_at).toISOString() })) };
  });

  /** Let someone who asked follow you. They're told; the request's notification becomes "started following you". */
  app.post('/v1/me/follow-requests/:id/accept', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const accepted = await tx(db, async (c) => {
      const r = await c.query(`DELETE FROM follow_requests WHERE follower_id = $1 AND followee_id = $2 RETURNING 1`, [id, u.id]);
      if (!r.rowCount) return false;
      await c.query(`INSERT INTO follows (follower_id, followee_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, u.id]);
      await c.query(
        `UPDATE notifications SET type = 'follow', read_at = coalesce(read_at, now()) WHERE user_id = $1 AND actor_id = $2 AND type = 'follow_request'`,
        [u.id, id],
      );
      return true;
    });
    if (!accepted) throw notFound('That request');
    await followed(id, u.id, 'follow_accepted');
    return { status: 'accepted' };
  });

  /** Say no to a request. They aren't told; they can ask again. */
  app.post('/v1/me/follow-requests/:id/decline', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const r = await db.query(`DELETE FROM follow_requests WHERE follower_id = $1 AND followee_id = $2`, [id, u.id]);
    if (!r.rowCount) throw notFound('That request');
    await db.query(`DELETE FROM notifications WHERE user_id = $1 AND actor_id = $2 AND type = 'follow_request'`, [u.id, id]);
    return { status: 'declined' };
  });

  /** Remove one of your followers. They aren't told. */
  app.delete('/v1/me/followers/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    await db.query(`DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2`, [id, me(req).id]);
    return { ok: true };
  });

  async function listUsers(sql: string, params: unknown[], cursor?: string, limit = 30) {
    const c = decodeCursor<{ o: number }>(cursor);
    const offset = c?.o ?? 0;
    const { rows } = await db.query<PublicUserRow>(`${sql} LIMIT ${limit + 1} OFFSET ${offset}`, params);
    const items = rows.slice(0, limit).map(toPublicUser);
    // Which of these people the viewer already follows, for the Follow buttons.
    const viewer = params[1] as string | null;
    const followed = viewer
      ? (await db.query(`SELECT followee_id FROM follows WHERE follower_id = $1 AND followee_id = ANY($2)`, [viewer, items.map((u) => u.id)])).rows.map(
          (r) => r.followee_id as string,
        )
      : [];
    return { items, viewerFollows: followed, nextCursor: rows.length > limit ? encodeCursor({ o: offset + limit }) : null };
  }

  /** A private account's followers and following are only visible to the account and the people it approved. */
  async function assertListsVisible(id: string, viewer: string | null) {
    const p = (await db.query(`SELECT is_private FROM profiles WHERE user_id = $1`, [id])).rows[0];
    if (!p) throw notFound('That person');
    if (viewer && (await isBlockedEitherWay(db, viewer, id))) throw notFound('That person');
    if (!p.is_private || viewer === id) return;
    // Approved: they follow it, or it accepted them as a friend.
    const follows = viewer ? await db.query(`SELECT 1 FROM follows WHERE follower_id = $1 AND followee_id = $2`, [viewer, id]) : null;
    if (!follows?.rowCount && !(viewer && (await areFriends(db, viewer, id)))) throw forbidden('This account is private.');
  }

  app.get('/v1/users/:id/followers', async (req) => {
    const { id } = parse(idParam, req.params);
    const q = parse(pageQuerySchema, req.query);
    await assertListsVisible(id, req.user?.id ?? null);
    return listUsers(
      `SELECT ${PUBLIC_USER_COLS} FROM follows f JOIN profiles pr ON pr.user_id = f.follower_id WHERE f.followee_id = $1 AND ${notBlockedSql('pr.user_id', '$2')} ORDER BY f.created_at DESC`,
      [id, req.user?.id ?? null],
      q.cursor,
      q.limit,
    );
  });

  app.get('/v1/users/:id/following', async (req) => {
    const { id } = parse(idParam, req.params);
    const q = parse(pageQuerySchema, req.query);
    await assertListsVisible(id, req.user?.id ?? null);
    return listUsers(
      `SELECT ${PUBLIC_USER_COLS} FROM follows f JOIN profiles pr ON pr.user_id = f.followee_id WHERE f.follower_id = $1 AND ${notBlockedSql('pr.user_id', '$2')} ORDER BY f.created_at DESC`,
      [id, req.user?.id ?? null],
      q.cursor,
      q.limit,
    );
  });

  app.get('/v1/users/:id/friends', async (req) => {
    const { id } = parse(idParam, req.params);
    const q = parse(pageQuerySchema, req.query);
    // Like followers and following: a private account's friends are for it and the people it approved.
    await assertListsVisible(id, req.user?.id ?? null);
    return listUsers(
      `SELECT ${PUBLIC_USER_COLS} FROM friendships fr JOIN profiles pr ON pr.user_id = CASE WHEN fr.user_a = $1 THEN fr.user_b ELSE fr.user_a END
       WHERE (fr.user_a = $1 OR fr.user_b = $1) AND ${notBlockedSql('pr.user_id', '$2')} ORDER BY fr.created_at DESC`,
      [id, req.user?.id ?? null],
      q.cursor,
      q.limit,
    );
  });

  // ── Friends ───────────────────────────────────────────────────────────
  app.post('/v1/users/:id/friend-request', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    if (id === u.id) throw badRequest("You can't add yourself.");
    if (await isBlockedEitherWay(db, u.id, id)) throw notFound('That profile');
    if (await areFriends(db, u.id, id)) return { status: 'friends' };
    // If they already asked us, accept instead.
    const reverse = await db.query<{ id: string }>(`SELECT id FROM friend_requests WHERE from_user_id = $1 AND to_user_id = $2 AND status = 'pending'`, [
      id,
      u.id,
    ]);
    if (reverse.rows[0]) return acceptRequest(reverse.rows[0].id, u.id);
    const r = await db.query<{ id: string }>(`INSERT INTO friend_requests (from_user_id, to_user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING id`, [
      u.id,
      id,
    ]);
    if (r.rows[0])
      await notify(db, ctx.realtime, {
        userId: id,
        category: 'friends',
        type: 'friend_request',
        actorId: u.id,
        entityType: 'friend_request',
        entityId: r.rows[0].id,
      });
    return { status: 'sent' };
  });

  async function acceptRequest(requestId: string, userId: string) {
    return tx(db, async (c) => {
      const { rows } = await c.query<{ from_user_id: string }>(
        `UPDATE friend_requests SET status = 'accepted', responded_at = now() WHERE id = $1 AND to_user_id = $2 AND status = 'pending' RETURNING from_user_id`,
        [requestId, userId],
      );
      if (!rows[0]) throw notFound('Friend request');
      const [a, b] = [rows[0].from_user_id, userId].sort();
      await c.query(`INSERT INTO friendships (user_a, user_b) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [a, b]);
      await notify(c, ctx.realtime, {
        userId: rows[0].from_user_id,
        category: 'friends',
        type: 'friend_accepted',
        actorId: userId,
        entityType: 'user',
        entityId: userId,
      });
      track(db, userId, 'friend_accepted');
      return { status: 'friends' };
    });
  }

  app.get('/v1/me/friend-requests', { preHandler: requireAuth }, async (req) => {
    const { rows } = await db.query(
      `SELECT fr.id AS request_id, fr.created_at AS requested_at, ${PUBLIC_USER_COLS} FROM friend_requests fr JOIN profiles pr ON pr.user_id = fr.from_user_id
       WHERE fr.to_user_id = $1 AND fr.status = 'pending' ORDER BY fr.created_at DESC LIMIT 200`,
      [me(req).id],
    );
    return { items: rows.map((r) => ({ id: r.request_id, createdAt: r.requested_at, from: toPublicUser(r as PublicUserRow) })) };
  });

  app.post('/v1/friend-requests/:id/accept', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    return acceptRequest(id, me(req).id);
  });

  app.post('/v1/friend-requests/:id/decline', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    const r = await db.query(`UPDATE friend_requests SET status = 'declined', responded_at = now() WHERE id = $1 AND to_user_id = $2 AND status = 'pending'`, [
      id,
      me(req).id,
    ]);
    if (!r.rowCount) throw notFound('Friend request');
    return { status: 'declined' };
  });

  app.delete('/v1/users/:id/friend', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const [a, b] = [u.id, id].sort();
    await db.query(`DELETE FROM friendships WHERE user_a = $1 AND user_b = $2`, [a, b]);
    await db.query(
      `UPDATE friend_requests SET status = 'cancelled' WHERE status = 'pending' AND ((from_user_id = $1 AND to_user_id = $2) OR (from_user_id = $2 AND to_user_id = $1))`,
      [u.id, id],
    );
    return { status: 'none' };
  });

  // ── Block, mute, restrict ─────────────────────────────────────────────
  app.post('/v1/users/:id/block', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    if (id === u.id) throw badRequest("You can't block yourself.");
    const stopped = await tx(db, (c) => blockUser(c, u.id, id));
    // Anyone sharing where they are with the other sees that it stopped.
    await publishShares({ db, realtime: ctx.realtime }, stopped);
    return { blocked: true };
  });

  app.delete('/v1/users/:id/block', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    await db.query(`DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2`, [me(req).id, id]);
    return { blocked: false };
  });

  app.get('/v1/me/blocked', { preHandler: requireAuth }, async (req) => {
    const { rows } = await db.query<PublicUserRow>(
      `SELECT ${PUBLIC_USER_COLS} FROM blocks b JOIN profiles pr ON pr.user_id = b.blocked_id WHERE b.blocker_id = $1 ORDER BY b.created_at DESC LIMIT 1000`,
      [me(req).id],
    );
    return { items: rows.map(toPublicUser) };
  });

  // People you muted or restricted, for Settings (each can be undone from there).
  for (const [path, table, a, b] of [
    ['muted', 'mutes', 'muter_id', 'muted_id'],
    ['restricted', 'restrictions', 'restrictor_id', 'restricted_id'],
  ] as const)
    app.get(`/v1/me/${path}`, { preHandler: requireAuth }, async (req) => {
      const { rows } = await db.query<PublicUserRow>(
        `SELECT ${PUBLIC_USER_COLS} FROM ${table} x JOIN profiles pr ON pr.user_id = x.${b} JOIN users u ON u.id = x.${b}
         WHERE x.${a} = $1 AND u.status = 'active' AND u.deleted_at IS NULL ORDER BY pr.display_name LIMIT 1000`,
        [me(req).id],
      );
      return { items: rows.map(toPublicUser) };
    });

  for (const [path, table, a, b] of [
    ['mute', 'mutes', 'muter_id', 'muted_id'],
    ['restrict', 'restrictions', 'restrictor_id', 'restricted_id'],
  ] as const) {
    app.post(`/v1/users/:id/${path}`, { preHandler: requireAuth }, async (req) => {
      const { id } = parse(idParam, req.params);
      if (id === me(req).id) throw badRequest(`You can't ${path} yourself.`);
      await db.query(`INSERT INTO ${table} (${a}, ${b}) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [me(req).id, id]);
      return { [path === 'mute' ? 'muted' : 'restricted']: true };
    });
    app.delete(`/v1/users/:id/${path}`, { preHandler: requireAuth }, async (req) => {
      const { id } = parse(idParam, req.params);
      await db.query(`DELETE FROM ${table} WHERE ${a} = $1 AND ${b} = $2`, [me(req).id, id]);
      return { [path === 'mute' ? 'muted' : 'restricted']: false };
    });
  }

  // ── Circles ───────────────────────────────────────────────────────────
  // Circles are private to their owner: nobody is told they were added or
  // removed, and nothing tells a member which circles they're in or what they're
  // called. Posts shared with a circle show its name to the author only.
  const circleOut = (r: Record<string, any>) => ({ id: r.id, name: r.name, kind: r.kind, memberCount: r.member_count ?? 0, createdAt: r.created_at });
  const CIRCLE_COLS = `c.id, c.name, c.kind, c.created_at,
    (SELECT count(*) FROM circle_members cm JOIN users mu ON mu.id = cm.user_id AND mu.status = 'active' WHERE cm.circle_id = c.id) AS member_count`;

  app.get('/v1/me/circles', { preHandler: requireAuth }, async (req) => {
    const { rows } = await db.query(`SELECT ${CIRCLE_COLS} FROM circles c WHERE c.owner_id = $1 ORDER BY c.created_at`, [me(req).id]);
    return { items: rows.map(circleOut) };
  });

  async function assertNameFree(ownerId: string, name: string, except: string | null) {
    const taken = await db.query(`SELECT 1 FROM circles WHERE owner_id = $1 AND lower(name) = lower($2) AND id IS DISTINCT FROM $3`, [ownerId, name, except]);
    if (taken.rowCount) throw conflict(`You already have a circle called "${name}".`);
  }

  app.post('/v1/me/circles', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    const input = parse(circleSchema, req.body);
    const count = await db.query(`SELECT count(*) AS n FROM circles WHERE owner_id = $1`, [u.id]);
    if (count.rows[0].n >= MAX_CIRCLES) throw conflict(`You can have up to ${MAX_CIRCLES} circles.`);
    await assertNameFree(u.id, input.name, null);
    const { rows } = await db.query(`INSERT INTO circles (owner_id, name, kind) VALUES ($1,$2,$3) RETURNING id, name, kind, created_at`, [
      u.id,
      input.name,
      input.kind,
    ]);
    reply.code(201);
    return { circle: circleOut(rows[0]) };
  });

  async function ownCircle(circleId: string, userId: string) {
    const r = await db.query(`SELECT ${CIRCLE_COLS} FROM circles c WHERE c.id = $1 AND c.owner_id = $2`, [circleId, userId]);
    if (!r.rows[0]) throw notFound('Circle');
    return r.rows[0];
  }

  app.get('/v1/me/circles/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    return { circle: circleOut(await ownCircle(id, me(req).id)) };
  });

  /** Rename a circle (or change its kind). Posts already shared with it stay with the same people. */
  app.patch('/v1/me/circles/:id', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(circleUpdateSchema, req.body);
    await ownCircle(id, u.id);
    if (input.name !== undefined) await assertNameFree(u.id, input.name, id);
    await db.query(`UPDATE circles SET name = coalesce($3, name), kind = coalesce($4, kind) WHERE id = $1 AND owner_id = $2`, [
      id,
      u.id,
      input.name ?? null,
      input.kind ?? null,
    ]);
    return { circle: circleOut(await ownCircle(id, u.id)) };
  });

  app.get('/v1/me/circles/:id/members', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    await ownCircle(id, u.id);
    const { rows } = await db.query<PublicUserRow>(
      `SELECT ${PUBLIC_USER_COLS} FROM circle_members cm JOIN profiles pr ON pr.user_id = cm.user_id JOIN users mu ON mu.id = cm.user_id
       WHERE cm.circle_id = $1 AND mu.status = 'active' AND ${notBlockedSql('cm.user_id', '$2')}
       ORDER BY cm.added_at DESC`,
      [id, u.id],
    );
    return { items: rows.map(toPublicUser) };
  });

  /**
   * Add people to a circle. Anyone active you haven't blocked (and who hasn't
   * blocked you) can be added; the apps suggest people you follow and friends.
   * People who can't be added are skipped. Nobody is told.
   */
  app.post('/v1/me/circles/:id/members', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { userIds } = parse(circleMembersSchema, req.body);
    await ownCircle(id, u.id);
    const added = await tx(db, async (c) => {
      await c.query(`SELECT 1 FROM circles WHERE id = $1 FOR UPDATE`, [id]);
      const r = await c.query(
        `INSERT INTO circle_members (circle_id, user_id)
         SELECT $1, x.id FROM users x WHERE x.id = ANY($2::uuid[]) AND x.id <> $3 AND x.status = 'active' AND ${notBlockedSql('x.id', '$3')}
         ON CONFLICT DO NOTHING`,
        [id, userIds, u.id],
      );
      const n = (await c.query(`SELECT count(*) AS n FROM circle_members WHERE circle_id = $1`, [id])).rows[0].n as number;
      if (n > MAX_CIRCLE_MEMBERS) throw badRequest(`A circle can have up to ${MAX_CIRCLE_MEMBERS} people.`);
      return r.rowCount ?? 0;
    });
    return { ok: true, added, circle: circleOut(await ownCircle(id, u.id)) };
  });

  app.delete('/v1/me/circles/:id/members/:userId', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id, userId } = parse(z.object({ id: z.string().uuid(), userId: z.string().uuid() }), req.params);
    await ownCircle(id, u.id);
    await db.query(`DELETE FROM circle_members WHERE circle_id = $1 AND user_id = $2`, [id, userId]);
    return { ok: true, circle: circleOut(await ownCircle(id, u.id)) };
  });

  /** Delete a circle. Posts shared with it stay, visible only to you. */
  app.delete('/v1/me/circles/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    await ownCircle(id, me(req).id);
    await db.query(`DELETE FROM circles WHERE id = $1`, [id]);
    return { ok: true };
  });
}
