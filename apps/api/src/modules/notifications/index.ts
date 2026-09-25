import { z } from 'zod';
import { forbidden, invalid, notFound } from '@yapilapi/shared';
import { route } from '../../lib/route.js';
import { audit } from '../../lib/audit.js';
import type { ApiModule } from '../types.js';
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  TEEN_QUIET_HOURS,
  UNDISABLEABLE,
} from '../../lib/notification-policy.js';
import {
  categoryOfKey,
  deleteNotification,
  isPreferenceKey,
  listNotifications,
  loadPreferences,
  markAllRead,
  markRead,
  unreadCounts,
} from './service.js';

export {
  shouldDeliver,
  decideDelivery,
  categoryFor,
  NOTIFICATION_CATEGORIES,
} from '../../lib/notification-policy.js';
export { sendEmailDigests } from './digest.js';
export { purgeOldNotifications, listNotifications, unreadCounts } from './service.js';

const idParams = z.object({ id: z.uuid() });
const category = z.enum(NOTIFICATION_CATEGORIES);
const minute = z.number().int().min(0).max(1439);
const MAX_TOKENS_PER_USER = 10;

const PLATFORMS = ['ios', 'android', 'web'] as const;
const PROVIDERS = ['expo', 'fcm', 'apns', 'webpush'] as const;

async function loadSettings(ctx: Parameters<ApiModule['register']>[1], userId: string) {
  const { rows } = await ctx.db.query(
    `SELECT COALESCE(up.timezone, u.timezone) AS timezone, up.quiet_hours_start, up.quiet_hours_end, COALESCE(up.focus_mode, false) AS focus_mode,
            up.notifications_paused_until, u.age_band
       FROM users u LEFT JOIN user_preferences up ON up.user_id = u.id WHERE u.id = $1`,
    [userId],
  );
  const r = rows[0]!;
  const custom = r.quiet_hours_start !== null && r.quiet_hours_end !== null;
  const pausedUntil: Date | null =
    r.notifications_paused_until && r.notifications_paused_until.getTime() > Date.now()
      ? r.notifications_paused_until
      : null;
  return {
    timezone: r.timezone as string,
    quietHours: custom
      ? { start: r.quiet_hours_start as number, end: r.quiet_hours_end as number, isDefault: false }
      : r.age_band === 'teen'
        ? { ...TEEN_QUIET_HOURS, isDefault: true }
        : null,
    focusMode: r.focus_mode as boolean,
    pausedUntil: pausedUntil?.toISOString() ?? null,
    urgentAlwaysDelivered: [...UNDISABLEABLE],
  };
}

