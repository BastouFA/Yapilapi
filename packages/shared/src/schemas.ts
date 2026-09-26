import { z } from 'zod';
import {
  CIRCLE_KINDS,
  COMMUNITY_ROLES,
  FEED_MODES,
  FEEDBACK_SIGNALS,
  PLACE_CATEGORIES,
  POST_KINDS,
  PRODUCT_KINDS,
  PROFILE_MODES,
  REPORT_REASONS,
  REPORT_TARGETS,
  RSVP_STATUSES,
  VISIBILITIES,
} from './constants.ts';

const trimmed = (max: number) => z.string().trim().min(1).max(max);
export const uuid = z.string().uuid();

export const usernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(30)
  .regex(/^[a-z0-9_.]+$/i, 'Use letters, numbers, dots and underscores only.');

export const passwordSchema = z.string().min(10, 'Use at least 10 characters.').max(200);

export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: passwordSchema,
  username: usernameSchema,
  displayName: trimmed(60),
  birthDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(200),
});

export const tokenSchema = z.object({ token: z.string().min(20).max(200) });
export const forgotPasswordSchema = z.object({ email: z.string().trim().toLowerCase().email() });
export const resetPasswordSchema = z.object({ token: z.string().min(20).max(200), password: passwordSchema });

export const updateProfileSchema = z
  .object({
    displayName: trimmed(60),
    bio: z.string().trim().max(300),
    avatarUrl: z.string().url().max(500).nullable(),
    coverUrl: z.string().url().max(500).nullable(),
    links: z.array(z.object({ label: trimmed(40), url: z.string().url().max(500) })).max(5),
    mode: z.enum(PROFILE_MODES),
    locale: z.string().min(2).max(10),
    isPrivate: z.boolean(),
    /** ISO 3166-1 alpha-2; null clears it. Used for regional rules. */
    country: z
      .string()
      .regex(/^[A-Za-z]{2}$/)
      .transform((c) => c.toUpperCase())
      .nullable(),
  })
  .partial();

export const setInterestsSchema = z.object({ topics: z.array(z.string().min(1).max(40)).min(1).max(30) });

export const createPostSchema = z
  .object({
    kind: z.enum(POST_KINDS).default('text'),
    body: z.string().trim().max(5000).default(''),
    visibility: z.enum(VISIBILITIES).default('public'),
    circleId: uuid.optional(),
    audience: z.array(uuid).max(200).optional(),
    communityId: uuid.optional(),
    eventId: uuid.optional(),
    productId: uuid.optional(),
    linkUrl: z.string().url().max(1000).optional(),
    media: z
      .array(
        z.object({
          /** An item uploaded through /v1/media or /v1/uploads (preferred: keeps processed sizes). */
          id: uuid.optional(),
          url: z.string().url().max(1000),
          kind: z.enum(['image', 'video', 'audio']),
          altText: z.string().max(500).optional(),
          width: z.number().int().positive().optional(),
          height: z.number().int().positive().optional(),
        }),
      )
      .max(10)
      .default([]),
    poll: z.object({ options: z.array(trimmed(80)).min(2).max(6) }).optional(),
    topics: z.array(z.string().min(1).max(40)).max(5).default([]),
    aiAssisted: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (!v.body && v.media.length === 0 && !v.linkUrl && !v.poll)
      ctx.addIssue({ code: 'custom', message: 'A post needs text, media, a link or a poll.', path: ['body'] });
    if (v.visibility === 'circle' && !v.circleId) ctx.addIssue({ code: 'custom', message: 'Choose a circle.', path: ['circleId'] });
    if (v.visibility === 'selected' && !v.audience?.length) ctx.addIssue({ code: 'custom', message: 'Choose at least one person.', path: ['audience'] });
    if (v.kind === 'poll' && !v.poll) ctx.addIssue({ code: 'custom', message: 'Add poll options.', path: ['poll'] });
  });

