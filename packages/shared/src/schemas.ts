import { z } from 'zod';
import { DATA_SAVER_MODES } from './data-saver.ts';
import { REEL_LONGEST_MS, reelHighlightsSchema } from './reels.ts';
import { MAX_UNDERSTOOD_LANGUAGES, TRANSLATABLE_KINDS, TRANSLATION_LANGUAGE_CODES } from './translation.ts';
import {
  CIRCLE_KINDS,
  COMMENT_POLICIES,
  COMMENT_SORTS,
  COMMENT_PERMISSIONS,
  MENTION_PERMISSIONS,
  MESSAGE_PERMISSIONS,
  SENSITIVE_MEDIA_LEVELS,
  HIDDEN_WORD_MAX,
  HIDDEN_WORDS_MAX,
  COMMUNITY_ROLES,
  FEED_MODES,
  FEEDBACK_SIGNALS,
  NOW_STATUS_AUDIENCES,
  NOW_STATUS_ICONS,
  NOW_STATUS_MAX,
  PLACE_CATEGORIES,
  POST_KINDS,
  PRODUCT_KINDS,
  POST_VISIBILITIES,
  CURRENCIES,
  CHAT_LIST_ITEM_MAX,
  CHAT_LIST_MAX_ITEMS,
  CHAT_LIST_TITLE_MAX,
  CHAT_POLL_MAX_OPTIONS,
  CHAT_POLL_MIN_OPTIONS,
  CHAT_POLL_OPTION_MAX,
  CHAT_POLL_QUESTION_MAX,
  DISAPPEARING_SECONDS,
  PROFILE_MODES,
  RECAP_ASPECTS,
  RECAP_MAX_ITEMS,
  RECAP_MAX_SECONDS,
  RECAP_MIN_SECONDS,
  RECAP_SOURCES,
  RECAP_STYLES,
  RECAP_TITLE_MAX,
  REMIX_MODES,
  REPORT_REASONS,
  REPORT_TARGETS,
  RSVP_STATUSES,
  STORY_VISIBILITIES,
  VISIBILITIES,
} from './constants.ts';
import { storyMusicInputSchema, storyStickersSchema } from './stories.ts';
import { postMusicInputSchema } from './music.ts';

const trimmed = (max: number) => z.string().trim().min(1).max(max);
export const uuid = z.string().uuid();
/**
 * A link people open (profile links, a post's link, a business website): http or https only.
 * z.string().url() alone accepts javascript:, data: and other schemes that run or open something
 * other than a web page when clicked.
 */
export const webUrl = (max: number) =>
  z
    .string()
    .trim()
    .url()
    .max(max)
    .refine((u) => /^https?:\/\//i.test(u), 'Use a web address starting with http:// or https://.');

export const usernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(30)
  .regex(/^[a-z0-9_.]+$/i, 'Use letters, numbers, dots and underscores only.');

export const passwordSchema = z.string().min(10, 'Use at least 10 characters.').max(200);

/** A real calendar date (YYYY-MM-DD) in the past, at most 120 years ago. */
export const birthDateSchema = z
  .string({ required_error: 'Enter your date of birth.' })
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter your date of birth.')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return false;
    const years = (Date.now() - d.getTime()) / (365.25 * 86400_000);
    return years > 0 && years < 120;
  }, 'Enter a real date of birth.');

export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: passwordSchema,
  username: usernameSchema,
  displayName: trimmed(60),
  birthDate: birthDateSchema,
  /** The browser's or phone's language, so a new account starts in it (unsupported ones fall back to English). */
  locale: z.string().max(35).optional(),
  /** A friend's invite code, from a /join/<code> link. */
  inviteCode: z.string().trim().max(32).optional(),
  /** Honeypot: a field hidden from people on the web sign-up form. Anything in it means a bot filled the form. */
  website: z.string().max(500).optional(),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(200),
  /** "Stay signed in" (the default). false: the web session ends when the browser closes, and after a day at most. */
  remember: z.boolean().optional(),
});

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 22:00.');

