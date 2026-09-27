/** Who can see a moment or an event-style item. */
export const VISIBILITIES = ['public', 'followers', 'friends', 'circle', 'selected', 'private'] as const;
/** Posts and reels can also be for subscribers: others see a locked card. Needs a subscription plan. */
export const POST_VISIBILITIES = [...VISIBILITIES, 'subscribers'] as const;
export type Visibility = (typeof POST_VISIBILITIES)[number];

/** Stories can also go to your close friends list only. */
export const STORY_VISIBILITIES = [...VISIBILITIES, 'close_friends'] as const;
export type StoryVisibility = (typeof STORY_VISIBILITIES)[number];

/** 'duet' plays side by side with the original reel; 'remix' reuses its sound only. */
export const REMIX_MODES = ['duet', 'remix'] as const;
export type RemixMode = (typeof REMIX_MODES)[number];

/** A scheduled post goes out at least this many minutes ahead… */
export const SCHEDULE_MIN_MINUTES = 5;
/** …and at most this many days ahead. */
export const SCHEDULE_MAX_DAYS = 60;
/** A post's text can be changed at most this many times a day. */
export const MAX_EDITS_PER_DAY = 20;

export const POST_KINDS = ['text', 'photo', 'video', 'carousel', 'audio', 'poll', 'link'] as const;
export type PostKind = (typeof POST_KINDS)[number];

export const PROFILE_MODES = ['personal', 'creator', 'professional', 'business'] as const;
export type ProfileMode = (typeof PROFILE_MODES)[number];

export const FEED_MODES = ['for_you', 'following', 'friends', 'communities', 'local'] as const;
export type FeedMode = (typeof FEED_MODES)[number];

export const CIRCLE_KINDS = ['family', 'close_friends', 'work', 'business', 'travel', 'custom'] as const;
export type CircleKind = (typeof CIRCLE_KINDS)[number];
/** At most this many circles per person, and people in one circle. */
export const MAX_CIRCLES = 50;
export const MAX_CIRCLE_MEMBERS = 500;

/**
 * "Now" statuses: a short line on your profile and in chat headers for 24 hours.
 * The icons are names from the design system's icon set (never emoji).
 */
export const NOW_STATUS_MAX = 60;
export const NOW_STATUS_HOURS = 24;
export const NOW_STATUS_ICONS = ['sparkle', 'music', 'map-pin', 'calendar', 'heart', 'globe', 'star', 'mic'] as const;
export type NowStatusIcon = (typeof NOW_STATUS_ICONS)[number];
/** 'everyone': anyone who can see your profile. 'close_friends': people on your close friends list who follow you. */
export const NOW_STATUS_AUDIENCES = ['everyone', 'followers', 'close_friends'] as const;
export type NowStatusAudience = (typeof NOW_STATUS_AUDIENCES)[number];

export const COMMUNITY_ROLES = ['owner', 'admin', 'moderator', 'organizer', 'member', 'guest'] as const;
export type CommunityRole = (typeof COMMUNITY_ROLES)[number];
/** Higher number = more authority. */
export const COMMUNITY_ROLE_RANK: Record<CommunityRole, number> = {
  guest: 0,
  member: 1,
  organizer: 2,
  moderator: 3,
  admin: 4,
  owner: 5,
};

export const RSVP_STATUSES = ['going', 'interested', 'not_going'] as const;