export const feedQuerySchema = z.object({
  mode: z.enum(FEED_MODES).default('for_you'),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const pageQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const commentSchema = z.object({ body: trimmed(2000), parentId: uuid.optional() });
export const reactionSchema = z.object({ kind: z.enum(['like', 'love', 'celebrate', 'insightful', 'funny']).default('like') });
export const feedbackSchema = z.object({
  signal: z.enum(FEEDBACK_SIGNALS),
  postId: uuid.optional(),
  authorId: uuid.optional(),
  topic: z.string().max(40).optional(),
});

export const circleSchema = z.object({ name: trimmed(40), kind: z.enum(CIRCLE_KINDS).default('custom') });
export const circleMembersSchema = z.object({ userIds: z.array(uuid).min(1).max(200) });

export const createConversationSchema = z.object({
  memberIds: z.array(uuid).min(1).max(255),
  title: z.string().trim().max(80).optional(),
});
export const sendMessageSchema = z
  .object({
    body: z.string().trim().max(4000).default(''),
    replyToId: uuid.optional(),
    attachments: z
      .array(z.object({ url: z.string().url(), kind: z.enum(['image', 'video', 'audio', 'file']), name: z.string().max(200).optional() }))
      .max(10)
      .default([]),
    clientId: z.string().max(64).optional(),
  })
  .refine((v) => v.body.length > 0 || v.attachments.length > 0, { message: 'Write a message or attach a file.', path: ['body'] });

export const createCommunitySchema = z.object({
  name: trimmed(80),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(40)
    .regex(/^[a-z0-9-]+$/, 'Use lowercase letters, numbers and hyphens.'),
  description: z.string().trim().max(2000).default(''),
  visibility: z.enum(['public', 'private']).default('public'),
  topics: z.array(z.string().max(40)).max(5).default([]),
  rules: z.array(trimmed(200)).max(20).default([]),
});
export const setMemberRoleSchema = z.object({ role: z.enum(COMMUNITY_ROLES).exclude(['owner']) });

export const createEventSchema = z
  .object({
    title: trimmed(120),
    description: z.string().trim().max(5000).default(''),
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }).optional(),
    timezone: z.string().max(60).default('UTC'),
    locationText: z.string().trim().max(300).optional(),
    placeId: uuid.optional(),
    communityId: uuid.optional(),
    capacity: z.number().int().positive().max(1_000_000).optional(),
    visibility: z.enum(['public', 'followers', 'friends', 'private']).default('public'),
    online: z.boolean().default(false),
  })
  .refine((v) => !v.endsAt || new Date(v.endsAt) > new Date(v.startsAt), { message: 'The end must be after the start.', path: ['endsAt'] });
export const rsvpSchema = z.object({ status: z.enum(RSVP_STATUSES) });

export const createPlaceSchema = z.object({
  name: trimmed(120),
  category: z.enum(PLACE_CATEGORIES),
  address: z.string().trim().max(300).optional(),
  city: z.string().trim().max(100).optional(),
  country: z.string().trim().length(2).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  description: z.string().max(2000).default(''),
  businessId: uuid.optional(),
});

export const createBusinessSchema = z.object({
  name: trimmed(120),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(40)
    .regex(/^[a-z0-9-]+$/),
  description: z.string().trim().max(2000).default(''),
  category: z.string().trim().max(60).default('general'),
  website: z.string().url().optional(),
});

export const createProductSchema = z.object({
  kind: z.enum(PRODUCT_KINDS).default('product'),
  title: trimmed(120),
  description: z.string().trim().max(5000).default(''),
  priceCents: z.number().int().min(0).max(100_000_000),
  currency: z.string().length(3).toUpperCase().default('USD'),
  businessId: uuid.optional(),
  eventId: uuid.optional(),
  inventory: z.number().int().min(0).optional(),
});

export const createOrderSchema = z.object({
  items: z
    .array(z.object({ productId: uuid, quantity: z.number().int().min(1).max(100) }))
    .min(1)
    .max(50),
  idempotencyKey: z.string().min(8).max(100),
  /** Buying a ticket for this live: the order must contain the live's ticket, and it only unlocks this live. */
  liveSessionId: uuid.optional(),
});

export const reportSchema = z.object({
  targetType: z.enum(REPORT_TARGETS),
  targetId: uuid,
  reason: z.enum(REPORT_REASONS),
  details: z.string().trim().max(2000).optional(),
});

export const moderationDecisionSchema = z.object({
  decision: z.enum(['no_action', 'restrict', 'remove', 'suspend_user', 'approve_ad', 'reject_ad']),
  note: z.string().max(2000).optional(),
});

export const appealSchema = z.object({ caseId: uuid, statement: trimmed(2000) });

export const createMomentSchema = z.object({
  body: z.string().trim().max(500).default(''),
  mediaUrl: z.string().url().optional(),
  mediaKind: z.enum(['image', 'video', 'audio']).optional(),
  expiresIn: z.enum(['1h', '24h', 'permanent', 'custom']).default('24h'),
  customHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .optional(),
  visibility: z.enum(VISIBILITIES).default('friends'),
  locationText: z.string().max(200).optional(),
});

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  type: z.enum(['all', 'people', 'posts', 'communities', 'events', 'places', 'businesses', 'products', 'topics']).default('all'),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export const aiAssistSchema = z.object({
  task: z.enum(['caption', 'summarize_conversation', 'summarize_community', 'search_intent', 'plan_from_message', 'translate']),
  input: z.string().max(8000).default(''),
  conversationId: uuid.optional(),
  communityId: uuid.optional(),
  targetLanguage: z.string().min(2).max(10).optional(),
});

export const notificationPrefsSchema = z.object({
  categories: z.record(z.string(), z.boolean()),
});

export const attentionSchema = z
  .object({
    focusMode: z.boolean(),
    quietMode: z.boolean(),
    friendsOnly: z.boolean(),
    reducedRecommendations: z.boolean(),
    dailyTimeBudgetMinutes: z.number().int().min(0).max(1440).nullable(),
    notificationsPausedUntil: z.string().datetime({ offset: true }).nullable(),
  })
  .partial();

export const consentSchema = z.object({
  purpose: z.enum(['personalization', 'ai_processing', 'advertising', 'analytics']),
  granted: z.boolean(),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type CreatePostInput = z.infer<typeof createPostSchema>;
export type CreateEventInput = z.infer<typeof createEventSchema>;