/** PUT /v1/me/interactions: any of the settings; quietHours null turns quiet hours off. */
export const interactionSettingsSchema = z
  .object({
    messagesFrom: z.enum(MESSAGE_PERMISSIONS),
    commentsFrom: z.enum(COMMENT_PERMISSIONS),
    mentionsFrom: z.enum(MENTION_PERMISSIONS),
    quietHours: z
      .object({ start: clock, end: clock, timezone: z.string().min(1).max(64) })
      .refine((q) => q.start !== q.end, { message: 'Quiet hours need a different start and end.' })
      .nullable(),
    sensitiveMedia: z.enum(SENSITIVE_MEDIA_LEVELS),
  })
  .partial();

/** "Report a problem" (Settings > Help). */
export const problemReportSchema = z.object({
  body: z.string().trim().min(5, 'Tell us a little more about what happened.').max(2000),
  platform: z.enum(['web', 'ios', 'android', 'other']),
  appVersion: z.string().trim().max(40).optional(),
  page: z.string().trim().max(300).optional(),
});

export const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(200), newPassword: passwordSchema });

export const tokenSchema = z.object({ token: z.string().min(20).max(200) });
export const forgotPasswordSchema = z.object({ email: z.string().trim().toLowerCase().email() });
export const resetPasswordSchema = z.object({ token: z.string().min(20).max(200), password: passwordSchema });

