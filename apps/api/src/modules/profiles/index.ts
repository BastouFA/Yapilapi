import { z } from 'zod';
import {
  RESERVED_USERNAMES,
  PROFILE_MODES,
  conflict,
  invalid,
  usernameSchema,
} from '@yapilapi/shared';
import { withTransaction } from '@yapilapi/database';
import { route } from '../../lib/route.js';
import { resolveUser } from '../../lib/users.js';
import type { ApiModule } from '../types.js';

const usernameParams = z.object({ username: z.string().min(1).max(40) });

const linkSchema = z.object({
  label: z.string().trim().min(1).max(40),
  url: z.url({ protocol: /^https?$/ }).max(300),
});

const updateProfileBody = z
  .object({
    displayName: z.string().trim().min(1).max(60),
    bio: z.string().max(300),
    links: z.array(linkSchema).max(5),
    locationText: z.string().trim().max(80).nullable(),
    mode: z.enum(PROFILE_MODES),
    isPrivate: z.boolean(),
    avatarUrl: z
      .url({ protocol: /^https?$/ })
      .max(500)
      .nullable(),
    coverUrl: z
      .url({ protocol: /^https?$/ })
      .max(500)
      .nullable(),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update');

const interestsBody = z.object({ topics: z.array(z.string().min(1).max(50)).max(30) });

const preferencesBody = z
  .object({
    locale: z.string().min(2).max(10),
    timezone: z.string().min(1).max(64),
    currency: z.string().length(3).toUpperCase(),
    theme: z.enum(['system', 'light', 'dark']),
    reducedMotion: z.boolean(),
    lowBandwidth: z.boolean(),
    dailyLimitMinutes: z.number().int().min(5).max(1440).nullable(),
    quietHoursStart: z.number().int().min(0).max(1439).nullable(),
    quietHoursEnd: z.number().int().min(0).max(1439).nullable(),
    focusMode: z.boolean(),
    sensitiveContent: z.enum(['hide', 'limit', 'allow']),
    defaultPostVisibility: z.enum(['public', 'followers', 'friends', 'private']),
    whoCanMessage: z.enum(['everyone', 'followers', 'friends', 'nobody']),
    discoverable: z.boolean(),
    personalization: z.boolean(),
  })
  .partial();

const PREF_COLUMNS: Record<string, string> = {
  locale: 'locale',
  timezone: 'timezone',
  currency: 'currency',
  theme: 'theme',
  reducedMotion: 'reduced_motion',
  lowBandwidth: 'low_bandwidth',
  dailyLimitMinutes: 'daily_limit_minutes',
  quietHoursStart: 'quiet_hours_start',
  quietHoursEnd: 'quiet_hours_end',
  focusMode: 'focus_mode',
  sensitiveContent: 'sensitive_content',
  defaultPostVisibility: 'default_post_visibility',
  whoCanMessage: 'who_can_message',
  discoverable: 'discoverable',
  personalization: 'personalization',
};

export const profilesModule: ApiModule = {
  name: 'profiles',
  register(app, ctx) {
    route(app, ctx, {
      method: 'GET',
      url: '/v1/users/:username',
      summary: 'View a profile',
      tags: ['profiles'],
      auth: 'optional',
      params: usernameParams,
      handler: async ({ auth, params }) => {
        const viewerId = auth?.userId ?? null;
        const target = await resolveUser(ctx, viewerId, params.username);
        const { rows } = await ctx.db.query(
          `SELECT user_id, username, display_name, bio, avatar_url, cover_url, mode, links, location_text, is_private,
                  follower_count, following_count, friend_count, created_at
             FROM profiles WHERE user_id = $1`,
          [target.id],
        );
        const p = rows[0]!;
        const isSelf = viewerId === target.id;
        let rel = {
          following: 'none',
          followedBy: false,
          friendship: 'none',
          muted: false,
          restricted: false,
        };
        if (viewerId && !isSelf) {
          const q = await ctx.db.query(
            `SELECT
               (SELECT status FROM follows WHERE follower_id = $1 AND followee_id = $2) AS following,
               EXISTS (SELECT 1 FROM follows WHERE follower_id = $2 AND followee_id = $1 AND status = 'active') AS followed_by,
               (SELECT row(status, requester_id = $1)::text FROM friendships WHERE user_low = LEAST($1::uuid,$2::uuid) AND user_high = GREATEST($1::uuid,$2::uuid)) AS friendship,
               EXISTS (SELECT 1 FROM user_mutes WHERE muter_id = $1 AND muted_id = $2) AS muted,
               EXISTS (SELECT 1 FROM user_restrictions WHERE restrictor_id = $1 AND restricted_id = $2) AS restricted`,
            [viewerId, target.id],
          );
          const r = q.rows[0]!;
          let friendship = 'none';
          if (r.friendship)
            friendship =
              r.friendship === '(accepted,t)' || r.friendship === '(accepted,f)'
                ? 'friends'
                : r.friendship === '(pending,t)'
                  ? 'pending_out'
                  : 'pending_in';
          rel = {
            following: r.following ?? 'none',
            followedBy: r.followed_by,
            friendship,
            muted: r.muted,
            restricted: r.restricted,
          };
        }
        const contentHidden = p.is_private && !isSelf && rel.following !== 'active';
        return {
          id: p.user_id,
          username: p.username,
          displayName: p.display_name,
          bio: p.bio,
          avatarUrl: p.avatar_url,
          coverUrl: p.cover_url,
          mode: p.mode,
          links: contentHidden ? [] : p.links,
          locationText: contentHidden ? null : p.location_text,
          isPrivate: p.is_private,
          counts: {
            followers: p.follower_count,
            following: p.following_count,
            friends: p.friend_count,
          },
          joinedAt: (p.created_at as Date).toISOString(),
          contentHidden,
          viewer: { isSelf, ...rel },
        };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/usernames/:username/available',
      summary: 'Check whether a username is available',
      tags: ['profiles'],
      auth: 'public',
      params: usernameParams,
      rateLimit: { limit: 60, windowSec: 60 },
      handler: async ({ params }) => {
        const parsed = usernameSchema.safeParse(params.username);
        if (!parsed.success) return { available: false, reason: 'invalid' };
        if (RESERVED_USERNAMES.has(parsed.data)) return { available: false, reason: 'reserved' };
        const { rowCount } = await ctx.db.query('SELECT 1 FROM profiles WHERE username = $1', [
          parsed.data,
        ]);
        return rowCount ? { available: false, reason: 'taken' } : { available: true };
      },
    });

    route(app, ctx, {
      method: 'PATCH',
      url: '/v1/profile',
      summary: 'Update your profile',
      tags: ['profiles'],
      auth: 'user',
      body: updateProfileBody,
      rateLimit: { limit: 30, windowSec: 600, by: 'user' },
      handler: async ({ auth, body }) => {
        const sets: string[] = [];
        const values: unknown[] = [auth.userId];
        const add = (col: string, v: unknown) => {
          values.push(v);
          sets.push(`${col} = $${values.length}`);
        };
        if (body.displayName !== undefined) add('display_name', body.displayName);
        if (body.bio !== undefined) add('bio', body.bio);
        if (body.links !== undefined) add('links', JSON.stringify(body.links));
        if (body.locationText !== undefined) add('location_text', body.locationText);
        if (body.mode !== undefined) add('mode', body.mode);
        if (body.isPrivate !== undefined) {
          // Teens cannot make their account public via this endpoint.
          if (body.isPrivate === false && auth.ageBand === 'teen')
            throw invalid('Accounts for people under 18 are private');
          add('is_private', body.isPrivate);
        }
        if (body.avatarUrl !== undefined) add('avatar_url', body.avatarUrl);
        if (body.coverUrl !== undefined) add('cover_url', body.coverUrl);
        await withTransaction(ctx.db, async (tx) => {
          await tx.query(`UPDATE profiles SET ${sets.join(', ')} WHERE user_id = $1`, values);
          // Going public releases any pending follow requests.
          if (body.isPrivate === false) {
            const rel = await tx.query(
              `UPDATE follows SET status = 'active' WHERE followee_id = $1 AND status = 'pending' RETURNING follower_id`,
              [auth.userId],
            );
            if (rel.rowCount) {
              await tx.query(
                `UPDATE profiles SET follower_count = follower_count + $2 WHERE user_id = $1`,
                [auth.userId, rel.rowCount],
              );
              await tx.query(
                `UPDATE profiles SET following_count = following_count + 1 WHERE user_id = ANY($1::uuid[])`,
                [rel.rows.map((r) => r.follower_id)],
              );
            }
          }
        });
        return { updated: true };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/topics',
      summary: 'List interest topics',
      tags: ['profiles'],
      auth: 'public',
      handler: async () => {
        const { rows } = await ctx.db.query('SELECT slug, name FROM topics ORDER BY name');
        return { items: rows };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/profile/interests',
      summary: 'Your selected interests',
      tags: ['profiles'],
      auth: 'user',
      handler: async ({ auth }) => {
        const { rows } = await ctx.db.query(
          `SELECT t.slug, t.name FROM user_interests ui JOIN topics t ON t.id = ui.topic_id WHERE ui.user_id = $1 ORDER BY t.name`,
          [auth.userId],
        );
        return { items: rows };
      },
    });

    route(app, ctx, {
      method: 'PUT',
      url: '/v1/profile/interests',
      summary: 'Replace your explicit interests',
      tags: ['profiles'],
      auth: 'user',
      body: interestsBody,
      handler: async ({ auth, body }) => {
        const slugs = [...new Set(body.topics.map((s) => s.toLowerCase()))];
        const { rows } = await ctx.db.query<{ id: string }>(
          'SELECT id FROM topics WHERE slug = ANY($1::citext[])',
          [slugs],
        );
        if (rows.length !== slugs.length) throw invalid('One or more topics do not exist');
        await withTransaction(ctx.db, async (tx) => {
          await tx.query(`DELETE FROM user_interests WHERE user_id = $1 AND source = 'explicit'`, [
            auth.userId,
          ]);
          if (rows.length) {
            await tx.query(
              `INSERT INTO user_interests (user_id, topic_id, source) SELECT $1, unnest($2::uuid[]), 'explicit' ON CONFLICT (user_id, topic_id) DO UPDATE SET source = 'explicit'`,
              [auth.userId, rows.map((r) => r.id)],
            );
          }
        });
        return { count: rows.length };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/profile/onboarding/complete',
      summary: 'Mark onboarding complete',
      tags: ['profiles'],
      auth: 'user',
      handler: async ({ auth }) => {
        await ctx.db.query(
          `UPDATE profiles SET onboarding_completed_at = COALESCE(onboarding_completed_at, now()) WHERE user_id = $1`,
          [auth.userId],
        );
        return { completed: true };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/settings/preferences',
      summary: 'Your preferences and attention controls',
      tags: ['settings'],
      auth: 'user',
      handler: async ({ auth }) => {
        const { rows } = await ctx.db.query('SELECT * FROM user_preferences WHERE user_id = $1', [
          auth.userId,
        ]);
        const r = rows[0]!;
        const out: Record<string, unknown> = {};
        for (const [k, col] of Object.entries(PREF_COLUMNS)) out[k] = r[col];
        return out;
      },
    });

    route(app, ctx, {
      method: 'PATCH',
      url: '/v1/settings/preferences',
      summary: 'Update preferences and attention controls',
      tags: ['settings'],
      auth: 'user',
      body: preferencesBody,
      handler: async ({ auth, body }) => {
        const entries = Object.entries(body).filter(([, v]) => v !== undefined);
        if (!entries.length) throw invalid('Nothing to update');
        // Teens keep the stricter messaging and discoverability settings.
        if (auth.ageBand === 'teen') {
          if (body.discoverable === true)
            throw conflict('Discoverability cannot be enabled for accounts under 18');
          if (body.whoCanMessage === 'everyone' || body.whoCanMessage === 'followers')
            throw conflict('Accounts under 18 can only receive messages from friends');
          if (body.defaultPostVisibility === 'public')
            throw conflict('Accounts under 18 cannot post publicly by default');
        }
        const values: unknown[] = [auth.userId];
        const sets = entries.map(([k, v]) => {
          values.push(v);
          return `${PREF_COLUMNS[k]} = $${values.length}`;
        });
        await ctx.db.query(
          `UPDATE user_preferences SET ${sets.join(', ')} WHERE user_id = $1`,
          values,
        );
        return { updated: true };
      },
    });
  },
};