export const NOTIFICATION_CATEGORIES = ['messages', 'friends', 'creators', 'communities', 'events', 'commerce', 'security', 'moderation', 'system'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/**
 * Comments. The post's author chooses who can comment: everyone who can see the post,
 * people they follow, their followers, or no one. Existing posts are open to everyone.
 */
export const COMMENT_POLICIES = ['everyone', 'following', 'followers', 'off'] as const;
export type CommentPolicy = (typeof COMMENT_POLICIES)[number];
/**
 * Who can reach you (Settings > Privacy). Friends always can. Messages: who can start a chat
 * with you. Comments: who can comment on your posts, on top of each post's own setting.
 * Mentions: whose @mentions notify you.
 */
export const MESSAGE_PERMISSIONS = ['everyone', 'following', 'friends'] as const;
export type MessagePermission = (typeof MESSAGE_PERMISSIONS)[number];
export const COMMENT_PERMISSIONS = ['everyone', 'following', 'followers'] as const;
export type CommentPermission = (typeof COMMENT_PERMISSIONS)[number];
export const MENTION_PERMISSIONS = ['everyone', 'following', 'nobody'] as const;
export type MentionPermission = (typeof MENTION_PERMISSIONS)[number];
/** Sensitive photos and videos: covered until you choose to see them, or not shown at all (always so under 18). */
export const SENSITIVE_MEDIA_LEVELS = ['standard', 'less'] as const;
export type SensitiveMediaLevel = (typeof SENSITIVE_MEDIA_LEVELS)[number];
/** Top: likes, a like from the post's author, replies and freshness. Newest: most recent first. */
export const COMMENT_SORTS = ['top', 'newest'] as const;
export type CommentSort = (typeof COMMENT_SORTS)[number];
/** A comment can be edited this many minutes after it was posted. */
export const COMMENT_EDIT_MINUTES = 15;
/** Hidden words: at most this many words or phrases, each at most HIDDEN_WORD_MAX characters. */
export const HIDDEN_WORDS_MAX = 100;
export const HIDDEN_WORD_MAX = 60;

/** Nobody younger than this can have an account. */
export const MIN_SIGNUP_AGE = 13;
/** Minor protections apply below this age; selling, payouts, paid plans and receiving tips need it. */
export const ADULT_AGE = 18;

export const REPORT_REASONS = [
  'spam',
  'harassment',
  'hate',
  'violence',
  'nudity',
  'self_harm',
  'impersonation',
  'fraud',
  'minor_safety',
  'copyright',
  'other',
] as const;

/** What can be reported. A story is a moment; a live is a live session; a room is an audio room. */
export const REPORT_TARGETS = ['user', 'post', 'comment', 'message', 'community', 'event', 'product', 'story', 'room', 'live'] as const;

export const FEEDBACK_SIGNALS = ['more_like_this', 'less_like_this', 'not_interested', 'mute_topic', 'mute_creator'] as const;

export const PRODUCT_KINDS = ['product', 'service', 'ticket', 'booking', 'digital'] as const;

export const PLACE_CATEGORIES = ['restaurant', 'store', 'venue', 'attraction', 'service'] as const;

export const USER_ROLES = ['user', 'moderator', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/**
 * File picker filters. The server works out each file's real format from its
 * contents and converts what browsers can't show (HEIC photos to JPEG, any
 * video to a web MP4), so pickers accept everything phones and cameras make.
 * Extensions are listed too because some browsers don't know HEIC or MKV types.
 */
export const IMAGE_ACCEPT = 'image/*,.heic,.heif,.avif,.tif,.tiff,.bmp';
export const VIDEO_ACCEPT = 'video/*,.mov,.mkv,.avi,.3gp,.3g2,.m4v,.mpg,.mpeg,.ts,.webm';
export const MEDIA_ACCEPT = `${IMAGE_ACCEPT},${VIDEO_ACCEPT}`;

/** Whether a picked file is a video, from its type or, when the browser doesn't know it, its extension. */
export function isVideoFile(file: { type: string; name: string }): boolean {
  return file.type.startsWith('video/') || /\.(mov|mkv|avi|3gp|3g2|m4v|mpg|mpeg|ts|webm|mp4)$/i.test(file.name);
}

/**
 * Currencies people can price in. Paystack takes NGN, GHS, KES and ZAR (cards
 * and mobile money) when it is configured; the others go to the default provider.
 */
export const CURRENCIES = ['USD', 'EUR', 'GBP', 'NGN', 'GHS', 'KES', 'ZAR', 'XOF'] as const;
export type Currency = (typeof CURRENCIES)[number];

/**
 * Roughly how many units of each currency a US dollar buys, rounded, so price
 * limits (the biggest tip or plan) mean about the same everywhere.
 */
export const CURRENCY_SCALE: Record<Currency, number> = { USD: 1, EUR: 1, GBP: 1, NGN: 1000, GHS: 10, KES: 100, ZAR: 10, XOF: 500 };

/** A sensible default currency for someone's country (ISO 3166-1 alpha-2). */
export function currencyForCountry(country: string | null | undefined): Currency {
  switch ((country ?? '').toUpperCase()) {
    case 'NG':
      return 'NGN';
    case 'GH':
      return 'GHS';
    case 'KE':
      return 'KES';
    case 'ZA':
      return 'ZAR';
    case 'GB':
      return 'GBP';
    case 'SN':
    case 'CI':
    case 'ML':
    case 'BF':
    case 'NE':
    case 'TG':
    case 'BJ':
    case 'GW':
      return 'XOF';
    case 'FR':
    case 'DE':
    case 'ES':
    case 'IT':
    case 'PT':
    case 'NL':
    case 'BE':
    case 'IE':
    case 'AT':
    case 'FI':
      return 'EUR';
    default:
      return 'USD';
  }
}

/**
 * Boosting a post: the budgets offered in each currency (in hundredths) and
 * the price of 1,000 impressions. Budgets are round local amounts, not
 * conversions, so the numbers people see make sense where they live.
 */
export const BOOST_OPTIONS: Record<string, { budgets: number[]; cpmCents: number }> = {
  USD: { budgets: [500, 1000, 2500], cpmCents: 500 },
  EUR: { budgets: [500, 1000, 2500], cpmCents: 500 },
  GBP: { budgets: [500, 1000, 2500], cpmCents: 400 },
  NGN: { budgets: [500_000, 1_000_000, 2_500_000], cpmCents: 500_000 },
  GHS: { budgets: [5_000, 10_000, 25_000], cpmCents: 5_000 },
  KES: { budgets: [50_000, 100_000, 250_000], cpmCents: 50_000 },
  ZAR: { budgets: [10_000, 20_000, 50_000], cpmCents: 10_000 },
  XOF: { budgets: [300_000, 600_000, 1_500_000], cpmCents: 300_000 },
};
export const BOOST_DAYS = [1, 3, 7, 14] as const;

/**
 * Chapters: titled collections of stories on a profile. The audience is the
 * chapter's own; people under 18 can't choose 'public'.
 */
export const CHAPTER_AUDIENCES = ['public', 'followers', 'friends', 'close_friends', 'only_me'] as const;
export type ChapterAudience = (typeof CHAPTER_AUDIENCES)[number];
export const CHAPTER_TITLE_MAX = 40;
export const CHAPTER_DESCRIPTION_MAX = 200;
export const CHAPTER_GUESTBOOK_MAX = 140;
export const CHAPTER_STORIES_MAX = 100;
export const CHAPTER_CONTRIBUTORS_MAX = 20;
/** Cover gradients from the brand palette, as [start, end] (135deg). White symbols read on all of them. */
export const CHAPTER_GRADIENTS = {
  yapi: ['#D21D4A', '#C2410C'],
  sunrise: ['#FF5C7A', '#C2410C'],
  saffron: ['#C2410C', '#FFB020'],
  dusk: ['#0E1020', '#D21D4A'],
  lagoon: ['#00735F', '#1E8A3E'],
  ink: ['#555B75', '#0E1020'],
} as const satisfies Record<string, readonly [string, string]>;
export type ChapterGradient = keyof typeof CHAPTER_GRADIENTS;
export const CHAPTER_GRADIENT_NAMES = Object.keys(CHAPTER_GRADIENTS) as ChapterGradient[];
/** Cover symbols: plain line icons, never emoji. Each app maps them to its own icon set. */
export const CHAPTER_SYMBOLS = ['star', 'sparkle', 'heart', 'music', 'globe', 'calendar', 'compass', 'home', 'bookmark', 'image'] as const;
export type ChapterSymbol = (typeof CHAPTER_SYMBOLS)[number];

/** Chats: how long after sending a message its text can be edited. */
export const MESSAGE_EDIT_MINUTES = 15;
/** Chats: pinned messages per conversation. */
export const MAX_PINNED_MESSAGES = 3;
/** Disappearing messages: 24 hours, 7 days or 90 days (off is null). */
export const DISAPPEARING_SECONDS = [86_400, 604_800, 7_776_000] as const;
export type DisappearingSeconds = (typeof DISAPPEARING_SECONDS)[number];
/** Chat polls: 2 to 10 options, a question of up to 200 characters, options of up to 80. They can end up to 30 days after they start. */
export const CHAT_POLL_MIN_OPTIONS = 2;
export const CHAT_POLL_MAX_OPTIONS = 10;
export const CHAT_POLL_QUESTION_MAX = 200;
export const CHAT_POLL_OPTION_MAX = 80;
export const CHAT_POLL_MAX_DAYS = 30;
/** Shared lists (checklists) in chats: up to 100 items of up to 200 characters, under a title of up to 80. */
export const CHAT_LIST_MAX_ITEMS = 100;
export const CHAT_LIST_TITLE_MAX = 80;
export const CHAT_LIST_ITEM_MAX = 200;
/** Reminders on chat messages: at least a minute and at most a year ahead, up to 100 waiting per person. */
export const CHAT_REMINDER_MAX_DAYS = 365;
export const CHAT_REMINDER_MAX_PENDING = 100;
/**
 * Saved posts and boards. A board is private (only you), shared (you and the
 * collaborators you invite) or public (also on your profile). People under 18
 * can't make a board public.
 */
export const BOARD_VISIBILITIES = ['private', 'shared', 'public'] as const;
export type BoardVisibility = (typeof BOARD_VISIBILITIES)[number];
export const BOARD_NAME_MAX = 60;
export const BOARD_DESCRIPTION_MAX = 160;
/** Boards one person can own. */
export const BOARDS_MAX = 200;
/** Collaborators on one board, invited or accepted. */
export const BOARD_COLLABORATORS_MAX = 30;
export const BOARD_ITEMS_MAX = 1000;
/** A private note on a saved post. */
export const SAVE_NOTE_MAX = 280;
/** Filters on the Saved page and inside a board. */
export const SAVED_FILTERS = ['all', 'photos', 'videos', 'text'] as const;
export type SavedFilter = (typeof SAVED_FILTERS)[number];

/**
 * Recap videos: made from a memory, "On this day" or one of your chapters.
 * Up to 30 photos and video clips (clips are cut to 4 seconds), at most 60
 * seconds long, rendered on the server. Each person can start 10 a day.
 */
export const RECAP_STYLES = ['calm', 'quick', 'film'] as const;
export type RecapStyle = (typeof RECAP_STYLES)[number];
export const RECAP_ASPECTS = ['9:16', '1:1'] as const;
export type RecapAspect = (typeof RECAP_ASPECTS)[number];
export const RECAP_SOURCES = ['memory', 'on_this_day', 'chapter'] as const;
export type RecapSource = (typeof RECAP_SOURCES)[number];
export const RECAP_MAX_ITEMS = 30;
export const RECAP_MAX_SECONDS = 60;
export const RECAP_MIN_SECONDS = 3;
export const RECAP_CLIP_MAX_SECONDS = 4;
export const RECAP_TITLE_MAX = 60;
export const RECAP_DAILY_LIMIT = 10;
/** Length choices offered in the apps ("up to"); null is automatic. */
export const RECAP_LENGTHS = [15, 30, 60] as const;
/**
 * Live audio rooms in communities. Audio runs as a WebRTC mesh today (every
 * speaker sends to everyone in the room), which is what caps a room's size.
 */
export const ROOM_MAX_SPEAKERS = 6;
export const ROOM_MAX_LISTENERS = 50;
export const ROOM_TITLE_MAX = 120;
/** Live reactions: names from the design-system icon set, never emoji. */
export const ROOM_REACTIONS = ['heart', 'star', 'sparkle', 'check', 'music'] as const;
export type RoomReaction = (typeof ROOM_REACTIONS)[number];
export type RoomStatus = 'scheduled' | 'live' | 'ended' | 'cancelled';