export const updateProfileSchema = z
  .object({
    displayName: trimmed(60),
    bio: z.string().trim().max(300),
    avatarUrl: z.string().url().max(500).nullable(),
    /** Only null (remove the cover) is accepted here; set a cover from your uploads with PUT /v1/me/cover. */
    coverUrl: z.string().url().max(500).nullable(),
    /** Describes your cover photo for screen readers. */
    coverAlt: z.string().trim().max(300).nullable(),
    links: z.array(z.object({ label: trimmed(40), url: webUrl(500) })).max(5),
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

/** At most this many co-authors on a post, besides its author. */
export const MAX_COLLABORATORS = 3;
/** At most this many people tagged in one photo. */
export const MAX_PHOTO_TAGS = 20;
const photoTagSpot = z.object({ userId: uuid, x: z.number().min(0).max(1), y: z.number().min(0).max(1) });
/** A moment to publish a post, with its UTC offset (as toISOString gives). */
const scheduleTime = z.string().datetime({ offset: true, message: 'Choose a date and time.' });

export const createPostSchema = z
  .object({
    kind: z.enum(POST_KINDS).default('text'),
    body: z.string().trim().max(5000).default(''),
    visibility: z.enum(POST_VISIBILITIES).default('public'),
    circleId: uuid.optional(),
    audience: z.array(uuid).max(200).optional(),
    communityId: uuid.optional(),
    eventId: uuid.optional(),
    productId: uuid.optional(),
    linkUrl: webUrl(1000).optional(),
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
          /** Photos: people to tag, each at a spot given as fractions of the width and height. */
          tags: z.array(photoTagSpot).max(MAX_PHOTO_TAGS).optional(),
        }),
      )
      .max(10)
      .default([]),
    poll: z.object({ options: z.array(trimmed(80)).min(2).max(6) }).optional(),
    topics: z.array(z.string().min(1).max(40)).max(5).default([]),
    aiAssisted: z.boolean().default(false),
    /** 'reel': one short vertical video, shown in the full-screen Reels feed as well as on the profile. */
    format: z.enum(['post', 'reel']).default('post'),
    /** Reels: whether other people may duet or remix this reel. On by default. */
    allowRemix: z.boolean().default(true),
    /** Reels: post as a duet or remix of another public reel. */
    remixOf: uuid.optional(),
    remixMode: z.enum(REMIX_MODES).optional(),
    /** Reels: use an existing sound instead of the video's own audio. */
    soundId: uuid.optional(),
    /** Reels: a name for this reel's own sound (when it doesn't use another one). */
    soundTitle: z.string().trim().min(1).max(100).optional(),
    /**
     * Music: part of a sound or a catalogue song that plays with a photo, carousel or text post (muted
     * until the viewer taps it), or a catalogue song a reel plays instead of its own audio.
     */
    music: postMusicInputSchema.optional(),
    /** People to invite as co-authors (people you follow who follow you back). They each accept or decline. */
    collaborators: z.array(uuid).max(MAX_COLLABORATORS).default([]),
    /** Save it as a draft only you can see, instead of publishing. */
    draft: z.boolean().default(false),
    /** Publish it later, at this time (SCHEDULE_MIN_MINUTES to SCHEDULE_MAX_DAYS ahead). Until then it's only yours. */
    scheduledAt: scheduleTime.optional(),
    /** Who can comment: everyone who can see it, people you follow, your followers, or no one. */
    commentPolicy: z.enum(COMMENT_POLICIES).default('everyone'),
    /** Reels: up to five named points in the video, shown on the scrubber (the creator can change them later). */
    highlights: reelHighlightsSchema.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.highlights?.length && v.format !== 'reel') ctx.addIssue({ code: 'custom', message: 'Only reels have highlights.', path: ['highlights'] });
    if (v.draft && v.scheduledAt) ctx.addIssue({ code: 'custom', message: 'Save a draft or schedule it, not both.', path: ['scheduledAt'] });
    if (!v.body && v.media.length === 0 && !v.linkUrl && !v.poll)
      ctx.addIssue({ code: 'custom', message: 'A post needs text, media, a link or a poll.', path: ['body'] });
    if (v.visibility === 'circle' && !v.circleId) ctx.addIssue({ code: 'custom', message: 'Choose a circle.', path: ['circleId'] });
    if (v.visibility === 'selected' && !v.audience?.length) ctx.addIssue({ code: 'custom', message: 'Choose at least one person.', path: ['audience'] });
    if (v.kind === 'poll' && !v.poll) ctx.addIssue({ code: 'custom', message: 'Add poll options.', path: ['poll'] });
    if (v.format === 'reel' && (v.media.length !== 1 || v.media[0]!.kind !== 'video'))
      ctx.addIssue({ code: 'custom', message: 'A reel is one video.', path: ['media'] });
    if (v.format === 'reel' && v.poll) ctx.addIssue({ code: 'custom', message: "Reels can't have polls.", path: ['poll'] });
    if (v.format !== 'reel' && (v.remixOf || v.soundId || v.soundTitle))
      ctx.addIssue({ code: 'custom', message: 'Only reels can use sounds or remix other reels.', path: ['format'] });
    if (v.music && v.format === 'reel' && (v.soundId || v.remixOf || v.music.soundId))
      ctx.addIssue({ code: 'custom', message: 'A reel plays one sound: choose a sound or a song.', path: ['music'] });
    if (v.music && v.format !== 'reel' && (v.poll || v.linkUrl || v.media.some((m) => m.kind !== 'image')))
      ctx.addIssue({ code: 'custom', message: 'Music can be added to photo and text posts.', path: ['music'] });
    if (!!v.remixOf !== !!v.remixMode) ctx.addIssue({ code: 'custom', message: 'Choose duet or remix.', path: ['remixMode'] });
    if (new Set(v.collaborators).size !== v.collaborators.length)
      ctx.addIssue({ code: 'custom', message: 'Invite each person once.', path: ['collaborators'] });
    for (const [i, m] of v.media.entries()) {
      if (!m.tags?.length) continue;
      if (m.kind !== 'image') ctx.addIssue({ code: 'custom', message: 'You can tag people in photos.', path: ['media', i, 'tags'] });
      if (new Set(m.tags.map((t) => t.userId)).size !== m.tags.length)
        ctx.addIssue({ code: 'custom', message: 'Tag each person once in a photo.', path: ['media', i, 'tags'] });
    }
  });

