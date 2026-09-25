import { z } from 'zod';
import { NOTIFICATION_CATEGORIES } from '../../lib/notification-policy.js';

/**
 * THE analytics allowlist. Nothing is stored unless its name is listed here and its properties validate against a
 * STRICT schema (unknown keys are rejected, not stripped, so a client bug can never smuggle extra data in).
 *
 * Design rules that keep this privacy-preserving by construction:
 *  - Property values are enums, booleans or bounded numbers. There is deliberately no free-text property anywhere, so
 *    search queries, message text, names, urls or ids cannot be sent by accident.
 *  - Clients may only send CLIENT_EVENTS. SERVER_EVENTS are recorded by our own code (`track`), so a client cannot
 *    forge a funnel number such as "post_created".
 *  - Timestamps are set by the server; clients cannot backdate events.
 */

const SCREENS = [
  'home',
  'feed',
  'search',
  'profile',
  'messages',
  'conversation',
  'notifications',
  'settings',
  'post',
  'event',
  'community',
  'place',
  'marketplace',
  'checkout',
  'creator_studio',
  'business',
  'moments',
  'discover',
  'onboarding',
  'safety',
  'privacy',
] as const;
const screen = z.enum(SCREENS);
const num = (max: number) => z.number().finite().min(0).max(max);

export const CLIENT_EVENTS = {
  screen_view: z.strictObject({ screen }),
  app_open: z.strictObject({
    referrer_kind: z.enum(['direct', 'search', 'share', 'push', 'email', 'other']),
  }),
  onboarding_step: z.strictObject({
    step: z.enum(['profile', 'interests', 'follow_suggestions', 'notifications', 'finish']),
    action: z.enum(['viewed', 'completed', 'skipped']),
  }),
  search_performed: z.strictObject({
    surface: z.enum(['global', 'people', 'places', 'events', 'communities', 'products']),
    had_results: z.boolean(),
  }),
  share_tapped: z.strictObject({
    target_kind: z.enum(['post', 'event', 'profile', 'place', 'product']),
    channel: z.enum(['link', 'message', 'external']),
  }),
  notification_opened: z.strictObject({ category: z.enum(NOTIFICATION_CATEGORIES) }),
  composer_opened: z.strictObject({ kind: z.enum(['text', 'photo', 'video', 'poll', 'moment']) }),
  web_vital: z.strictObject({
    metric: z.enum(['LCP', 'INP', 'CLS', 'TTFB', 'FCP']),
    value: num(600_000),
    rating: z.enum(['good', 'needs_improvement', 'poor']),
  }),
  client_error: z.strictObject({
    code: z.enum([
      'network',
      'timeout',
      'unauthorized',
      'forbidden',
      'not_found',
      'rate_limited',
      'server_error',
      'render',
      'unknown',
    ]),
    screen,
  }),
} as const;

export const SERVER_EVENTS = {
  post_created: z.strictObject({
    kind: z.enum([
      'text',
      'photo',
      'video',
      'carousel',
      'audio',
      'poll',
      'link',
      'community',
      'event',
      'product',
      'live_announcement',
    ]),
    visibility: z.enum([
      'public',
      'followers',
      'friends',
      'circle',
      'selected',
      'private',
      'community',
    ]),
  }),
  report_created: z.strictObject({
    reason: z.enum([
      'spam',
      'harassment',
      'hate',
      'violence',
      'sexual_content',
      'self_harm',
      'misinformation',
      'scam',
      'impersonation',
      'minor_safety',
      'illegal',
      'ip_violation',
      'other',
    ]),
  }),
  appeal_created: z.strictObject({}),
} as const;

export type ClientEventName = keyof typeof CLIENT_EVENTS;
export type ServerEventName = keyof typeof SERVER_EVENTS;

export type EventValidation =
  | { ok: true; name: string; props: Record<string, unknown> }
  | { ok: false; reason: 'unknown_event' | 'not_allowed_from_client' | 'invalid_properties' };

/** Validate one event against the allowlist for the given source. Pure. */
export function validateEvent(
  name: string,
  props: unknown,
  source: 'client' | 'server',
): EventValidation {
  const own = source === 'client' ? CLIENT_EVENTS : SERVER_EVENTS;
  const other = source === 'client' ? SERVER_EVENTS : CLIENT_EVENTS;
  const schema = (
    Object.hasOwn(own, name) ? (own as Record<string, z.ZodType>)[name] : undefined
  ) as z.ZodType | undefined;
  if (!schema) {
    if (source === 'client' && Object.hasOwn(other, name))
      return { ok: false, reason: 'not_allowed_from_client' };
    return { ok: false, reason: 'unknown_event' };
  }
  const parsed = schema.safeParse(props ?? {});
  if (!parsed.success) return { ok: false, reason: 'invalid_properties' };
  return { ok: true, name, props: parsed.data as Record<string, unknown> };
}

/** JSON-schema description of what clients may send (served publicly so client developers can see the allowlist). */
export function clientEventCatalog() {
  return Object.entries(CLIENT_EVENTS).map(([name, schema]) => ({
    name,
    properties: z.toJSONSchema(schema as z.ZodType, { target: 'draft-2020-12' }),
  }));
}

export const ANON_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
