export const VISIBILITIES = ['public', 'followers', 'friends', 'circle', 'selected', 'private'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

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