/**
 * Change a post you shared: its text, who can see it, and the description of
 * each photo or video (by media id). Photos, polls and links stay as they are.
 */
export const editPostSchema = z
  .object({
    body: z.string().trim().max(5000).optional(),
    visibility: z.enum(['public', 'followers', 'friends', 'private', 'subscribers']).optional(),
    media: z
      .array(z.object({ id: uuid, altText: z.string().trim().max(500) }))
      .max(10)
      .optional(),
  })
  .refine((v) => v.body !== undefined || v.visibility !== undefined || v.media !== undefined, { message: 'Nothing to change.', path: ['body'] })
  .refine((v) => !v.media || new Set(v.media.map((m) => m.id)).size === v.media.length, { message: 'Describe each photo once.', path: ['media'] });

/** Publish a draft later, or move a scheduled post to another time. */
export const schedulePostSchema = z.object({ scheduledAt: scheduleTime });

/** Invite people to co-author a post you already shared. */
export const collabInviteSchema = z.object({ userIds: z.array(uuid).min(1).max(MAX_COLLABORATORS) });

/** Tag someone in one of the photos of your post. */
export const photoTagSchema = photoTagSpot.extend({ mediaId: uuid });

/** Who may tag you in photos. */
export const tagSettingsSchema = z.object({ allowFrom: z.enum(['everyone', 'following', 'nobody']) });
/** PUT /v1/me/data-saver. */
export const dataSaverSchema = z.object({ mode: z.enum(DATA_SAVER_MODES) });

const translationLanguage = z
  .string()
  .trim()
  .toLowerCase()
  .refine((c) => TRANSLATION_LANGUAGE_CODES.includes(c), 'Choose a language from the list.');

/** POST /v1/translate: a post, comment, story or message, into one language. */
export const translateSchema = z.object({
  kind: z.enum(TRANSLATABLE_KINDS),
  id: z.string().uuid(),
  target: translationLanguage,
});

