import { z } from 'zod';
import { AppError, forbidden, invalid } from '@yapilapi/shared';
import { route } from '../../lib/route.js';
import { audit } from '../../lib/audit.js';
import type { ApiModule } from '../types.js';
import { verifyUserPassword } from '../auth/service.js';
import {
  CONSENT_PURPOSES,
  PURPOSE_INFO,
  consentHistory,
  hasConsent,
  listConsents,
  setConsent,
} from './consent.js';
import {
  consumeDownload,
  createDownloadLink,
  listPrivacyRequests,
  purgeExpiredExports,
  requestExport,
} from './export.js';
import { registerPrivacyHooks } from './deletion.js';
import { registerCoreExportSections } from './sections.js';
import { getExportSections } from './registry.js';
import { listConnectedApps, revokeConnectedApp } from '../developer/oauth.js';

export { hasConsent, setConsent, CONSENT_PURPOSES } from './consent.js';
export type { ConsentPurpose } from './consent.js';
export { finalizeDueDeletions } from './deletion.js';
export { registerExportSection } from './registry.js';
export { buildExport, purgeExpiredExports, requestExport } from './export.js';

const idParams = z.object({ id: z.uuid() });

export const privacyModule: ApiModule = {
  name: 'privacy',
  register(app, ctx) {
    registerPrivacyHooks();
    registerCoreExportSections();

    // ------------------------------------------------------------------ overview
    route(app, ctx, {
      method: 'GET',
      url: '/v1/privacy/overview',
      summary: 'What data YAPILAPI holds about you: categories, counts, retention',
      tags: ['privacy'],
      auth: 'user',
      handler: async ({ auth }) => {
        const u = auth.userId;
        const { rows } = await ctx.db.query<Record<string, number>>(
          `SELECT
             (SELECT count(*)::int FROM posts WHERE author_id = $1 AND deleted_at IS NULL) AS posts,
             (SELECT count(*)::int FROM comments WHERE author_id = $1 AND deleted_at IS NULL) AS comments,
             (SELECT count(*)::int FROM reactions WHERE user_id = $1) AS reactions,
             (SELECT count(*)::int FROM saves WHERE user_id = $1) AS saves,
             (SELECT count(*)::int FROM messages WHERE sender_id = $1 AND deleted_at IS NULL) AS messages_sent,
             (SELECT count(*)::int FROM moments WHERE author_id = $1 AND deleted_at IS NULL) AS moments,
             (SELECT count(*)::int FROM media WHERE owner_id = $1 AND deleted_at IS NULL) AS media,
             (SELECT count(*)::int FROM follows WHERE follower_id = $1) AS following,
             (SELECT count(*)::int FROM friendships WHERE (user_low = $1 OR user_high = $1) AND status = 'accepted') AS friends,
             (SELECT count(*)::int FROM circles WHERE owner_id = $1) AS circles,
             (SELECT count(*)::int FROM orders WHERE buyer_id = $1) AS orders,
             (SELECT count(*)::int FROM event_attendees WHERE user_id = $1) AS event_rsvps,
             (SELECT count(*)::int FROM community_members WHERE user_id = $1 AND status = 'active') AS communities,
             (SELECT count(*)::int FROM notifications WHERE user_id = $1) AS notifications,
             (SELECT count(*)::int FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()) AS active_sessions,
             (SELECT count(*)::int FROM devices WHERE user_id = $1 AND revoked_at IS NULL) AS devices,
             (SELECT count(*)::int FROM security_events WHERE user_id = $1) AS security_events,
             (SELECT count(*)::int FROM consents WHERE user_id = $1) AS consent_records,
             (SELECT count(*)::int FROM ai_memories WHERE user_id = $1) AS ai_memories,
             (SELECT count(*)::int FROM ai_conversations WHERE user_id = $1) AS ai_conversations,
             (SELECT count(*)::int FROM analytics_events WHERE user_id = $1) AS analytics_events,
             (SELECT count(*)::int FROM oauth_grants WHERE user_id = $1 AND revoked_at IS NULL) AS connected_apps`,
          [u],
        );
        const c = rows[0]!;
        const consents = await listConsents(ctx, u);
        return {
          categories: [
            {
              key: 'account',
              label: 'Account and profile',
              items: 1,
              purpose: 'Running your account',
              retention: 'Until you delete your account (14-day grace period, then anonymised)',
            },
            {
              key: 'content',
              label: 'Posts, comments, reactions and saves',
              items: c.posts! + c.comments! + c.reactions! + c.saves!,
              detail: {
                posts: c.posts,
                comments: c.comments,
                reactions: c.reactions,
                saves: c.saves,
              },
              purpose: 'Showing your content to the audience you choose',
              retention: 'Until you delete it or your account',
            },
            {
              key: 'messages',
              label: 'Messages you sent',
              items: c.messages_sent,
              purpose: 'Delivering conversations',
              retention: 'Until you delete them or your account (blanked for other participants)',
            },
            {
              key: 'moments',
              label: 'Moments and media',
              items: c.moments! + c.media!,
              detail: { moments: c.moments, media: c.media },
              purpose: 'Sharing photos, video and temporary content',
              retention: 'Moments expire as you set; media until deleted',
            },
            {
              key: 'connections',
              label: 'Connections',
              items: c.following! + c.friends! + c.circles!,
              detail: { following: c.following, friends: c.friends, circles: c.circles },
              purpose: 'Your social graph and audience controls',
              retention: 'Until removed or account deletion',
            },
            {
              key: 'commerce',
              label: 'Orders, bookings and events',
              items: c.orders! + c.event_rsvps!,
              detail: { orders: c.orders, eventRsvps: c.event_rsvps },
              purpose: 'Fulfilling purchases and RSVPs',
              retention:
                'Financial records are kept as required by law; your address is erased on account deletion',
            },
            {
              key: 'communities',
              label: 'Community memberships',
              items: c.communities,
              purpose: 'Access to communities',
              retention: 'Until you leave or delete your account',
            },
            {
              key: 'notifications',
              label: 'Notifications',
              items: c.notifications,
              purpose: 'Telling you what happened',
              retention: 'Until you delete them or your account',
            },
            {
              key: 'security',
              label: 'Sessions, devices and security events',
              items: c.active_sessions! + c.devices! + c.security_events!,
              detail: {
                activeSessions: c.active_sessions,
                devices: c.devices,
                securityEvents: c.security_events,
              },
              purpose: 'Keeping your account secure',
              retention: 'Sessions expire; security events until account deletion',
            },
            {
              key: 'ai',
              label: 'AI memory and conversations',
              items: c.ai_memories! + c.ai_conversations!,
              detail: { memories: c.ai_memories, conversations: c.ai_conversations },
              purpose: 'AI features you switched on',
              retention: 'Until you delete them or withdraw consent and delete your data',
            },
            {
              key: 'analytics',
              label: 'Analytics events',
              items: c.analytics_events,
              purpose: 'Improving the product (only with your consent)',
              retention: `${ctx.config.ANALYTICS_RETENTION_DAYS} days`,
            },
            {
              key: 'consents',
              label: 'Consent records',
              items: c.consent_records,
              purpose: 'Proof of your choices',
              retention: 'Kept as evidence (append-only)',
            },
          ],
          connectedApps: c.connected_apps,
          consents: consents.map((x) => ({ purpose: x.purpose, granted: x.granted })),
          exportSections: getExportSections().map((s) => ({
            key: s.key,
            description: s.description,
          })),
          retainedAfterDeletion: [
            'Financial records (orders, payments, ledger) as required by law, without your address',
            'Safety records (reports, moderation decisions, appeals) for the protection of others',
            'Audit logs and consent evidence, which contain only pseudonymous ids',
          ],
          rights: {
            export: '/v1/privacy/export',
            delete: '/v1/account/deletion',
            consents: '/v1/privacy/consents',
          },
        };
      },
    });

    // ------------------------------------------------------------------ consents
    route(app, ctx, {
      method: 'GET',
      url: '/v1/privacy/consents',
      summary: 'Your consent choices (latest decision per purpose)',
      tags: ['privacy'],
      auth: 'user',
      handler: async ({ auth }) => ({ items: await listConsents(ctx, auth.userId) }),
    });
    route(app, ctx, {
      method: 'PUT',
      url: '/v1/privacy/consents/:purpose',
      summary: 'Grant or withdraw consent for a purpose (append-only history)',
      tags: ['privacy'],
      auth: 'user',
      params: z.object({ purpose: z.enum(CONSENT_PURPOSES) }),
      body: z.object({ granted: z.boolean() }),
      rateLimit: { limit: 60, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, params, body }) => {
        const r = await setConsent(ctx, auth.userId, params.purpose, body.granted, {
          source: 'user',
        });
        if (r.changed)
          await audit(
            ctx,
            {
              actorId: auth.userId,
              action: body.granted ? 'consent.granted' : 'consent.withdrawn',
              targetType: 'consent',
              targetId: params.purpose,
            },
            req,
          );
        return { ...r, label: PURPOSE_INFO[params.purpose].label };
      },
    });
    route(app, ctx, {
      method: 'GET',
      url: '/v1/privacy/consents/history',
      summary: 'Your full consent history (never edited, only appended)',
      tags: ['privacy'],
      auth: 'user',
      query: z.object({ purpose: z.string().max(40).optional() }),
      handler: async ({ auth, query }) => ({
        items: await consentHistory(ctx, auth.userId, query.purpose),
      }),
    });

    // ------------------------------------------------------------------ advertising
    route(app, ctx, {
      method: 'GET',
      url: '/v1/privacy/advertising',
      summary: 'Advertising preferences',
      tags: ['privacy'],
      auth: 'user',
      handler: async ({ auth }) => {
        const { rows } = await ctx.db.query<{ hidden_topics: string[]; limit_sensitive: boolean }>(
          'SELECT hidden_topics, limit_sensitive FROM ad_preferences WHERE user_id = $1',
          [auth.userId],
        );
        return {
          personalizedAds: await hasConsent(ctx, auth.userId, 'advertising'),
          hiddenTopics: rows[0]?.hidden_topics ?? [],
          limitSensitive: rows[0]?.limit_sensitive ?? true,
          availableToYou: auth.ageBand === 'adult',
        };
      },
    });
    route(app, ctx, {
      method: 'PUT',
      url: '/v1/privacy/advertising',
      summary: 'Update advertising preferences (personalised ads are never available to under-18s)',
      tags: ['privacy'],
      auth: 'user',
      body: z.object({
        personalizedAds: z.boolean().optional(),
        hiddenTopics: z.array(z.string().trim().min(1).max(50)).max(50).optional(),
        limitSensitive: z.boolean().optional(),
      }),
      handler: async ({ auth, req, body }) => {
        if (body.personalizedAds !== undefined)
          await setConsent(ctx, auth.userId, 'advertising', body.personalizedAds);
        if (body.hiddenTopics !== undefined || body.limitSensitive !== undefined) {
          if (auth.ageBand === 'teen' && body.limitSensitive === false)
            throw forbidden('Sensitive-ad limits cannot be lowered for accounts under 18');
          await ctx.db.query(
            `INSERT INTO ad_preferences (user_id, hidden_topics, limit_sensitive) VALUES ($1, COALESCE($2::text[], '{}'), COALESCE($3, true))
             ON CONFLICT (user_id) DO UPDATE SET hidden_topics = COALESCE($2::text[], ad_preferences.hidden_topics), limit_sensitive = COALESCE($3, ad_preferences.limit_sensitive)`,
            [
              auth.userId,
              body.hiddenTopics
                ? [...new Set(body.hiddenTopics.map((t) => t.toLowerCase()))]
                : null,
              body.limitSensitive ?? null,
            ],
          );
        }
        await audit(ctx, { actorId: auth.userId, action: 'privacy.advertising_updated' }, req);
        const { rows } = await ctx.db.query<{ hidden_topics: string[]; limit_sensitive: boolean }>(
          'SELECT hidden_topics, limit_sensitive FROM ad_preferences WHERE user_id = $1',
          [auth.userId],
        );
        return {
          personalizedAds: await hasConsent(ctx, auth.userId, 'advertising'),
          hiddenTopics: rows[0]?.hidden_topics ?? [],
          limitSensitive: rows[0]?.limit_sensitive ?? true,
        };
      },
    });

    // ------------------------------------------------------------------ visibility overview
    route(app, ctx, {
      method: 'GET',
      url: '/v1/privacy/visibility',
      summary: 'Who can see what: profile, defaults and your content by audience',
      tags: ['privacy'],
      auth: 'user',
      handler: async ({ auth }) => {
        const u = auth.userId;
        const [prof, posts, moments, counts] = await Promise.all([
          ctx.db.query(
            `SELECT p.is_private, up.discoverable, up.default_post_visibility, up.who_can_message, up.personalization, up.sensitive_content FROM profiles p LEFT JOIN user_preferences up ON up.user_id = p.user_id WHERE p.user_id = $1`,
            [u],
          ),
          ctx.db.query<{ visibility: string; n: number }>(
            `SELECT visibility, count(*)::int AS n FROM posts WHERE author_id = $1 AND deleted_at IS NULL GROUP BY visibility`,
            [u],
          ),
          ctx.db.query<{ visibility: string; n: number }>(
            `SELECT visibility, count(*)::int AS n FROM moments WHERE author_id = $1 AND deleted_at IS NULL GROUP BY visibility`,
            [u],
          ),
          ctx.db.query<Record<string, number>>(
            `SELECT (SELECT count(*)::int FROM user_blocks WHERE blocker_id = $1) AS blocked, (SELECT count(*)::int FROM user_mutes WHERE muter_id = $1) AS muted,
                    (SELECT count(*)::int FROM user_restrictions WHERE restrictor_id = $1) AS restricted, (SELECT count(*)::int FROM circles WHERE owner_id = $1) AS circles,
                    (SELECT count(*)::int FROM oauth_grants WHERE user_id = $1 AND revoked_at IS NULL) AS connected_apps,
                    (SELECT count(*)::int FROM guardian_links WHERE minor_id = $1 AND status = 'active') AS guardians`,
            [u],
          ),
        ]);
        const p = prof.rows[0] ?? {};
        return {
          profile: {
            private: p.is_private ?? false,
            discoverable: p.discoverable ?? true,
            whoCanMessage: p.who_can_message ?? 'everyone',
          },
          defaults: {
            postVisibility: p.default_post_visibility ?? 'public',
            sensitiveContent: p.sensitive_content ?? 'limit',
            personalization: p.personalization ?? true,
          },
          postsByVisibility: Object.fromEntries(posts.rows.map((r) => [r.visibility, r.n])),
          momentsByVisibility: Object.fromEntries(moments.rows.map((r) => [r.visibility, r.n])),
          controls: counts.rows[0],
        };
      },
    });

    // ------------------------------------------------------------------ export
    route(app, ctx, {
      method: 'POST',
      url: '/v1/privacy/export',
      summary: 'Request a machine-readable export of your data (1 per day; password required)',
      tags: ['privacy'],
      auth: 'user',
      body: z.object({ password: z.string().min(1).max(200).optional() }),
      rateLimit: { limit: 5, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, body, reply }) => {
        // Re-authenticate: an export contains everything, so a hijacked session must not be enough.
        const hasPw = await ctx.db.query<{ has: boolean }>(
          'SELECT password_hash IS NOT NULL AS has FROM users WHERE id = $1',
          [auth.userId],
        );
        if (hasPw.rows[0]?.has) {
          if (!body.password) throw invalid('Confirm your password to export your data');
          if (!(await verifyUserPassword(ctx, auth.userId, body.password)))
            throw new AppError('unauthenticated', 'Password is incorrect');
        }
        const r = await requestExport(ctx, auth.userId);
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'privacy.export_requested',
            targetType: 'privacy_request',
            targetId: r.requestId,
            metadata: { sizeBytes: r.sizeBytes },
          },
          req,
        );
        void reply.code(202);
        return { ...r, next: `/v1/privacy/requests/${r.requestId}/download-link` };
      },
    });
    route(app, ctx, {
      method: 'GET',
      url: '/v1/privacy/requests',
      summary: 'Your privacy requests (exports, deletion)',
      tags: ['privacy'],
      auth: 'user',
      handler: async ({ auth }) => ({ items: await listPrivacyRequests(ctx, auth.userId) }),
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/privacy/requests/:id/download-link',
      summary: 'Mint a short-lived single-use download link for a finished export',
      tags: ['privacy'],
      auth: 'user',
      params: idParams,
      rateLimit: { limit: 20, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, params }) => {
        const l = await createDownloadLink(ctx, auth.userId, params.id);
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'privacy.export_link_created',
            targetType: 'privacy_request',
            targetId: params.id,
          },
          req,
        );
        return l;
      },
    });
    route(app, ctx, {
      method: 'GET',
      url: '/v1/privacy/requests/:id/download',
      summary: 'Download an export (owner session + link token)',
      tags: ['privacy'],
      auth: 'user',
      params: idParams,
      query: z.object({ token: z.string().min(20).max(100) }),
      rateLimit: { limit: 20, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, reply, params, query }) => {
        const d = await consumeDownload(ctx, auth.userId, params.id, query.token);
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'privacy.export_downloaded',
            targetType: 'privacy_request',
            targetId: params.id,
          },
          req,
        );
        void reply.header('content-type', 'application/json; charset=utf-8');
        void reply.header('content-disposition', `attachment; filename="${d.filename}"`);
        void reply.header('cache-control', 'no-store');
        void reply.header('x-content-sha256', d.sha256);
        return reply.send(d.body);
      },
    });

    // ------------------------------------------------------------------ connected applications
    route(app, ctx, {
      method: 'GET',
      url: '/v1/privacy/connected-apps',
      summary: 'Applications you have authorised',
      tags: ['privacy'],
      auth: 'user',
      handler: async ({ auth }) => ({ items: await listConnectedApps(ctx, auth.userId) }),
    });
    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/privacy/connected-apps/:id',
      summary: "Revoke an application's access",
      tags: ['privacy'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, req, params }) => {
        await revokeConnectedApp(ctx, auth.userId, params.id, req);
      },
    });

    void purgeExpiredExports;
  },
};
