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

export const POST_KINDS = ['text', 'photo', 'video', 'carousel', 'audio', 'poll', 'link'] as const;
export type PostKind = (typeof POST_KINDS)[number];

export const PROFILE_MODES = ['personal', 'creator', 'professional', 'business'] as const;
export type ProfileMode = (typeof PROFILE_MODES)[number];

export const FEED_MODES = ['for_you', 'following', 'friends', 'communities', 'local'] as const;
export type FeedMode = (typeof FEED_MODES)[number];

export const CIRCLE_KINDS = ['family', 'close_friends', 'work', 'business', 'travel', 'custom'] as const;

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

export const REPORT_REASONS = ['spam', 'harassment', 'hate', 'violence', 'nudity', 'self_harm', 'impersonation', 'fraud', 'minor_safety', 'other'] as const;

export const REPORT_TARGETS = ['user', 'post', 'comment', 'message', 'community', 'event', 'product'] as const;

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