/** PUT /v1/me/translation: "Languages I understand" and "Translate automatically". */
export const translationSettingsSchema = z.object({
  languages: z.array(translationLanguage).max(MAX_UNDERSTOOD_LANGUAGES),
  auto: z.boolean(),
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

/** A comment, or a reply: `parentId` is the comment answered. A reply to a reply joins its top-level thread. */
/** `atMs`: reels only, a moment comment anchored to that time in the video (top-level comments). */
export const commentSchema = z.object({ body: trimmed(2000), parentId: uuid.optional(), atMs: z.number().int().min(0).max(REEL_LONGEST_MS).optional() });
/** Change your comment's text, within COMMENT_EDIT_MINUTES of posting it. */
export const editCommentSchema = z.object({ body: trimmed(2000) });
export const commentsQuerySchema = z.object({
  sort: z.enum(COMMENT_SORTS).default('top'),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
/** Who can comment on your post. */
export const commentPolicySchema = z.object({ policy: z.enum(COMMENT_POLICIES) });
/** Pin one comment to the top of your post. */
export const pinCommentSchema = z.object({ commentId: uuid });
/** Your hidden words, replacing the list: comments on your posts containing one are hidden. */
export const hiddenWordsSchema = z.object({
  words: z.array(z.string().trim().min(1).max(HIDDEN_WORD_MAX)).max(HIDDEN_WORDS_MAX, `Keep it to ${HIDDEN_WORDS_MAX} words or phrases.`),
});
export const reactionSchema = z.object({ kind: z.enum(['like', 'love', 'celebrate', 'insightful', 'funny']).default('like') });
export const feedbackSchema = z.object({
  signal: z.enum(FEEDBACK_SIGNALS),
  postId: uuid.optional(),
  authorId: uuid.optional(),
  topic: z.string().max(40).optional(),
});

export const circleSchema = z.object({ name: trimmed(40), kind: z.enum(CIRCLE_KINDS).default('custom') });
/** Rename a circle or change its kind. */
export const circleUpdateSchema = z
  .object({ name: trimmed(40), kind: z.enum(CIRCLE_KINDS) })
  .partial()
  .refine((v) => v.name !== undefined || v.kind !== undefined, { message: 'Nothing to change.' });
export const circleMembersSchema = z.object({ userIds: z.array(uuid).min(1).max(200) });

/** Set your cover photo: one of your own uploaded photos (POST /v1/media or /v1/uploads). */
export const setCoverSchema = z.object({
  mediaId: uuid,
  /** Describes the photo for people using screen readers. Defaults to the upload's own description. */
  altText: z.string().trim().max(300).optional(),
});

/** Set your "Now" status. It ends after 24 hours. */
export const nowStatusSchema = z.object({
  text: trimmed(NOW_STATUS_MAX),
  icon: z.enum(NOW_STATUS_ICONS).nullable().default(null),
  audience: z.enum(NOW_STATUS_AUDIENCES).default('everyone'),
});

export const createConversationSchema = z.object({
  memberIds: z.array(uuid).min(1).max(255),
  title: z.string().trim().max(80).optional(),
});
export const sendMessageSchema = z
  .object({
    body: z.string().trim().max(4000).default(''),
    replyToId: uuid.optional(),
    /** Your own uploads (POST /v1/media or /v1/uploads); the server fills in the address and kind. */
    attachments: z
      .array(z.object({ mediaId: uuid, name: z.string().max(200).optional() }))
      .max(10)
      .default([]),
    clientId: z.string().max(64).optional(),
    /** 'yap': a hold-to-talk voice clip (one audio attachment, up to 60 seconds) that plays out loud for people who allow it. */
    kind: z.enum(['message', 'yap']).default('message'),
    /** One photo or video uploaded with POST /v1/media?viewOnce=true, opened once by each person. */
    viewOnce: z.boolean().default(false),
    /** Share a story you can see: it shows as a card, which opens only for people who can see it too. */
    storyId: uuid.optional(),
  })
  .refine((v) => v.body.length > 0 || v.attachments.length > 0 || !!v.storyId, { message: 'Write a message or attach a file.', path: ['body'] });

/** Edit your own message's text, within 15 minutes of sending it. */
export const editMessageSchema = z.object({ body: z.string().trim().max(4000) });
/** Disappearing messages in one chat: null turns them off. */
export const disappearingSchema = z.object({
  seconds: z
    .number()
    .int()
    .refine((s) => (DISAPPEARING_SECONDS as readonly number[]).includes(s), { message: 'Choose 24 hours, 7 days or 90 days.' })
    .nullable(),
});
/** A poll in a chat. The end time, if set, is between 5 minutes and 30 days from now (checked by the server). */
export const createChatPollSchema = z
  .object({
    question: z.string().trim().min(1).max(CHAT_POLL_QUESTION_MAX),
    options: z.array(z.string().trim().min(1).max(CHAT_POLL_OPTION_MAX)).min(CHAT_POLL_MIN_OPTIONS).max(CHAT_POLL_MAX_OPTIONS),
    multiple: z.boolean().default(false),
    anonymous: z.boolean().default(false),
    allowAddOptions: z.boolean().default(false),
    endsAt: z.string().datetime({ offset: true }).nullable().optional(),
    clientId: z.string().max(64).optional(),
  })
  .refine((v) => new Set(v.options.map((o) => o.toLowerCase())).size === v.options.length, {
    message: 'Each option needs to be different.',
    path: ['options'],
  });
/** Your choice in a poll: one option (or several when it allows it). An empty list takes your vote back. */
export const chatPollVoteSchema = z.object({ optionIds: z.array(uuid).max(CHAT_POLL_MAX_OPTIONS) });
export const chatPollOptionSchema = z.object({ text: z.string().trim().min(1).max(CHAT_POLL_OPTION_MAX) });
/** A shared list in a chat, with its first items if any. */
export const createChatListSchema = z.object({
  title: z.string().trim().min(1).max(CHAT_LIST_TITLE_MAX),
  items: z.array(z.string().trim().min(1).max(CHAT_LIST_ITEM_MAX)).max(CHAT_LIST_MAX_ITEMS).default([]),
  clientId: z.string().max(64).optional(),
});
export const chatListItemSchema = z.object({ text: z.string().trim().min(1).max(CHAT_LIST_ITEM_MAX) });
export const chatListItemPatchSchema = z.object({ done: z.boolean() });
/** Every item of the list, in the new order. */
export const chatListOrderSchema = z.object({ itemIds: z.array(uuid).min(1).max(CHAT_LIST_MAX_ITEMS) });
/** "Remind me" (just you) or "Remind the group" (group admins), at a time from a minute to a year ahead. */
export const chatReminderSchema = z.object({
  at: z.string().datetime({ offset: true }),
  scope: z.enum(['me', 'group']).default('me'),
});
/** Search the messages of one chat. */
export const messageSearchSchema = z.object({
  q: z.string().trim().min(1).max(100),
  cursor: z.string().max(200).optional(),
});

/** "Let Yaps play out loud" in one chat. null goes back to the default (on for yaps from friends). */
export const conversationYapsSchema = z.object({ playOutLoud: z.boolean().nullable() });
/** "Pause Yaps" everywhere. */
export const yapSettingsSchema = z.object({ paused: z.boolean() });

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
/**
 * The host changes an event. Only the fields given change; null clears an optional one (the end,
 * the place, the location, the capacity). The community stays as it was. The end is checked
 * against the start after the change is applied (apps/api/src/modules/events.ts).
 */
export const updateEventSchema = z.object({
  title: trimmed(120).optional(),
  description: z.string().trim().max(5000).optional(),
  startsAt: z.string().datetime({ offset: true }).optional(),
  endsAt: z.string().datetime({ offset: true }).nullable().optional(),
  timezone: z.string().max(60).optional(),
  locationText: z.string().trim().max(300).nullable().optional(),
  placeId: uuid.nullable().optional(),
  capacity: z.number().int().positive().max(1_000_000).nullable().optional(),
  visibility: z.enum(['public', 'followers', 'friends', 'private']).optional(),
  online: z.boolean().optional(),
});
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
  website: webUrl(2000).optional(),
});

export const createProductSchema = z.object({
  kind: z.enum(PRODUCT_KINDS).default('product'),
  title: trimmed(120),
  description: z.string().trim().max(5000).default(''),
  priceCents: z.number().int().min(0).max(100_000_000),
  currency: z.string().length(3).toUpperCase().pipe(z.enum(CURRENCIES)).default('USD'),
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
  /** An item uploaded through /v1/media or /v1/uploads (plays its processed versions). */
  mediaId: uuid.optional(),
  mediaUrl: z.string().url().optional(),
  mediaKind: z.enum(['image', 'video', 'audio']).optional(),
  expiresIn: z.enum(['1h', '24h', 'permanent', 'custom']).default('24h'),
  customHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .optional(),
  /** 'close_friends': only the people on your close friends list. */
  visibility: z.enum(STORY_VISIBILITIES).default('friends'),
  locationText: z.string().max(200).optional(),
  /** Mentions, hashtags and interactive stickers placed on the story. */
  stickers: storyStickersSchema,
  /** Let people reshare this story into their own (public stories, or people it mentions). */
  allowReshare: z.boolean().default(true),
  /** A sound from the library, played in a loop while the story shows (on a video, instead of its own sound). */
  music: storyMusicInputSchema.optional(),
});

/** Reshare a story into your own: it shows as a card, credited to its author. */
export const reshareMomentSchema = z.object({
  body: z.string().trim().max(500).default(''),
  expiresIn: z.enum(['1h', '24h', 'permanent']).default('24h'),
  visibility: z.enum(STORY_VISIBILITIES).default('friends'),
  stickers: storyStickersSchema,
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

/** Settings > AI helpers: suggested replies in chats and the Catch me up card on Pulse. */
export const aiSettingsSchema = z.object({ smartReplies: z.boolean().optional(), catchUp: z.boolean().optional() });

/** Suggested replies in one chat: true or false, or null for the default (on in one-to-one chats, off in groups). */
export const conversationSmartRepliesSchema = z.object({ enabled: z.boolean().nullable() });

/** "Suggest a description" for one of your photos. */
export const altTextSuggestSchema = z.object({ mediaId: uuid });

/** "Suggest a caption": from what you've written so far and your photos (your own uploads). */
export const captionIdeasSchema = z
  .object({
    text: z.string().max(5000).default(''),
    mediaIds: z.array(uuid).max(4).default([]),
    format: z.enum(['post', 'reel']).default('post'),
  })
  .refine((v) => v.text.trim().length > 0 || v.mediaIds.length > 0, { message: 'Write something or add a photo first.', path: ['text'] });

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

/** Maximum hashed contacts in one POST /v1/contacts/match; apps send an address book in chunks. */
export const MAX_CONTACT_HASHES = 2000;

/** Hashed contacts (hex sha256 of "<salt>:<kind>:<value>"), never the addresses themselves. */
export const contactMatchSchema = z.object({
  hashes: z
    .array(z.string().regex(/^[0-9a-fA-F]{64}$/, 'Send SHA-256 hashes in hex.'))
    .min(1)
    .max(MAX_CONTACT_HASHES, `Send at most ${MAX_CONTACT_HASHES} contacts at a time.`),
  source: z.enum(['mobile', 'web']).optional(),
});

export const sharingSettingsSchema = z
  .object({
    findableByContacts: z.boolean(),
    allowDownload: z.boolean(),
  })
  .partial();

export const ONBOARDING_STEPS = ['interests', 'follow', 'friends'] as const;

/** What happened in onboarding, for the onboarding_completed analytics event. Counts only. */
export const onboardingCompleteSchema = z.object({
  platform: z.enum(['web', 'mobile']).optional(),
  steps: z
    .array(
      z.object({
        step: z.enum(ONBOARDING_STEPS),
        skipped: z.boolean().default(false),
        count: z.number().int().min(0).max(10_000).default(0),
      }),
    )
    .max(10)
    .default([]),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type CreatePostInput = z.infer<typeof createPostSchema>;
export type EditPostInput = z.infer<typeof editPostSchema>;
export type CreateEventInput = z.infer<typeof createEventSchema>;

/**
 * Make a recap video. `mediaIds` are photos and videos from the source, in the
 * order they play; each must be one the maker can see there right now.
 */
export const createRecapSchema = z
  .object({
    source: z.enum(RECAP_SOURCES),
    /** The memory or chapter. Not used for "On this day". */
    sourceId: uuid.optional(),
    title: trimmed(RECAP_TITLE_MAX),
    mediaIds: z
      .array(uuid)
      .min(1, 'Choose at least one photo or video.')
      .max(RECAP_MAX_ITEMS, `Choose up to ${RECAP_MAX_ITEMS} photos and videos.`)
      .refine((ids) => new Set(ids).size === ids.length, { message: 'Each photo or video can be in a recap once.' }),
    style: z.enum(RECAP_STYLES).default('calm'),
    aspect: z.enum(RECAP_ASPECTS).default('9:16'),
    /** A sound from the sounds library, under the same rules as for reels. */
    soundId: uuid.nullable().optional(),
    /** The longest it may be, in seconds. Left out, it's as long as the photos and clips need (up to 60). */
    lengthSeconds: z.number().int().min(RECAP_MIN_SECONDS).max(RECAP_MAX_SECONDS).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.source !== 'on_this_day' && !v.sourceId) ctx.addIssue({ code: 'custom', message: 'Choose a memory or chapter.', path: ['sourceId'] });
  });
export type CreateRecapInput = z.input<typeof createRecapSchema>;