export const notificationsModule: ApiModule = {
  name: 'notifications',
  register(app, ctx) {
    // ------------------------------------------------------------------ inbox
    route(app, ctx, {
      method: 'GET',
      url: '/v1/notifications',
      summary: 'My notifications (newest first, filter by category or unread)',
      tags: ['notifications'],
      auth: 'user',
      query: z.object({
        category: category.optional(),
        unread: z
          .enum(['true', 'false'])
          .transform((v) => v === 'true')
          .optional(),
        cursor: z.string().max(400).optional(),
        limit: z.coerce.number().int().min(1).max(50).optional(),
      }),
      handler: ({ auth, query }) => listNotifications(ctx, auth.userId, query),
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/notifications/unread-count',
      summary: 'Unread notifications, in total and per category',
      tags: ['notifications'],
      auth: 'user',
      handler: ({ auth }) => unreadCounts(ctx, auth.userId),
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/notifications/read-all',
      summary: 'Mark everything (or one category) as read',
      tags: ['notifications'],
      auth: 'user',
      body: z.object({ category: category.optional() }),
      rateLimit: { limit: 60, windowSec: 3600, by: 'user' },
      handler: async ({ auth, body }) => ({
        updated: await markAllRead(ctx, auth.userId, body.category),
      }),
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/notifications/:id/read',
      summary: 'Mark one notification as read',
      tags: ['notifications'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, params }) => {
        await markRead(ctx, auth.userId, params.id);
      },
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/notifications/:id',
      summary: 'Delete one notification',
      tags: ['notifications'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, params }) => {
        await deleteNotification(ctx, auth.userId, params.id);
      },
    });

    // ------------------------------------------------------------------ preferences
    route(app, ctx, {
      method: 'GET',
      url: '/v1/notifications/preferences',
      summary:
        'Notification channels per category, per-kind overrides, quiet hours, focus and pause',
      tags: ['notifications'],
      auth: 'user',
      handler: async ({ auth }) => ({
        ...(await loadPreferences(ctx, auth.userId)),
        settings: await loadSettings(ctx, auth.userId),
      }),
    });

    route(app, ctx, {
      method: 'PUT',
      url: '/v1/notifications/preferences',
      summary: 'Turn channels on or off for a category or a specific kind',
      tags: ['notifications'],
      auth: 'user',
      body: z.object({
        items: z
          .array(
            z.object({
              key: z.string().trim().min(1).max(60),
              channel: z.enum(NOTIFICATION_CHANNELS),
              enabled: z.boolean(),
            }),
          )
          .min(1)
          .max(50),
      }),
      rateLimit: { limit: 60, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, body }) => {
        for (const it of body.items) {
          if (!isPreferenceKey(it.key))
            throw invalid(`Unknown notification category or kind: ${it.key}`, { field: 'key' });
          const cat = categoryOfKey(it.key);
          if (it.channel === 'in_app' && !it.enabled && UNDISABLEABLE.has(cat)) {
            throw invalid(
              'Security and safety notices always appear in your notification list and cannot be turned off',
              { key: it.key, channel: it.channel },
            );
          }
          // Teens: no marketing-style email. Only security and safety notices may be emailed to under-18 accounts.
          if (
            auth.ageBand === 'teen' &&
            it.channel === 'email' &&
            it.enabled &&
            !UNDISABLEABLE.has(cat)
          ) {
            throw forbidden(
              'Email notifications other than security and safety notices are not available for accounts under 18',
            );
          }
        }
        // Later items for the same key/channel win.
        const dedup = new Map(body.items.map((i) => [`${i.key}\u0000${i.channel}`, i]));
        for (const i of dedup.values()) {
          await ctx.db.query(
            `INSERT INTO notification_preferences (user_id, kind, channel, enabled) VALUES ($1,$2,$3,$4)
             ON CONFLICT (user_id, kind, channel) DO UPDATE SET enabled = EXCLUDED.enabled`,
            [auth.userId, i.key, i.channel, i.enabled],
          );
        }
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'notifications.preferences_updated',
            metadata: { keys: [...new Set(body.items.map((i) => i.key))] },
          },
          req,
        );
        return {
          ...(await loadPreferences(ctx, auth.userId)),
          settings: await loadSettings(ctx, auth.userId),
        };
      },
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/notifications/preferences/:key',
      summary: 'Reset a category or kind to its defaults',
      tags: ['notifications'],
      auth: 'user',
      params: z.object({ key: z.string().trim().min(1).max(60) }),
      handler: async ({ auth, params }) => {
        if (!isPreferenceKey(params.key)) throw notFound('Preference');
        await ctx.db.query(
          'DELETE FROM notification_preferences WHERE user_id = $1 AND kind = $2',
          [auth.userId, params.key],
        );
      },
    });

    route(app, ctx, {
      method: 'PUT',
      url: '/v1/notifications/settings',
      summary: 'Quiet hours, focus mode and pausing notifications',
      tags: ['notifications'],
      auth: 'user',
      body: z.object({
        /** Minutes since local midnight; null clears the custom window (teens fall back to 22:00-07:00). */
        quietHours: z.object({ start: minute, end: minute }).nullable().optional(),
        focusMode: z.boolean().optional(),
        /** Pause push and email for this many minutes (max 30 days); null resumes now. */
        pauseForMinutes: z.number().int().min(1).max(43_200).nullable().optional(),
        timezone: z.string().trim().min(1).max(64).optional(),
      }),
      handler: async ({ auth, req, body }) => {
        if (body.timezone) {
          try {
            new Intl.DateTimeFormat('en', { timeZone: body.timezone });
          } catch {
            throw invalid('Unknown timezone', { field: 'timezone' });
          }
        }
        if (body.quietHours && body.quietHours.start === body.quietHours.end) {
          if (auth.ageBand === 'teen')
            throw forbidden(
              'Accounts under 18 keep quiet hours; choose a window instead of turning them off',
            );
          throw invalid('Quiet hours need a start and an end that differ (clear them with null)');
        }
        const setQuiet = body.quietHours !== undefined;
        const setPause = body.pauseForMinutes !== undefined;
        await ctx.db.query(
          `INSERT INTO user_preferences (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
          [auth.userId],
        );
        await ctx.db.query(
          `UPDATE user_preferences SET
             quiet_hours_start = CASE WHEN $2::boolean THEN $3::smallint ELSE quiet_hours_start END,
             quiet_hours_end   = CASE WHEN $2::boolean THEN $4::smallint ELSE quiet_hours_end END,
             focus_mode        = COALESCE($5, focus_mode),
             notifications_paused_until = CASE WHEN $6::boolean THEN CASE WHEN $7::int IS NULL THEN NULL ELSE now() + make_interval(mins => $7::int) END ELSE notifications_paused_until END,
             timezone          = COALESCE($8, timezone)
           WHERE user_id = $1`,
          [
            auth.userId,
            setQuiet,
            body.quietHours?.start ?? null,
            body.quietHours?.end ?? null,
            body.focusMode ?? null,
            setPause,
            body.pauseForMinutes ?? null,
            body.timezone ?? null,
          ],
        );
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'notifications.settings_updated',
            metadata: { fields: Object.keys(body) },
          },
          req,
        );
        return loadSettings(ctx, auth.userId);
      },
    });

    // ------------------------------------------------------------------ push tokens
    route(app, ctx, {
      method: 'POST',
      url: '/v1/notifications/push-tokens',
      summary:
        'Register this device for push notifications (idempotent; moves the token to the caller)',
      tags: ['notifications'],
      auth: 'user',
      body: z
        .object({
          token: z.string().trim().min(10).max(500),
          platform: z.enum(PLATFORMS),
          provider: z.enum(PROVIDERS).default('expo'),
          deviceId: z.uuid().optional(),
        })
        .refine((b) => b.provider !== 'expo' || /^Expo(nent)?PushToken\[[^\]]+\]$/.test(b.token), {
          message: 'Not a valid Expo push token',
          path: ['token'],
        }),
      rateLimit: { limit: 30, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, body, reply }) => {
        if (body.deviceId) {
          const d = await ctx.db.query('SELECT 1 FROM devices WHERE id = $1 AND user_id = $2', [
            body.deviceId,
            auth.userId,
          ]);
          if (!d.rowCount) throw invalid('Unknown device', { field: 'deviceId' });
        }
        // A token identifies a physical install: if someone else was signed in on it before, it now belongs to the caller.
        const { rows } = await ctx.db.query(
          `INSERT INTO push_tokens (user_id, device_id, platform, token, provider) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, device_id = EXCLUDED.device_id, platform = EXCLUDED.platform, provider = EXCLUDED.provider, disabled_at = NULL
           RETURNING id, (xmax = 0) AS created`,
          [auth.userId, body.deviceId ?? null, body.platform, body.token, body.provider],
        );
        // Keep the newest tokens only.
        await ctx.db.query(
          `DELETE FROM push_tokens WHERE user_id = $1 AND id IN (SELECT id FROM push_tokens WHERE user_id = $1 ORDER BY created_at DESC OFFSET $2)`,
          [auth.userId, MAX_TOKENS_PER_USER],
        );
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'notifications.push_token_registered',
            targetType: 'push_token',
            targetId: rows[0].id,
            metadata: { platform: body.platform, provider: body.provider },
          },
          req,
        );
        void reply.code(rows[0].created ? 201 : 200);
        return { id: rows[0].id };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/notifications/push-tokens',
      summary: 'My registered devices (tokens are masked)',
      tags: ['notifications'],
      auth: 'user',
      handler: async ({ auth }) => {
        const { rows } = await ctx.db.query(
          `SELECT id, platform, provider, created_at, last_used_at, disabled_at, right(token, 6) AS token_tail FROM push_tokens WHERE user_id = $1 ORDER BY created_at DESC`,
          [auth.userId],
        );
        return {
          items: rows.map((r) => ({
            id: r.id,
            platform: r.platform,
            provider: r.provider,
            tokenTail: r.token_tail,
            createdAt: r.created_at,
            lastUsedAt: r.last_used_at,
            active: r.disabled_at === null,
          })),
        };
      },
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/notifications/push-tokens',
      summary: 'Unregister a push token (e.g. on sign-out)',
      tags: ['notifications'],
      auth: 'user',
      body: z.object({ token: z.string().trim().min(10).max(500) }),
      handler: async ({ auth, body }) => {
        // Idempotent: unregistering something that is not there (or belongs to someone else) is a no-op, never an error oracle.
        await ctx.db.query('DELETE FROM push_tokens WHERE user_id = $1 AND token = $2', [
          auth.userId,
          body.token,
        ]);
      },
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/notifications/push-tokens/:id',
      summary: 'Remove a registered device',
      tags: ['notifications'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, params }) => {
        const r = await ctx.db.query('DELETE FROM push_tokens WHERE id = $1 AND user_id = $2', [
          params.id,
          auth.userId,
        ]);
        if (!r.rowCount) throw notFound('Device');
      },
    });
  },
};
