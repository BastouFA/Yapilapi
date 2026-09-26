import type { CommunityRole, PostKind, ProfileMode, Visibility } from './constants.ts';

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  mode: ProfileMode;
}

export interface Me extends PublicUser {
  email: string;
  emailVerified: boolean;
  role: 'user' | 'moderator' | 'admin';
  onboarded: boolean;
  locale: string;
  /** ISO 3166-1 alpha-2, set by the person or from a trusted CDN header. */
  country: string | null;
}

export interface Profile extends PublicUser {
  bio: string;
  coverUrl: string | null;
  links: { label: string; url: string }[];
  isPrivate: boolean;
  interests: string[];
  counts: { followers: number; following: number; friends: number; posts: number };
  relationship: {
    isSelf: boolean;
    following: boolean;
    followedBy: boolean;
    friends: boolean;
    friendRequest: 'none' | 'sent' | 'received';
    blocked: boolean;
    muted: boolean;
  };
}

export interface MediaItem {
  id: string;
  kind: 'image' | 'video' | 'audio';
  url: string;
  altText: string | null;
  width: number | null;
  height: number | null;
  /** Processed sizes (thumb/medium/large webp for images; mp4 for video). Empty until processing finishes. */
  variants?: Record<string, string>;
  posterUrl?: string | null;
  /** Adaptive HLS stream for videos. */
  hlsUrl?: string | null;
  /** Tiny blurred preview (data URI) shown while loading. */
  placeholder?: string | null;
  /** WebVTT subtitle tracks for videos. */
  captions?: CaptionTrackRef[];
}

export interface CaptionTrackRef {
  /** BCP 47 language code, e.g. "en" or "pt-BR". */
  lang: string;
  label: string;
  url: string;
}

export interface Post {
  id: string;
  kind: PostKind;
  /** 'reel' posts are short vertical videos shown in the Reels feed. */
  format: 'post' | 'reel';
  body: string;
  visibility: Visibility;
  author: PublicUser;
  media: MediaItem[];
  linkUrl: string | null;
  poll: { options: { id: string; label: string; votes: number }[]; myVote: string | null } | null;
  topics: string[];
  community: { id: string; slug: string; name: string } | null;
  event: { id: string; title: string; startsAt: string } | null;
  product: { id: string; title: string; priceCents: number; currency: string } | null;
  /** Views count each person once and never the author; recorded for reels. */
  counts: { likes: number; comments: number; reposts: number; views: number };
  /** Pinned to the top of its author's profile (only set in profile listings). */
  pinned?: boolean;
  viewer: { liked: boolean; saved: boolean; reposted: boolean };
  aiAssisted: boolean;
  /** Set on Real posts: captured in-app moments before posting, unedited. */
  real?: { capturedAt: string; dual: boolean; locationText: string | null } | null;
  createdAt: string;
  /** Why this post is in the viewer's feed (recommendation explanation). */
  reason?: string;
  /** Only on the author's own posts: countries where regional rules withhold it. */
  withheldIn?: string[];
}

export interface Comment {
  id: string;
  postId: string;
  parentId: string | null;
  body: string;
  author: PublicUser;
  createdAt: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface Conversation {
  id: string;
  kind: 'direct' | 'group' | 'community';
  title: string | null;
  members: PublicUser[];
  lastMessage: Message | null;
  unreadCount: number;
  updatedAt: string;
}

export interface Message {
  id: string;
  conversationId: string;
  sender: PublicUser;
  body: string;
  replyToId: string | null;
  attachments: { url: string; kind: string; name?: string }[];
  createdAt: string;
  clientId?: string | null;
}

export interface Community {
  id: string;
  slug: string;
  name: string;
  description: string;
  visibility: 'public' | 'private';
  memberCount: number;
  topics: string[];
  rules: string[];
  myRole: CommunityRole | null;
  createdAt: string;
}

export interface EventItem {
  id: string;
  title: string;
  description: string;
  host: PublicUser;
  startsAt: string;
  endsAt: string | null;
  timezone: string;
  locationText: string | null;
  place: { id: string; name: string } | null;
  community: { id: string; slug: string; name: string } | null;
  capacity: number | null;
  visibility: string;
  online: boolean;
  counts: { going: number; interested: number };
  myRsvp: 'going' | 'interested' | 'not_going' | null;
}

export interface NotificationItem {
  id: string;
  category: string;
  type: string;
  actor: PublicUser | null;
  /** Whether you follow the actor (for "Follow back"). */
  followsActor?: boolean;
  entityType: string | null;
  entityId: string | null;
  data: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown; requestId?: string };
}
